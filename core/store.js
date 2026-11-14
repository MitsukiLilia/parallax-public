// 每楼译文存取与指纹。记录在 message.extra.parallax:
//   { v: 1, src, segs: { <段落指纹>: <译文> }, missing, at, off, tags }
// 译文按段落指纹存,不按序号:改了一段只有那一段要重翻;新 swipe 继承来的旧记录也只会命中「文字完全相同」的段落。
// 显示全文随时可以从 mes + segs 重新装回,不花钱。

import { assemble, hash, segment } from './segment.js';

export const RECORD_VERSION = 1;

export const srcFingerprint = (mes) => hash(String(mes ?? ''));

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** 取记录;没有或格式不对返回 null。 */
export function getRecord(message) {
    const r = message?.extra?.parallax;
    return isObj(r) && r.v === RECORD_VERSION && isObj(r.segs) ? r : null;
}

/** 记录是否就是这份原文的(整楼指纹一致)。 */
export const recordMatches = (message) => getRecord(message)?.src === srcFingerprint(message?.mes);

/** 装回用哪组标签:记录里留着翻译当时的那组(换了预设也能原样重建),没有才用当前的。 */
export const tagsFor = (message, fallback) => {
    const r = getRecord(message);
    return Array.isArray(r?.tags) ? r.tags : (fallback || []);
};

/** 当前原文里还没有译文的段落(按指纹去重)。 */
export function missingUnits(message, tags) {
    const segs = getRecord(message)?.segs || {};
    const seen = new Set();
    const out = [];
    for (const u of segment(message?.mes, tags).units) {
        if (seen.has(u.fp) || typeof segs[u.fp] === 'string') continue;
        seen.add(u.fp);
        out.push(u);
    }
    return out;
}

function liveFps(message, tags) {
    return new Set(segment(message?.mes, tags).units.map(u => u.fp));
}

/**
 * 写入:把新译文并进记录,顺手清掉对不上当前原文任何段落的旧条目,重算缺段数。
 * results: Map<fp, text> 或普通对象。只收当前原文里确实存在的段落。
 * 返回写入后的记录。
 */
export function writeResults(message, tags, results, { keepOff = false } = {}) {
    if (!isObj(message.extra)) message.extra = {};
    const old = getRecord(message);
    const live = liveFps(message, tags);
    const segs = {};
    if (old) for (const [fp, t] of Object.entries(old.segs)) if (live.has(fp) && typeof t === 'string') segs[fp] = t;
    const entries = results instanceof Map ? [...results] : Object.entries(results || {});
    for (const [fp, t] of entries) if (live.has(fp) && typeof t === 'string' && t) segs[fp] = t;
    const missing = [...live].filter(fp => !(fp in segs)).length;
    const rec = {
        v: RECORD_VERSION,
        src: srcFingerprint(message.mes),
        segs,
        missing,
        at: Date.now(),
        off: keepOff ? !!old?.off : false,
        tags: [...(tags || [])],
    };
    message.extra.parallax = rec;
    return rec;
}

/**
 * 原文变了(编辑、新 swipe 继承了旧记录)时的核对:不调模型,只清旧条目、重算缺段数。
 * 记录本来就对得上时什么都不改,返回 false。
 */
export function reconcile(message, fallbackTags) {
    const old = getRecord(message);
    if (!old || old.src === srcFingerprint(message.mes)) return false;
    writeResults(message, tagsFor(message, fallbackTags), null, { keepOff: true });
    return true;
}

/**
 * 按记录重建显示:写或删 message.extra.display_text。
 * 用户切到看原文(off)、一段都没翻成、装回结果与原文相同时,不写 display_text。
 * 返回 { changed, shown }:changed = display_text 有没有变,shown = 现在是否在显示译文。
 */
export function renderDisplay(message, fallbackTags) {
    const rec = getRecord(message);
    if (!rec) return { changed: false, shown: false };
    if (!isObj(message.extra)) message.extra = {};
    const before = message.extra.display_text;
    let next;
    if (!rec.off && Object.keys(rec.segs).length) {
        const text = assemble(message.mes, tagsFor(message, fallbackTags), rec.segs);
        if (text !== String(message.mes ?? '')) next = text;
    }
    if (next === undefined) delete message.extra.display_text;
    else message.extra.display_text = next;
    return { changed: before !== next, shown: next !== undefined };
}

/** 有可显示的译文吗(不管当前是否在看原文)。 */
export function hasTranslation(message) {
    const rec = getRecord(message);
    return !!rec && Object.keys(rec.segs).length > 0;
}

/** 切换原文 / 译文显示,不调模型。返回切换后是否在显示译文。 */
export function setOff(message, off, fallbackTags) {
    const rec = getRecord(message);
    if (!rec) return false;
    rec.off = !!off;
    return renderDisplay(message, fallbackTags).shown;
}

/**
 * 清除整个聊天的译文:删 extra.parallax 和 extra.display_text。返回被清的楼号。
 * 各 swipe 存档(swipe_info[].extra)里的也一并删,否则切回旧 swipe 时酒馆会把它们装回来。
 */
export function clearChat(chat) {
    const touched = [];
    const strip = (extra) => {
        if (!isObj(extra)) return false;
        const had = extra.parallax !== undefined || extra.display_text !== undefined;
        delete extra.parallax;
        delete extra.display_text;
        return had;
    };
    (chat || []).forEach((m, i) => {
        let had = strip(m?.extra);
        if (Array.isArray(m?.swipe_info)) for (const info of m.swipe_info) had = strip(info?.extra) || had;
        if (had) touched.push(i);
    });
    return touched;
}
