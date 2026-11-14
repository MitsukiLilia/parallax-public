// 触发门闸与任务队列。
// 门闸:只有「正常生成、没被停、AI 楼、有正文」的渲染事件才自动翻;每次没翻都留一句原因给面板。
// 队列:同一时间只跑一个任务;写回前核对聊天、楼层、swipe、原文指纹,对不上就只存仍然对得上的段落或整个丢弃。

import { getSettings, presetTags, currentCharacter } from './settings.js';
import { callLLM, llmOptsFrom } from './llm.js';
import { mergeGlossary, translateUnits } from './translate.js';
import { segment } from './segment.js';
import * as store from './store.js';
import { status, emitChange, pushNotice } from './bus.js';

export const config = { saveDelay: 60 };

const env = {
    getCtx: () => globalThis.SillyTavern.getContext(),
    redraw: null,          // (ctx, mesId) => boolean:重画一楼(updateMessageBlock + 按钮状态),返回是否真的动了页面
    afterNotify: null,     // (mesId) => void:通知发完、display_text 放回之后(刷新按钮用)
    renderedIds: null,     // () => number[]:当前已渲染到页面上的楼号
    call: null,            // 测试用:替换模型调用 (ctx, system, user, settings) => Promise<string>
};
export function configure(opts) { Object.assign(env, opts); }

// 最近一次真实生成(dryRun 的不算:酒馆算 token 时也会发 dryRun 的开始事件,不能让它冲掉状态)
const gen = { type: null, stopped: false };
let selfDepth = 0;   // >0 = 我们自己的翻译请求在飞
let epoch = 0;       // 切聊天、清除译文时 +1,在途任务的写回随之作废
const queue = [];
let running = null;
let idleWaiters = [];
const reasons = new Map(); // mesId → 最近一次没自动翻的原因(只存内存,切聊天清空)
let saveTimer = null;

const ctxNow = () => env.getCtx();
export const chatIdOf = (ctx) => String(ctx.getCurrentChatId?.() ?? ctx.chatId ?? '');
const isAiFloor = (m) => !!m && !m.is_user && !m.is_system;
const onlyEllipsis = (mes) => {
    const t = String(mes ?? '').replace(/\s+/g, '');
    return !t || /^(?:\.|…|。|・|‥)+$/.test(t);
};

/** 当前选用的标签;已有译文的楼沿用翻译当时的那组,免得换了勾选之后旧段落对不上。 */
function tagsForFloor(ctx, m) {
    return store.hasTranslation(m) ? store.tagsFor(m, presetTags(ctx)) : presetTags(ctx);
}

export function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; try { ctxNow().saveChat?.(); } catch (err) { console.warn('[Parallax] 保存失败', err); } }, config.saveDelay);
}

// 正在补发「这一楼刚被重画」通知的楼:mesId → Promise。期间 display_text 被临时拿开,见 notifyRedrawn。
const notifying = new Map();
const renotify = new Set();

function redraw(ctx, mesId) {
    let drawn = false;
    try { drawn = !!env.redraw?.(ctx, mesId); } catch (err) { console.warn('[Parallax] 重画失败', err); }
    if (drawn) notifyRedrawn(ctx, mesId);
}

/**
 * 重画之后通知别的扩展「这一楼的正文刚被换过」(MESSAGE_UPDATED,酒馆在用户编辑完一楼之后发的也是它)。
 * updateMessageBlock 会把正文区整个换掉,靠渲染事件在正文里生成界面的扩展(把代码块变成面板的那类)不知道要重做,
 * 面板就会退回成一大段源码。
 *
 * 通知期间先把 display_text 从消息上拿开,发完再按记录放回:
 * 酒馆自带的翻译扩展在这个事件上见到 display_text 就当成「自己的旧译文过期了」而删掉并用原文重画。
 * 页面上已经画好的译文不受影响(别的扩展只扫现成的页面内容),拿开的只是数据上的这个字段。
 * 这段时间里本模块一律把这楼当作「译文在显示」(见 isShown),自己的 MESSAGE_UPDATED 监听跳过它。
 */
function notifyRedrawn(ctx, mesId) {
    const ev = (ctx.eventTypes ?? ctx.event_types)?.MESSAGE_UPDATED;
    const m = ctx.chat?.[mesId];
    if (!ev || !ctx.eventSource?.emit || !m) return;
    if (notifying.has(mesId)) { renotify.add(mesId); return; } // 通知还没发完又重画了一次:发完再补一发
    const had = m.extra?.display_text !== undefined;
    if (had) delete m.extra.display_text;
    const myEpoch = epoch;
    const p = Promise.resolve()
        .then(() => ctx.eventSource.emit(ev, mesId))
        .catch(err => console.warn('[Parallax] 重画通知失败', err))
        .finally(() => {
            notifying.delete(mesId);
            // 聊天没换、还是那条消息,才按记录放回(不重画、不再通知)
            const now = ctxNow();
            if (myEpoch === epoch && now.chat?.[mesId] === m && store.getRecord(m)) {
                store.renderDisplay(m, presetTags(now));
                scheduleSave();
            }
            try { env.afterNotify?.(mesId); } catch { /* 按钮刷新失败不要紧 */ }
            if (renotify.delete(mesId) && myEpoch === epoch && now.chat?.[mesId] === m) notifyRedrawn(now, mesId);
            if (!notifying.size) settle();
        });
    notifying.set(mesId, p);
}

/** 译文是否在显示:通知期间 display_text 被临时拿开,那段时间按记录算。 */
function isShown(m, mesId) {
    const rec = store.getRecord(m);
    if (!rec || rec.off) return false;
    return m.extra?.display_text !== undefined || notifying.has(mesId);
}

function note(mesId, msg) {
    reasons.set(mesId, msg);
    status.skip = { ts: Date.now(), mesId, msg };
    emitChange();
}
export const reasonFor = (mesId) => reasons.get(Number(mesId)) || '';

// 自己的模型调用都从这里过,只用来计数。三条调用路径(独立 API / 连接配置 / generateRaw)都不发
// GENERATION_STARTED,所以翻译途中开始的生成一定是用户发起的,照常自动翻译、排在当前任务后面。
async function selfCall(fn) {
    selfDepth++;
    try { return await fn(); } finally { selfDepth--; }
}
export const isSelfCalling = () => selfDepth > 0;

/** 为什么不自动翻;返回 null = 可以翻。 */
export function autoBlockReason(ctx, mesId, type) {
    const s = getSettings(ctx);
    if (!s.enabled) return '总开关已关';
    if (!s.auto) return '自动翻译已关';
    const m = ctx.chat?.[mesId];
    if (!m) return '楼层不存在';
    if (m.is_user) return '用户楼不自动翻译';
    if (m.is_system) return '系统楼不自动翻译';
    if (type === 'first_message') return '开场白只手动翻译';
    if (type === 'quiet' || gen.type === 'quiet') return '后台生成(quiet)不自动翻译';
    if (gen.stopped) return '这次生成被手动停止了';
    if (onlyEllipsis(m.mes)) return '正文为空或只有省略号';
    if (segment(m.mes, tagsForFloor(ctx, m)).mode === 'none') return '这楼没找到勾选的标签';
    return null;
}

// ── 重建显示(不调模型) ──

/**
 * 按记录重建一楼的显示。原文变过的先核对(清旧条目、重算缺段)。
 * force:就算 display_text 没变也重画(酒馆刚用原文画过这一楼的情况)。
 */
export function refreshFloor(ctx, mesId, { force = false } = {}) {
    const m = ctx.chat?.[mesId];
    if (!m || !store.getRecord(m)) return false;
    const reconciled = store.reconcile(m, presetTags(ctx));
    const { changed, shown } = store.renderDisplay(m, presetTags(ctx));
    if (changed || (force && shown) || reconciled) redraw(ctx, mesId);
    if (changed || reconciled) scheduleSave();
    return changed;
}

// ── 队列 ──

const taskKey = (chatId, mesId, m) => `${chatId}|${mesId}|${m.swipe_id ?? 0}|${store.srcFingerprint(m.mes)}`;

/** 入队一楼。mode: 'auto' | 'manual' | 'fill'。同键任务不重复入队。返回是否入队。 */
export function enqueue(ctx, mesId, mode = 'manual') {
    const m = ctx.chat?.[mesId];
    if (!m) return false;
    const chatId = chatIdOf(ctx);
    const key = taskKey(chatId, mesId, m);
    if (running?.key === key || queue.some(t => t.key === key)) return false;
    queue.push({ key, chatId, mesId, swipeId: m.swipe_id ?? 0, src: store.srcFingerprint(m.mes), mode, epoch });
    status.queued = queue.length;
    emitChange();
    pump();
    return true;
}

function pump() {
    if (running) return;
    const next = queue.shift();
    status.queued = queue.length;
    if (!next) { settle(); return; }
    running = next;
    runTask(next)
        .catch(err => { console.warn('[Parallax] 任务异常', err); status.busy = null; status.last = { ts: Date.now(), mesId: next.mesId, kind: 'error', missing: 0, msg: String(err?.message || err) }; })
        .finally(() => { running = null; emitChange(); pump(); });
}

/** 队列跑空、通知也都发完了,才放行等待的人。 */
function settle() {
    if (running || queue.length || notifying.size) return;
    const w = idleWaiters; idleWaiters = [];
    for (const fn of w) fn();
}

/** 等队列跑空、重画通知发完(测试与面板用)。 */
export function whenIdle() {
    if (!running && !queue.length && !notifying.size) return Promise.resolve();
    return new Promise(r => idleWaiters.push(r));
}
export const currentTask = () => running;

function defaultCall(ctx, system, user, s) {
    return callLLM(ctx, system, user, llmOptsFrom(s));
}

async function runTask(task) {
    if (task.epoch !== epoch) return;
    const ctx = ctxNow();
    const s = getSettings(ctx);
    if (chatIdOf(ctx) !== task.chatId) return;
    const m = ctx.chat?.[task.mesId];
    // 排队期间楼被改了:这份任务已经过期,新的事件会按新原文另行入队
    if (!m || store.srcFingerprint(m.mes) !== task.src || (m.swipe_id ?? 0) !== task.swipeId) return;
    const tags = tagsForFloor(ctx, m);
    const seg = segment(m.mes, tags);
    if (seg.mode === 'none') {
        note(task.mesId, '这楼没找到勾选的标签');
        status.last = { ts: Date.now(), mesId: task.mesId, kind: 'error', missing: 0, msg: '这楼没找到勾选的标签' };
        return;
    }
    const units = store.missingUnits(m, tags);
    if (!units.length) {
        if (!store.getRecord(m) && !seg.units.length) {
            status.last = { ts: Date.now(), mesId: task.mesId, kind: 'ok', missing: 0, msg: '这楼没有需要翻译的文字' };
            return;
        }
        store.writeResults(m, tags, null, { keepOff: task.mode === 'fill' });
        store.renderDisplay(m, tags);
        redraw(ctx, task.mesId);
        scheduleSave();
        status.last = { ts: Date.now(), mesId: task.mesId, kind: 'ok', missing: 0, msg: '' };
        return;
    }
    const ch = currentCharacter(ctx);
    const glossary = mergeGlossary(s.glossary.common, ch ? s.glossary.chars[ch.key] : '');
    status.busy = { mesId: task.mesId, batch: 0, batches: 0, retry: false };
    emitChange(); // 按钮的进行态由订阅 bus 的一方更新,不重画正文
    const call = (system, user) => selfCall(() => (env.call || defaultCall)(ctx, system, user, s));
    const res = await translateUnits(units, {
        call, prompt: s.prompt, glossary, batchChars: s.batchChars,
        onProgress: (p) => { status.busy = { mesId: task.mesId, batch: p.batch, batches: p.batches, retry: p.retry }; emitChange(); },
    });
    status.busy = null;

    // ── 写回前核对 ──
    const ctx2 = ctxNow();
    if (task.epoch !== epoch || chatIdOf(ctx2) !== task.chatId) {
        status.last = { ts: Date.now(), mesId: task.mesId, kind: 'discarded', missing: 0, msg: '聊天已切换,本次译文已丢弃' };
        return;
    }
    const m2 = ctx2.chat?.[task.mesId];
    if (!m2) {
        status.last = { ts: Date.now(), mesId: task.mesId, kind: 'discarded', missing: 0, msg: '楼层已不在,本次译文已丢弃' };
        return;
    }
    const intact = store.srcFingerprint(m2.mes) === task.src && (m2.swipe_id ?? 0) === task.swipeId;
    const tags2 = intact ? tags : tagsForFloor(ctx2, m2);
    if (!intact) {
        // 原文变了:按段落指纹存本来就安全,只存仍然对得上的段落
        const live = new Set(segment(m2.mes, tags2).units.map(u => u.fp));
        if (![...res.done.keys()].some(fp => live.has(fp))) {
            status.last = { ts: Date.now(), mesId: task.mesId, kind: 'discarded', missing: 0, msg: '翻译期间这楼的原文变了,译文没有可用的段落' };
            return;
        }
    }
    const rec = store.writeResults(m2, tags2, res.done, { keepOff: task.mode === 'fill' });
    store.renderDisplay(m2, tags2);
    redraw(ctx2, task.mesId);
    scheduleSave();
    const kind = res.error ? 'error' : (rec.missing ? 'partial' : 'ok');
    status.last = { ts: Date.now(), mesId: task.mesId, kind, missing: rec.missing, msg: res.error || '', requests: res.requests };
    if (res.error) pushNotice(`第 ${task.mesId + 1} 楼翻译失败:${res.error}`);
}

// ── 手动操作 ──

export function latestAiFloor(ctx) {
    const chat = ctx.chat || [];
    for (let i = chat.length - 1; i >= 0; i--) if (isAiFloor(chat[i])) return i;
    return -1;
}

/** 翻译一楼(只翻没有译文的段落;已有的不重花钱)。 */
export function translateFloor(ctx, mesId) {
    const s = getSettings(ctx);
    if (!s.enabled) { pushNotice('Parallax 已关闭'); return false; }
    const m = ctx.chat?.[mesId];
    if (!m) return false;
    if (store.getRecord(m)?.off) { store.setOff(m, false, presetTags(ctx)); redraw(ctx, mesId); scheduleSave(); }
    return enqueue(ctx, mesId, 'manual');
}

/** 每楼按钮:译文在显示 → 看原文;有译文在看原文 → 切回译文;没有译文 → 翻译。 */
export function toggleFloor(ctx, mesId) {
    const m = ctx.chat?.[mesId];
    if (!m) return 'none';
    if (store.hasTranslation(m)) {
        store.reconcile(m, presetTags(ctx));
        const rec = store.getRecord(m);
        const showing = isShown(m, mesId);
        if (showing) { store.setOff(m, true, presetTags(ctx)); redraw(ctx, mesId); scheduleSave(); return 'original'; }
        if (store.hasTranslation(m)) { store.setOff(m, false, presetTags(ctx)); redraw(ctx, mesId); scheduleSave(); return 'translated'; }
    }
    return translateFloor(ctx, mesId) ? 'translating' : 'none';
}

/** 一楼当前的显示状态,给按钮和面板用。 */
export function floorState(ctx, mesId) {
    const m = ctx.chat?.[mesId];
    if (!m) return { busy: false, has: false, shown: false, missing: 0 };
    const rec = store.getRecord(m);
    const busy = (running && running.mesId === mesId && running.chatId === chatIdOf(ctx)) || queue.some(t => t.mesId === mesId);
    return {
        busy: !!busy,
        has: store.hasTranslation(m),
        shown: isShown(m, mesId),
        missing: rec?.src === store.srcFingerprint(m.mes) ? rec.missing : (rec ? store.missingUnits(m, store.tagsFor(m, presetTags(ctx))).length : 0),
    };
}

/** 清除本聊天全部译文:作废在途任务、清空队列、删记录、重画。 */
export function clearChatTranslations(ctx) {
    epoch++;
    queue.length = 0;
    status.queued = 0;
    const touched = store.clearChat(ctx.chat);
    for (const i of touched) redraw(ctx, i);
    scheduleSave();
    emitChange();
    return touched.length;
}

// ── 事件 ──

export function onGenerationStarted(type, _params, dryRun) {
    if (dryRun) return;
    gen.type = type ?? null;
    gen.stopped = false;
}
export function onGenerationStopped() { gen.stopped = true; }
export function onGenerationEnded() { /* 状态保留到下一次开始:渲染事件可能在结束事件之后才到 */ }

export function onCharacterMessageRendered(mesId, type) {
    const ctx = ctxNow();
    const id = Number(mesId);
    if (!Number.isInteger(id) || !ctx.chat?.[id]) return;
    refreshFloor(ctx, id); // 新 swipe 继承的旧记录、续写后的原文变化,先按指纹核对
    const why = autoBlockReason(ctx, id, type);
    if (why) { note(id, why); return; }
    const m = ctx.chat[id];
    if (!store.missingUnits(m, tagsForFloor(ctx, m)).length && store.hasTranslation(m)) return;
    reasons.delete(id);
    enqueue(ctx, id, 'auto');
}

/** 切 swipe:有对得上的译文就直接重建;正在生成的新 swipe 什么都不做,等渲染事件。 */
export function onMessageSwiped(mesId) {
    const ctx = ctxNow();
    const id = Number(mesId);
    const m = ctx.chat?.[id];
    if (!m) return;
    if (Array.isArray(m.swipes) && Number(m.swipe_id) >= m.swipes.length) return;
    refreshFloor(ctx, id, { force: true });
}

function maybeFill(ctx, id) {
    const s = getSettings(ctx);
    const m = ctx.chat?.[id];
    if (!s.enabled || !s.auto || !isAiFloor(m) || !store.hasTranslation(m)) return;
    if (store.missingUnits(m, tagsForFloor(ctx, m)).length) enqueue(ctx, id, 'fill');
}

export function onMessageEdited(mesId) {
    const ctx = ctxNow();
    const id = Number(mesId);
    if (!ctx.chat?.[id]) return;
    refreshFloor(ctx, id);
    maybeFill(ctx, id);
}

/** 编辑完成后酒馆会先用原文画一次再发 UPDATED,所以这里有译文就强制重画。 */
export function onMessageUpdated(mesId) {
    const ctx = ctxNow();
    const id = Number(mesId);
    if (!ctx.chat?.[id] || notifying.has(id)) return; // 自己补发的通知:不重画,不然会转圈
    refreshFloor(ctx, id, { force: true });
    maybeFill(ctx, id);
}

export function onMessageDeleted() {
    // 楼号可能整体前移:原因表作废;在途任务写回前会按原文指纹核对,不在这里处理
    reasons.clear();
    emitChange();
}

export function onChatChanged() {
    epoch++;
    queue.length = 0;
    status.queued = 0;
    status.skip = null;
    reasons.clear();
    gen.type = null; gen.stopped = false;
    rebuildRendered();
    emitChange();
}

/** 已渲染的楼里,有译文却没有 display_text 的(被别处清掉了)按记录重建。只看已渲染的楼:长聊天打开时不整本遍历。 */
export function rebuildRendered() {
    const ctx = ctxNow();
    const ids = env.renderedIds?.() ?? [];
    let n = 0;
    for (const id of ids) {
        const m = ctx.chat?.[id];
        const rec = m && store.getRecord(m);
        if (!rec || rec.off || m.extra?.display_text !== undefined || notifying.has(id)) continue;
        if (refreshFloor(ctx, id)) n++;
    }
    return n;
}

/** 正在跑或排队中的楼号(按钮进行态用)。 */
export function busyIds() {
    const ids = new Set(queue.map(t => t.mesId));
    if (running) ids.add(running.mesId);
    return ids;
}

/** 测试台用:当前门闸状态快照。 */
export const debugState = () => ({ gen: { ...gen }, selfDepth, epoch, queued: queue.length, running: !!running });
