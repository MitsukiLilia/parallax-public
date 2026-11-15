// 导出译文(纯函数,不碰酒馆、不调模型):把聊天里 AI 楼的译文拼成一份纯文本,给人当小说读。
// 译文本来就按楼存在消息上,这里只是装回、取出指定标签里的内容、去掉标签。

import { assemble, findRegions, scanTagTokens } from './segment.js';
import * as store from './store.js';

const COMMENT_RE = /<!--[\s\S]*?(?:-->|$)/g;
const BREAK_TAGS = new Set(['br', 'hr']);

/** 去掉注释和标签,只留文字;<br> 换成换行,多余的空行压成一个。 */
export function stripMarkup(text) {
    const src = String(text ?? '').replace(COMMENT_RE, '');
    let out = '';
    let pos = 0;
    for (const t of scanTagTokens(src)) {
        out += src.slice(pos, t.start);
        if (BREAK_TAGS.has(t.name.toLowerCase())) out += '\n';
        pos = t.end;
    }
    out += src.slice(pos);
    return out
        .split(/\r?\n/).map(l => l.replace(/[ \t]+$/, '')).join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * 一楼的导出文字。
 *   fallbackTags: 这楼没有翻译记录时用哪组标签切分(当前预设勾选的那组)
 *   exportTags:   导出哪些标签里的内容;空 = 跟翻译用的那组一样
 * 返回 { text, state }:state = 'full' 全是译文 / 'partial' 部分是原文 / 'none' 全是原文。
 */
export function floorText(message, fallbackTags = [], exportTags = []) {
    const mes = String(message?.mes ?? '');
    const rec = store.getRecord(message);
    const tags = store.tagsFor(message, fallbackTags);
    const shown = rec ? assemble(mes, tags, rec.segs) : mes;
    const total = new Set(store.missingUnits({ mes }, tags).map(u => u.fp)).size;
    const missing = store.missingUnits(message, tags).length;
    const state = missing === 0 ? 'full' : (missing < total ? 'partial' : 'none'); // 没有可译文字的楼算 full
    const want = exportTags.length ? exportTags : tags;
    const reg = findRegions(shown, want);
    const text = reg.regions.map(r => stripMarkup(shown.slice(r.start, r.end))).filter(Boolean).join('\n\n');
    return { text, state };
}

const STATE_NOTE = { full: '', partial: '(部分未翻译)', none: '(未翻译)' };

/**
 * 整个聊天的导出文本。titles:每楼前面加不加「第N章」小标题(预设自己会写标题的可以关掉)。
 *只收 AI 楼(用户楼不收);被隐藏的旧楼照收——隐藏只是不发给模型,读的时候还是正文。
 * 返回 { text, floors, untranslated }:floors = 收进来的楼数,untranslated = 其中不是全译文的楼数。
 */
export function buildExport(chat, { fallbackTags = [], exportTags = [], title = '', titles = true } = {}) {
    const parts = [];
    let floors = 0, untranslated = 0;
    (chat || []).forEach((m, i) => {
        if (!m || m.is_user) return;
        const { text, state } = floorText(m, fallbackTags, exportTags);
        if (!text) return;
        floors++;
        if (state !== 'full') untranslated++;
        // 小标题按收进来的顺序编号(第1章、第2章……),阅读器能认成目录;关掉就只留正文
        parts.push(titles ? `第${floors}章${STATE_NOTE[state]}\n\n${text}` : text);
    });
    const head = title ? `${title}\n\n\n` : '';
    return { text: head + parts.join('\n\n\n') + (parts.length ? '\n' : ''), floors, untranslated };
}
