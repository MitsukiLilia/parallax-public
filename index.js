// 装配层:取 ctx、绑酒馆事件、魔杖菜单入口、每楼按钮、挂面板。逻辑都在 core/,这里只接线。
import * as gate from './core/gate.js';
import { getSettings } from './core/settings.js';
import { status, subscribe } from './core/bus.js';
import { createPanel } from './ui/panel.js';
import { ICON_MENU, ICON_FLOOR } from './ui/icons.js';

// 自报家门:排查「更新了却在跑旧码」时,控制台比对版本号即知真伪。
export const PARALLAX_VERSION = '0.1.0';
globalThis.__PARALLAX_VERSION = PARALLAX_VERSION;
console.info(`[Parallax] v${PARALLAX_VERSION} 已加载`);

const getCtx = () => globalThis.SillyTavern.getContext();
const BTN = 'parallax-mes-btn';

let panel = null;

function waitForExtensionsMenu(cb) {
    const found = document.getElementById('extensionsMenu');
    if (found) { cb(found); return; }
    const timer = setInterval(() => {
        const el = document.getElementById('extensionsMenu');
        if (el) { clearInterval(timer); cb(el); }
    }, 400);
}

// ── 每楼按钮 ──

function makeButton() {
    const b = document.createElement('div');
    b.className = `mes_button ${BTN}`;
    b.title = 'Parallax:翻译 / 切换原文';
    b.setAttribute('role', 'button');
    b.innerHTML = ICON_FLOOR;
    return b;
}

/** 往一个 .mes_buttons 里放按钮(放在编辑按钮前面,不藏进「更多」里)。 */
function putButton(container) {
    if (!container || container.querySelector(`.${BTN}`)) return;
    const b = makeButton();
    const edit = container.querySelector('.mes_edit');
    if (edit) container.insertBefore(b, edit); else container.appendChild(b);
}

/** 模板里放一份:之后酒馆新画的每一楼都自带;已经画好的楼补上。 */
function installButtons() {
    putButton(document.querySelector('#message_template .mes_buttons'));
    for (const el of document.querySelectorAll('#chat .mes .mes_buttons')) putButton(el);
}

const mesEl = (id) => document.querySelector(`#chat .mes[mesid="${id}"]`);

function updateButton(ctx, id) {
    const el = mesEl(id);
    if (!el) return;
    putButton(el.querySelector('.mes_buttons'));
    const b = el.querySelector(`.${BTN}`);
    if (!b) return;
    const st = gate.floorState(ctx, id);
    b.classList.toggle('parallax-busy', st.busy);
    b.classList.toggle('parallax-on', st.shown);
    b.title = st.busy ? 'Parallax:翻译中'
        : st.shown ? `Parallax:显示原文${st.missing ? `(缺 ${st.missing} 段)` : ''}`
            : st.has ? 'Parallax:显示译文' : 'Parallax:翻译这一楼';
}

function renderedIds() {
    return [...document.querySelectorAll('#chat .mes[mesid]')].map(el => Number(el.getAttribute('mesid'))).filter(Number.isInteger);
}

/** 重画一楼:正文按 display_text ?? mes 重画(酒馆的规则),再刷新按钮状态。 */
function redraw(ctx, id) {
    const m = ctx.chat?.[id];
    if (m && mesEl(id)) ctx.updateMessageBlock?.(id, m);
    updateButton(ctx, id);
}

// 只刷新进行态变了的楼:不遍历整本聊天
let lastBusy = new Set();
function onStatus() {
    const now = gate.busyIds();
    const ctx = getCtx();
    for (const id of new Set([...lastBusy, ...now])) updateButton(ctx, id);
    lastBusy = now;
}

function onFloorButton(e) {
    const b = e.target.closest?.(`.${BTN}`);
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    const id = Number(b.closest('.mes')?.getAttribute('mesid'));
    if (!Number.isInteger(id)) return;
    const ctx = getCtx();
    gate.toggleFloor(ctx, id);
    updateButton(ctx, id);
}

// ── 事件 ──

function bind(ctx) {
    const { eventSource, eventTypes: ev } = ctx;
    const on = (name, fn) => { if (ev[name]) eventSource.on(ev[name], fn); };
    on('GENERATION_STARTED', gate.onGenerationStarted);
    on('GENERATION_STOPPED', gate.onGenerationStopped);
    on('GENERATION_ENDED', gate.onGenerationEnded);
    on('CHARACTER_MESSAGE_RENDERED', (id, type) => { gate.onCharacterMessageRendered(id, type); updateButton(getCtx(), Number(id)); });
    on('MESSAGE_SWIPED', (id) => { gate.onMessageSwiped(id); updateButton(getCtx(), Number(id)); });
    on('MESSAGE_EDITED', gate.onMessageEdited);
    on('MESSAGE_UPDATED', (id) => { gate.onMessageUpdated(id); updateButton(getCtx(), Number(id)); });
    on('MESSAGE_DELETED', gate.onMessageDeleted);
    on('CHAT_CHANGED', () => { installButtons(); gate.onChatChanged(); refreshAllButtons(); });
    on('MORE_MESSAGES_LOADED', () => { installButtons(); gate.rebuildRendered(); refreshAllButtons(); });
}

function refreshAllButtons() {
    const ctx = getCtx();
    for (const id of renderedIds()) updateButton(ctx, id);
}

function main() {
    gate.configure({ getCtx, redraw, renderedIds });
    panel = createPanel({ getCtx, onChanged: refreshAllButtons });
    const ctx = getCtx();
    getSettings(ctx);
    bind(ctx);
    subscribe(onStatus);
    document.addEventListener('click', onFloorButton, true);
    installButtons();

    waitForExtensionsMenu((menu) => {
        if (document.getElementById('parallax-menu-item')) return;
        const item = document.createElement('a');
        item.id = 'parallax-menu-item';
        item.className = 'list-group-item';
        item.href = '#';
        item.title = 'Parallax';
        item.innerHTML = `${ICON_MENU}<span>Parallax</span>`;
        item.addEventListener('click', (e) => { e.preventDefault(); panel.toggle(); });
        menu.appendChild(item);
    });
    // 扩展在聊天已打开之后才加载:CHAT_CHANGED 早已过去,补一次重建
    gate.rebuildRendered();
    refreshAllButtons();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main);
else main();

/** 测试台入口:不属于对外 API。 */
export const api = {
    get panel() { return panel; },
    gate, status,
};
