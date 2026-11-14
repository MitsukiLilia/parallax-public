// 面板:Shadow DOM 隔离,手机优先(宽 ≤ 480 全屏,桌面居中浮窗)。三页:首页 / 译名表 / 设置。
// 面板关着时不渲染、不订阅;状态变化通过 bus 订阅,开着才重绘(rAF 合并;正在输入时不重绘,免得打断)。

import { getSettings, saveSettings, currentPresetName, presetTags, currentCharacter } from '../core/settings.js';
import { status, subscribe } from '../core/bus.js';
import { fetchCustomApiModels } from '../core/llm.js';
import { DEFAULT_PROMPT, effectivePrompt } from '../core/prompts.js';
import { scanPairedTags } from '../core/segment.js';
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
    const ui = { scan: null, models: { loading: false, list: [], error: '' }, confirmClear: false, toast: '' };
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
        ${tagsBlock(c, s)}`;
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
        return `<section class="px-card">
            <h3 class="px-h3">模型连接</h3>
            <label class="px-field"><span class="px-label">连接配置</span>
                <select class="px-input" data-set="profileId">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(s.profileId) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
                <span class="px-hint">指定连接配置后,翻译不占用主连接。</span></label>
            <div class="px-row"><span class="px-label">独立 API</span>${switchHtml('set-capi', ca.enabled, '独立 API')}</div>
            <p class="px-hint">OpenAI 兼容端点;开启后优先于上面的连接配置。</p>
            <label class="px-field"><span class="px-label">地址</span><input class="px-input" type="text" data-capi="baseUrl" value="${esc(ca.baseUrl)}" placeholder="https://…/v1" spellcheck="false"></label>
            <label class="px-field"><span class="px-label">密钥</span><input class="px-input" type="password" data-capi="apiKey" value="${esc(ca.apiKey)}" autocomplete="off"></label>
            <label class="px-field"><span class="px-label">模型</span><input class="px-input" type="text" data-capi="model" value="${esc(ca.model)}" placeholder="模型 id" spellcheck="false"></label>
            <div class="px-btn-row">${btn('fetch-models', I.ICON_REFRESH, models.loading ? '拉取中……' : '拉取模型列表', { disabled: models.loading })}</div>
            ${models.error ? `<p class="px-hint px-err">${esc(models.error)}</p>` : ''}
            ${models.list.length ? `<div class="px-models">${models.list.map(m => `<button class="px-model${m === ca.model ? ' on' : ''}" data-action="pick-model" data-model="${esc(m)}">${esc(m)}</button>`).join('')}</div>` : ''}
        </section>
        <section class="px-card">
            <h3 class="px-h3">分批</h3>
            <label class="px-field"><span class="px-label">每批原文字符数上限</span>
                <input class="px-input" type="number" inputmode="numeric" min="200" max="100000" step="100" data-set="batchChars" value="${esc(s.batchChars)}">
                <span class="px-hint">超过就在段落边界切成几批,依次发送。</span></label>
        </section>
        <section class="px-card">
            <h3 class="px-h3">译法提示词</h3>
            <textarea class="px-input px-area px-area-tall" data-set="prompt" rows="14" spellcheck="false">${esc(effectivePrompt(s.prompt))}</textarea>
            <p class="px-hint">${s.prompt ? '正在使用自定义译法。' : '正在使用默认译法。'}格式约定、译名表和占位符说明由插件自动附在后面,不用写进这里。</p>
            <div class="px-btn-row">${btn('reset-prompt', I.ICON_UNDO, '恢复默认', { disabled: !s.prompt })}</div>
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
            case 'tab': page = el.dataset.page; ui.confirmClear = false; render(); return;
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
            case 'pick-model': s.customApi.model = el.dataset.model; saveSettings(c); render(); return;
            case 'reset-prompt': s.prompt = ''; saveSettings(c); toast('已恢复默认译法'); return;
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
        if (t.dataset.capi) { s.customApi[t.dataset.capi] = t.value.trim(); saveSettings(c); return; }
        const key = t.dataset.set;
        if (key === 'batchChars') {
            let v = Math.floor(Number(t.value));
            if (!Number.isFinite(v)) v = 6000;
            v = Math.min(100000, Math.max(200, v));
            s.batchChars = v; t.value = v;
        } else if (key === 'prompt') {
            // 与默认完全相同就存成空:默认译法以后更新时,没改过的用户自动跟上
            s.prompt = t.value.trim() === DEFAULT_PROMPT.trim() ? '' : t.value;
        } else if (key === 'profileId') {
            s.profileId = t.value;
        } else return;
        saveSettings(c);
        if (key === 'prompt') render();
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
        ui.confirmClear = false;
    }
    function toggle() { isOpen() ? close() : open(); }
    function goto(p) { page = p; if (isOpen()) render(); }

    return { open, close, toggle, isOpen, goto, refresh: scheduleRender, renderNow: render, get shadow() { return shadow; } };
}
