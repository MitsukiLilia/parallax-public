// 面板:Shadow DOM 隔离,手机优先(宽 ≤ 480 全屏,桌面居中浮窗)。三页:首页(含导出译文) / 译名表 / 设置。
// 面板关着时不渲染、不订阅;状态变化通过 bus 订阅,开着才重绘(rAF 合并;正在输入时不重绘,免得打断)。

import { getSettings, saveSettings, currentPresetName, presetTags, currentCharacter } from '../core/settings.js';
import { status, subscribe } from '../core/bus.js';
import { fetchCustomApiModels } from '../core/llm.js';
import { SOURCE_LANGS } from '../core/prompts.js';
import { scanPairedTags } from '../core/segment.js';
import { buildExport } from '../core/export.js';
import * as gate from '../core/gate.js';
import * as I from './icons.js';

const CSS_URL = new URL('./panel.css', import.meta.url).href;

export const panelStats = { renders: 0 };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TABS = [
    { id: 'home', label: '首页', icon: I.ICON_HOME },
    { id: 'glossary', label: '译名表', icon: I.ICON_BOOK },
    { id: 'settings', label: '设置', icon: I.ICON_GEAR },
];

export function createPanel({ getCtx, onChanged }) {
    let host = null, shadow = null, root = null, unsub = null, raf = 0;
    let page = 'home';
    const ui = { scan: null, models: { loading: false, list: [], error: '' }, confirmClear: false, confirmBulk: false, toast: '' };
    let glossTimer = 0;

    const ctx = () => getCtx();

    // ── 片段 ──
    const switchHtml = (action, on, label) =>
        `<button class="px-switch${on ? ' on' : ''}" role="switch" aria-checked="${on}" aria-label="${esc(label)}" data-action="${action}"><span></span></button>`;
    const btn = (action, icon, label, { disabled = false, kind = '' } = {}) =>
        `<button class="px-btn${kind ? ' px-btn-' + kind : ''}" data-action="${action}" ${disabled ? 'disabled' : ''}>${icon}<span>${esc(label)}</span></button>`;

    function statusLine() {
        if (status.busy) {
            const b = status.busy;
            const part = b.batches ? `(第 ${b.batch}/${b.batches} 批${b.retry ? ',补译' : ''})` : '';
            const more = status.queued ? `,另有 ${status.queued} 楼排队` : '';
            return { cls: 'busy', text: `正在翻译第 ${b.mesId + 1} 楼${part}${more}` };
        }
        const l = status.last;
        if (!l) return { cls: '', text: '空闲' };
        const floor = `第 ${l.mesId + 1} 楼`;
        if (l.kind === 'ok') return { cls: 'ok', text: `空闲 · 上次:${floor}完整${l.msg ? '(' + l.msg + ')' : ''}` };
        if (l.kind === 'partial') return { cls: 'warn', text: `空闲 · 上次:${floor}缺 ${l.missing} 段` };
        if (l.kind === 'discarded') return { cls: 'warn', text: `空闲 · 上次:${floor}:${l.msg}` };
        return { cls: 'err', text: `空闲 · 上次:${floor}失败:${l.msg}${l.missing ? `(缺 ${l.missing} 段)` : ''}` };
    }

    function latestLine(c, k) {
        if (k < 0) return '这个聊天里还没有 AI 楼';
        const st = gate.floorState(c, k);
        let what = '还没有译文';
        if (st.busy) what = '翻译中';
        else if (st.has && !st.shown) what = '正在看原文';
        else if (st.has && st.missing) what = `已翻译,缺 ${st.missing} 段`;
        else if (st.has) what = '已翻译';
        const why = gate.reasonFor(k);
        return `最新一楼(第 ${k + 1} 楼):${what}${why && !st.has ? ` · 没自动翻:${why}` : ''}`;
    }

    function tagsBlock(c, s) {
        const name = currentPresetName(c);
        const saved = presetTags(c, s);
        const savedSet = new Set(saved.map(t => t.toLowerCase()));
        const rows = [];
        const listed = new Set();
        const sc = ui.scan;
        if (sc && sc.preset === name) {
            for (const t of sc.tags) {
                listed.add(t.tag.toLowerCase());
                rows.push({ tag: t.tag, preview: t.preview || '(无内容)', on: savedSet.has(t.tag.toLowerCase()) });
            }
        }
        for (const t of saved) if (!listed.has(t.toLowerCase())) rows.push({ tag: t, preview: sc && sc.preset === name ? '最新一楼里没有这个标签' : '已保存的勾选', on: true });
        const scanNote = sc && sc.preset === name
            ? (sc.floor < 0 ? '没有可扫描的 AI 楼。' : (sc.tags.length ? `扫描的是第 ${sc.floor + 1} 楼。` : `第 ${sc.floor + 1} 楼里没有成对的标签。`))
            : '';
        return `<section class="px-card">
            <h3 class="px-h3">正文标签</h3>
            <div class="px-row"><span class="px-label">当前预设</span><span class="px-value">${esc(name || '(未取到预设名)')}</span></div>
            <p class="px-hint">只有勾选的标签里面的文字会送去翻译,其余内容原样不动。一个都不勾 = 整楼翻译。</p>
            <div class="px-btn-row">${btn('scan', I.ICON_SCAN, '扫描最新一楼')}</div>
            ${scanNote ? `<p class="px-hint">${esc(scanNote)}</p>` : ''}
            ${rows.length ? `<div class="px-tags">${rows.map(r => `<label class="px-tag"><input type="checkbox" data-tag="${esc(r.tag)}" ${r.on ? 'checked' : ''}><span class="px-tag-main"><span class="px-tag-name">&lt;${esc(r.tag)}&gt;</span><span class="px-tag-pre">${esc(r.preview)}</span></span></label>`).join('')}</div>` : `<p class="px-hint">当前没有勾选任何标签(整楼翻译)。</p>`}
        </section>`;
    }

    /** 导出哪些标签:本预设单独记;没记过 = 翻译勾选的全部。只保留仍在翻译勾选里的。 */
    function exportTagsOf(c, s) {
        const all = presetTags(c, s);
        const saved = s.presets[currentPresetName(c)]?.exportTags;
        if (!Array.isArray(saved)) return all;
        const keep = new Set(saved.map(t => String(t).toLowerCase()));
        return all.filter(t => keep.has(t.toLowerCase()));
    }

    function exportBlock(c, s) {
        const all = presetTags(c, s);
        const on = new Set(exportTagsOf(c, s).map(t => t.toLowerCase()));
        const hasAi = (c.chat || []).some(m => m && !m.is_user);
        const left = hasAi ? gate.untranslatedFloors(c).length : 0;
        const queued = status.queued;
        return `<section class="px-card">
            <h3 class="px-h3">导出译文</h3>
            <p class="px-hint">把这个聊天里 AI 楼的译文存成一个 txt;你自己发的楼不收,没翻译的楼用原文并标出来。导出本身不调用模型。</p>
            <div class="px-row"><span class="px-label">每楼加「第N章」小标题</span>${switchHtml('set-export-titles', s.exportTitles, '每楼加小标题')}</div>
            <p class="px-hint">预设自己会写标题的话可以关掉。</p>
            ${all.length > 1 ? `<p class="px-hint">导出哪些标签里的内容:</p><div class="px-tags">${all.map(t => `<label class="px-tag"><input type="checkbox" data-export-tag="${esc(t)}" ${on.has(t.toLowerCase()) ? 'checked' : ''}><span class="px-tag-main"><span class="px-tag-name">&lt;${esc(t)}&gt;</span></span></label>`).join('')}</div>` : ''}
            <p class="px-hint" data-role="bulk">${left ? `还有 ${left} 楼没翻完。` : (hasAi ? '所有 AI 楼都翻完了。' : '这个聊天里还没有 AI 楼。')}${queued ? `正在排队:${queued} 楼。` : ''}</p>
            <div class="px-btn-row">
                ${btn('bulk-translate', I.ICON_PLAY, ui.confirmBulk ? `再点一次:翻译这 ${left} 楼` : '翻译所有没翻的楼', { disabled: !left || !s.enabled || queued > 0 })}
                ${queued ? btn('bulk-stop', I.ICON_CLOSE, '停止排队') : ''}
                ${btn('export-txt', I.ICON_DOWNLOAD, '导出为 txt', { disabled: !hasAi || (all.length > 1 && !on.size), kind: 'primary' })}
            </div>
            <p class="px-hint">「翻译所有没翻的楼」每楼至少花一次模型调用,一楼一楼排队翻;已经翻过的段落不重翻。</p>
        </section>`;
    }

    function doExport(c, s) {
        const ch = currentCharacter(c);
        const name = ch?.name || String(c.getCurrentChatId?.() ?? '') || 'chat';
        const res = buildExport(c.chat, { fallbackTags: presetTags(c, s), exportTags: exportTagsOf(c, s), title: name, titles: s.exportTitles });
        if (!res.floors) { toast('没有可导出的内容'); return; }
        const d = new Date();
        const p2 = (n) => String(n).padStart(2, '0');
        const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
        const file = `${name.replace(/[\\/:*?"<>|\s]+/g, '_')}_译文_${stamp}.txt`;
        const url = URL.createObjectURL(new Blob([res.text], { type: 'text/plain;charset=utf-8' }));
        const a = document.createElement('a');
        a.href = url; a.download = file; a.style.display = 'none';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        toast(`已导出 ${res.floors} 楼${res.untranslated ? `,其中 ${res.untranslated} 楼没翻完` : ''}`);
        return res;
    }

    function homePage(c, s) {
        const k = gate.latestAiFloor(c);
        const st = k >= 0 ? gate.floorState(c, k) : null;
        const line = statusLine();
        const skip = status.skip;
        return `<section class="px-card">
            <div class="px-row"><span class="px-label">总开关</span>${switchHtml('set-enabled', s.enabled, '总开关')}</div>
            <div class="px-row"><span class="px-label">自动翻译</span>${switchHtml('set-auto', s.auto, '自动翻译')}</div>
            <p class="px-hint">自动翻译只在 AI 回复正常写完后触发;开场白、被手动停止的回复只手动翻。</p>
        </section>
        <section class="px-card">
            <h3 class="px-h3">状态</h3>
            <p class="px-status ${line.cls}" data-role="status">${esc(line.text)}</p>
            <p class="px-hint" data-role="latest">${esc(latestLine(c, k))}</p>
            ${skip ? `<p class="px-hint" data-role="skip">最近一次没自动翻:第 ${skip.mesId + 1} 楼,${esc(skip.msg)}</p>` : ''}
            <div class="px-btn-row">
                ${btn('translate-latest', I.ICON_PLAY, '翻译最新一楼', { disabled: k < 0 || !s.enabled || st?.busy, kind: 'primary' })}
                ${btn('fill-latest', I.ICON_PATCH, st?.missing && st.has ? `补译缺的 ${st.missing} 段` : '补译缺的段落', { disabled: !(st?.has && st.missing) || st.busy || !s.enabled })}
                ${btn('toggle-latest', I.ICON_EYE, st?.has && !st.shown ? '显示译文' : '显示原文', { disabled: !st?.has })}
            </div>
        </section>
        ${tagsBlock(c, s)}
        ${exportBlock(c, s)}`;
    }

    function glossaryPage(c, s) {
        const ch = currentCharacter(c);
        const charText = ch ? (s.glossary.chars[ch.key] || '') : '';
        const ph = '角色甲 = 译名甲\n某术语 → 某译名';
        return `<section class="px-card">
            <p class="px-hint">表里有的照表翻译,表里没有的由模型自己判断。</p>
            <p class="px-hint">每行一条「原文 = 译名」,也认 → 、=> 和全角 ＝。每次只带上本批文字里出现过的条目。</p>
        </section>
        <section class="px-card">
            <h3 class="px-h3">通用</h3>
            <textarea class="px-input px-area" data-gloss="common" rows="8" spellcheck="false" placeholder="${esc(ph)}">${esc(s.glossary.common)}</textarea>
        </section>
        <section class="px-card">
            <h3 class="px-h3">当前角色卡${ch ? `:${esc(ch.name)}` : ''}</h3>
            ${ch ? '' : '<p class="px-hint">没有打开角色(或在群聊中),这一栏不可用。</p>'}
            <textarea class="px-input px-area" data-gloss="char" rows="8" spellcheck="false" placeholder="${esc(ph)}" ${ch ? '' : 'disabled'}>${esc(charText)}</textarea>
            <p class="px-hint">同一原文两边都有时,以角色卡的为准。</p>
        </section>`;
    }

    function settingsPage(c, s) {
        const profiles = c.ConnectionManagerRequestService?.getSupportedProfiles?.() || [];
        const ca = s.customApi;
        const models = ui.models;
        const opts = [['', '跟随酒馆当前连接'], ...profiles.map(p => [p.id, p.name])];
        const modelOpts = models.list.includes(ca.model) || !ca.model ? models.list : [ca.model, ...models.list];
        return `<section class="px-card">
            <h3 class="px-h3">翻译</h3>
            <label class="px-field"><span class="px-label">原文语言</span>
                <select class="px-input" data-set="sourceLang">${SOURCE_LANGS.map(l => `<option value="${esc(l.id)}" ${l.id === s.sourceLang ? 'selected' : ''}>${esc(l.label)}</option>`).join('')}</select>
                <span class="px-hint">译成简体中文。译法是内置的,按原文语言自动选用。</span></label>
        </section>
        <section class="px-card">
            <h3 class="px-h3">模型连接</h3>
            <label class="px-field"><span class="px-label">连接配置</span>
                <select class="px-input" data-set="profileId">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(s.profileId) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
                <span class="px-hint">指定连接配置后,翻译不占用主连接。</span></label>
            <div class="px-row"><span class="px-label">独立 API</span>${switchHtml('set-capi', ca.enabled, '独立 API')}</div>
            <p class="px-hint">OpenAI 兼容端点;开启后优先于上面的连接配置。</p>
            <label class="px-field"><span class="px-label">地址</span><input class="px-input" type="text" data-capi="baseUrl" value="${esc(ca.baseUrl)}" placeholder="https://…/v1" spellcheck="false"></label>
            <label class="px-field"><span class="px-label">密钥</span><input class="px-input" type="password" data-capi="apiKey" value="${esc(ca.apiKey)}" autocomplete="off"></label>
            <label class="px-field"><span class="px-label">模型</span>${models.list.length
                ? `<select class="px-input" data-capi="model">${ca.model ? '' : '<option value="" selected>(请选择)</option>'}${modelOpts.map(m => `<option value="${esc(m)}" ${m === ca.model ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>`
                : `<input class="px-input" type="text" data-capi="model" value="${esc(ca.model)}" placeholder="模型 id,或点下面拉取列表后选" spellcheck="false">`}</label>
            <div class="px-btn-row">${btn('fetch-models', I.ICON_REFRESH, models.loading ? '拉取中……' : '拉取模型列表', { disabled: models.loading })}</div>
            ${models.error ? `<p class="px-hint px-err">${esc(models.error)}</p>` : ''}
        </section>
        <section class="px-card">
            <h3 class="px-h3">分批</h3>
            <label class="px-field"><span class="px-label">每批原文字符数上限</span>
                <input class="px-input" type="number" inputmode="numeric" min="200" max="100000" step="100" data-set="batchChars" value="${esc(s.batchChars)}">
                <span class="px-hint">一楼的原文超过这个数,就在段落边界切成几批,每批一次模型调用。给模型留的输出长度跟着预设的「最大回复长度」走,不低于 50000。</span></label>
        </section>
        <section class="px-card">
            <h3 class="px-h3">数据</h3>
            <p class="px-hint">删掉这个聊天里所有楼(包括各 swipe)的译文,消息原文不受影响。</p>
            <div class="px-btn-row">${btn('clear-chat', I.ICON_TRASH, ui.confirmClear ? '再点一次确认清除' : '清除本聊天的全部译文', { kind: 'danger', disabled: !c.chat?.length })}</div>
        </section>
        <p class="px-version">Parallax ${esc(globalThis.__PARALLAX_VERSION || '')}</p>`;
    }

    // ── 渲染 ──
    function render() {
        if (!root) return;
        panelStats.renders++;
        const c = ctx();
        const s = getSettings(c);
        let content;
        if (page === 'glossary') content = glossaryPage(c, s);
        else if (page === 'settings') content = settingsPage(c, s);
        else content = homePage(c, s);
        const main = root.querySelector('.px-main');
        const top = main.scrollTop;
        main.innerHTML = content;
        main.scrollTop = top;
        root.querySelector('.px-tabs').innerHTML = TABS.map(t => `<button class="px-tab${t.id === page ? ' active' : ''}" data-action="tab" data-page="${t.id}" aria-current="${t.id === page}">${t.icon}<span>${t.label}</span></button>`).join('');
        const toastEl = root.querySelector('.px-toast');
        toastEl.textContent = ui.toast;
        toastEl.classList.toggle('show', !!ui.toast);
    }

    function scheduleRender() {
        if (!isOpen() || raf) return;
        raf = requestAnimationFrame(() => {
            raf = 0;
            const a = shadow?.activeElement;
            if (a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type !== 'checkbox'))) return;
            render();
        });
    }

    function toast(msg) {
        ui.toast = msg; render();
        setTimeout(() => { if (ui.toast === msg) { ui.toast = ''; if (isOpen()) render(); } }, 2600);
    }

    function setTags(c, s, tags) {
        const name = currentPresetName(c);
        s.presets[name] = { ...(s.presets[name] || {}), tags };
        saveSettings(c);
    }

    // ── 动作 ──
    async function doAction(action, el) {
        const c = ctx();
        const s = getSettings(c);
        switch (action) {
            case 'close': close(); return;
            case 'tab': page = el.dataset.page; ui.confirmClear = false; ui.confirmBulk = false; render(); return;
            case 'set-enabled': s.enabled = !s.enabled; saveSettings(c); onChanged?.(); render(); return;
            case 'set-auto': s.auto = !s.auto; saveSettings(c); render(); return;
            case 'translate-latest': case 'fill-latest': {
                const k = gate.latestAiFloor(c);
                if (k < 0) return;
                if (!gate.translateFloor(c, k)) toast(s.enabled ? '这一楼已在翻译队列里' : 'Parallax 已关闭');
                render(); return;
            }
            case 'toggle-latest': {
                const k = gate.latestAiFloor(c);
                if (k >= 0) gate.toggleFloor(c, k);
                render(); return;
            }
            case 'scan': {
                const k = gate.latestAiFloor(c);
                const name = currentPresetName(c);
                const tags = k >= 0 ? scanPairedTags(c.chat[k].mes) : [];
                ui.scan = { preset: name, floor: k, tags };
                // 这个预设第一次扫描:默认勾上内容字数最多的那个
                if (!s.presets[name] && tags.length) {
                    const best = tags.reduce((a, b) => (b.chars > a.chars ? b : a));
                    setTags(c, s, [best.tag]);
                }
                render(); return;
            }
            case 'export-txt': doExport(c, s); return;
            case 'set-export-titles': s.exportTitles = !s.exportTitles; saveSettings(c); render(); return;
            case 'bulk-translate': {
                if (!ui.confirmBulk) {
                    ui.confirmBulk = true; render();
                    setTimeout(() => { if (ui.confirmBulk) { ui.confirmBulk = false; if (isOpen()) render(); } }, 4000);
                    return;
                }
                ui.confirmBulk = false;
                const n = gate.translateAllMissing(c);
                toast(n ? `已排队 ${n} 楼` : '没有需要翻译的楼');
                return;
            }
            case 'bulk-stop': { const n = gate.cancelQueued(); toast(n ? `已撤掉排队的 ${n} 楼,正在翻的那一楼会翻完` : '队列是空的'); return; }
            case 'set-capi': s.customApi.enabled = !s.customApi.enabled; saveSettings(c); render(); return;
            case 'fetch-models': {
                ui.models = { loading: true, list: ui.models.list, error: '' }; render();
                try {
                    const list = await fetchCustomApiModels(s.customApi);
                    ui.models = { loading: false, list, error: list.length ? '' : '服务商没有返回任何模型' };
                } catch (err) {
                    ui.models = { loading: false, list: [], error: err instanceof TypeError ? '连不上(可能是网络或跨域限制)' : (err?.message || String(err)) };
                }
                render(); return;
            }
            case 'clear-chat': {
                if (!ui.confirmClear) {
                    ui.confirmClear = true; render();
                    setTimeout(() => { if (ui.confirmClear) { ui.confirmClear = false; if (isOpen()) render(); } }, 4000);
                    return;
                }
                ui.confirmClear = false;
                const n = gate.clearChatTranslations(c);
                toast(n ? `已清除 ${n} 楼的译文` : '这个聊天里没有译文');
                return;
            }
        }
    }

    function storeGloss(t) {
        const c = ctx();
        const s = getSettings(c);
        if (t.dataset.gloss === 'common') s.glossary.common = t.value;
        else {
            const ch = currentCharacter(c);
            if (!ch) return;
            s.glossary.chars[ch.key] = t.value;
        }
        clearTimeout(glossTimer);
        glossTimer = setTimeout(() => saveSettings(c), 400);
    }

    function onInput(e) {
        const t = e.target;
        if (t.dataset.gloss) storeGloss(t);
    }

    function onChange(e) {
        const c = ctx();
        const s = getSettings(c);
        const t = e.target;
        if (t.dataset.gloss) { storeGloss(t); saveSettings(c); return; }
        if (t.dataset.tag) {
            const cur = presetTags(c, s);
            const k = cur.findIndex(x => x.toLowerCase() === t.dataset.tag.toLowerCase());
            if (t.checked && k < 0) cur.push(t.dataset.tag);
            if (!t.checked && k >= 0) cur.splice(k, 1);
            setTags(c, s, cur);
            render(); return;
        }
        if (t.dataset.exportTag) {
            const cur = exportTagsOf(c, s);
            const k = cur.findIndex(x => x.toLowerCase() === t.dataset.exportTag.toLowerCase());
            if (t.checked && k < 0) cur.push(t.dataset.exportTag);
            if (!t.checked && k >= 0) cur.splice(k, 1);
            const name = currentPresetName(c);
            s.presets[name] = { ...(s.presets[name] || {}), exportTags: cur };
            saveSettings(c);
            render(); return;
        }
        if (t.dataset.capi) { s.customApi[t.dataset.capi] = t.value.trim(); saveSettings(c); return; }
        const key = t.dataset.set;
        if (key === 'batchChars') {
            let v = Math.floor(Number(t.value));
            if (!Number.isFinite(v)) v = 20000;
            v = Math.min(100000, Math.max(200, v));
            s.batchChars = v; t.value = v;
        } else if (key === 'sourceLang') {
            s.sourceLang = t.value;
        } else if (key === 'profileId') {
            s.profileId = t.value;
        } else return;
        saveSettings(c);
    }

    function onClick(e) {
        const el = e.target.closest('[data-action]');
        if (el && !el.disabled) { doAction(el.dataset.action, el).catch(err => console.warn('[Parallax] 操作失败', err)); return; }
        if (e.target.classList?.contains('px-backdrop')) close();
    }

    // ── 挂载与开合 ──
    function mount() {
        host = document.createElement('div');
        host.id = 'parallax-host';
        // 视口单位,不用 inset/100%:酒馆的 html 常带 transform(主题),fixed 的包含块会退化,inset:0 会算出 0 高
        host.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;height:100dvh;z-index:2147483000;display:none;';
        document.body.appendChild(host);
        shadow = host.attachShadow({ mode: 'open' });
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = CSS_URL;
        shadow.appendChild(link);
        root = document.createElement('div');
        root.className = 'px-root';
        root.innerHTML = `<div class="px-backdrop"></div>
            <div class="px-sheet" role="dialog" aria-label="Parallax">
                <header class="px-head"><h1 class="px-title">Parallax</h1><button class="px-icon-btn" data-action="close" aria-label="关闭">${I.ICON_CLOSE}</button></header>
                <main class="px-main"></main>
                <nav class="px-tabs"></nav>
                <div class="px-toast" role="status"></div>
            </div>`;
        shadow.appendChild(root);
        root.addEventListener('click', onClick);
        root.addEventListener('change', onChange);
        root.addEventListener('input', onInput);
    }

    function isOpen() { return !!host && host.style.display !== 'none'; }
    function open(p) {
        if (!host) mount();
        if (p) page = p;
        host.style.display = 'block';
        unsub = unsub || subscribe(scheduleRender);
        render();
    }
    function close() {
        if (!host) return;
        host.style.display = 'none';
        unsub?.(); unsub = null;
        cancelAnimationFrame(raf); raf = 0;
        ui.confirmClear = false; ui.confirmBulk = false;
    }
    function toggle() { isOpen() ? close() : open(); }
    function goto(p) { page = p; if (isOpen()) render(); }

    return { open, close, toggle, isOpen, goto, refresh: scheduleRender, renderNow: render, get shadow() { return shadow; } };
}
