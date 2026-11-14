// 运行状态与订阅。界面(面板、每楼按钮)只订阅这里,不轮询、不挂 DOM 观察器。

export const status = {
    busy: null,     // null | { mesId, batch, batches, retry }
    last: null,     // null | { ts, mesId, kind: 'ok' | 'partial' | 'error' | 'discarded', missing, msg }
    skip: null,     // null | { ts, mesId, msg }:最近一次「为什么没自动翻」
    queued: 0,
};

const subs = new Set();
export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
export function emitChange() { for (const fn of subs) { try { fn(); } catch (err) { console.warn('[Parallax] 订阅回调失败', err); } } }

export function pushNotice(msg) {
    try { globalThis.toastr?.info?.(msg, 'Parallax'); } catch { /* 无 toastr 时忽略 */ }
}
