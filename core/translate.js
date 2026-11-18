// 翻译调用:组请求、宽容解析、判定「没翻成」、补缺与对半拆分重试。纯逻辑,模型调用由调用方注入(call)。

import { PLACEHOLDER_RE, SHORT_LIMIT, unmask } from './segment.js';
import { buildSystemPrompt, buildUserMessage } from './prompts.js';

export const MAX_REQUESTS = 8;

// 假名(目标是简体中文,译文里出现就算没翻成)。不含长音符「ー」、中点「・」和浊点记号:中文译文里偶尔合法出现。
const KANA_RE = /[ぁ-ゖゝ-ゟァ-ヺヽ-ヿㇰ-ㇿｦ-ｯｱ-ﾝ]/;
export const hasKana = (s) => KANA_RE.test(String(s ?? ''));
// 「译文里还留着原文的文字」的判据,按原文语言各一条。
// 英语:人名、缩写会合法留在译文里,所以不看有没有拉丁字母,看有没有连着 4 个以上的英文单词。
const EN_RUN_RE = /(?:[A-Za-z][A-Za-z'’-]*[\s,.;:!?"“”‘’—–-]+){3}[A-Za-z]/;
export const hasEnglishRun = (s) => EN_RUN_RE.test(String(s ?? ''));
const RESIDUE = { ja: hasKana, en: hasEnglishRun };
const hasResidue = (lang, s) => (RESIDUE[lang] || RESIDUE.ja)(s);

// ── 译名表 ──

const GLOSS_SEP_RE = /\s*(=>|→|＝|=)\s*/;

/** 每行一条「原文 = 译名」,也认 → => ＝。空行、# 或 // 开头的行跳过。 */
export function parseGlossary(text) {
    const out = [];
    for (const line of String(text ?? '').split(/\r?\n/)) {
        const l = line.trim();
        if (!l || l.startsWith('#') || l.startsWith('//')) continue;
        const m = l.match(GLOSS_SEP_RE);
        if (!m) continue;
        const src = l.slice(0, m.index).trim();
        const dst = l.slice(m.index + m[0].length).trim();
        if (src && dst) out.push({ src, dst });
    }
    return out;
}

/** 条目列表写回文本(每行「原文 = 译名」),和 parseGlossary 互逆。 */
export const serializeGlossary = (entries) => (entries || []).map(g => `${g.src} = ${g.dst}`).join('\n');

/** 通用表 + 角色卡表合并:同一原文以角色卡的为准,顺序按首次出现。 */
export function mergeGlossary(commonText, charText) {
    const map = new Map();
    for (const g of parseGlossary(commonText)) map.set(g.src, g.dst);
    for (const g of parseGlossary(charText)) map.set(g.src, g.dst);
    return [...map].map(([src, dst]) => ({ src, dst }));
}

/** 只带「原文一栏在本批文字里出现过」的条目。 */
export const pickGlossary = (entries, text) => (entries || []).filter(g => String(text).includes(g.src));

// ── 解析 ──

const MARK_RE = /^\s*(?:\[\[\s*(\d+)\s*\]\]|【\s*(\d+)\s*】|\[\s*(\d+)\s*\])\s*(.*)$/;

// 提示词要求把全部译文包在这对标签里。名字取得特别:走酒馆当前连接时回复会先过用户的正则脚本,常见的标签名可能被哪套预设的正则处理掉。
export const OUT_TAG = 'parallax_output';
const OUT_OPEN_RE = new RegExp(`<${OUT_TAG}>`, 'i');
const OUT_CLOSE_RE = new RegExp(`</${OUT_TAG}>`, 'i');

/** 取标签里面的内容。没有闭标签(多半是输出被截断)就取到末尾;没有开标签返回 null。 */
function insideOutTag(raw) {
    const open = raw.match(OUT_OPEN_RE);
    if (!open) return null;
    const rest = raw.slice(open.index + open[0].length);
    const close = rest.match(OUT_CLOSE_RE);
    return close ? rest.slice(0, close.index) : rest;
}

/**
 * 宽容解析:优先只看 <parallax_output> 标签里面的内容(标签外的开场白、结束语直接不要);
 * 再剥代码围栏行;[[n]]、【n】、[n] 独占一行都认,编号后同一行有文字也认。
 * 每段的译文取到下一个编号为止,段内的空行照收(之后由 tidyTranslation 压掉)。
 * 只有一种情况还按空行切:模型没写标签时的最后一段,空行之后的当作结束语。
 * 返回 Map<n, text>;同一编号出现多次取第一个非空的。
 */
export function parseReply(raw) {
    const whole = String(raw ?? '').replace(/\r\n/g, '\n');
    const inner = insideOutTag(whole);
    const wrapped = inner !== null;
    let lines = (wrapped ? inner : whole).split('\n');
    const fenceAt = lines.map((l, i) => (/^\s*```/.test(l) ? i : -1)).filter(i => i >= 0);
    if (fenceAt.length >= 2) {
        // 有成对围栏:只要围栏里面的,围栏外的开场白、结束语都是杂文
        const inside = [];
        for (let k = 0; k + 1 < fenceAt.length; k += 2) inside.push(...lines.slice(fenceAt[k] + 1, fenceAt[k + 1]));
        lines = inside.some(l => MARK_RE.test(l)) ? inside : lines.filter(l => !/^\s*```/.test(l));
    } else {
        lines = lines.filter(l => !/^\s*```/.test(l));
    }
    const out = new Map();
    let cur = null;
    const flush = (isLast) => {
        if (!cur) return;
        let body = cur.lines.join('\n').trim();
        if (isLast && !wrapped) body = body.split(/\n[ \t　]*\n/)[0].trim();
        if (body && !out.get(cur.n)) out.set(cur.n, body);
        else if (!out.has(cur.n)) out.set(cur.n, body);
        cur = null;
    };
    for (const line of lines) {
        const m = line.match(MARK_RE);
        if (m) {
            flush(false);
            cur = { n: Number(m[1] ?? m[2] ?? m[3]), lines: m[4] ? [m[4]] : [] };
            continue;
        }
        if (cur) cur.lines.push(line);
    }
    flush(true);
    return out;
}

/** 译文收拾:去首尾空白,段内空行压成单个换行(装回后再切分时段落结构不变)。 */
export const tidyTranslation = (s) => String(s ?? '').trim().replace(/\n[ \t　]*(?:\n[ \t　]*)+/g, '\n');

function placeholderOk(src, out) {
    const want = [...src.matchAll(PLACEHOLDER_RE)].map(m => m[1]).sort();
    const got = [...out.matchAll(PLACEHOLDER_RE)].map(m => m[1]).sort();
    return want.length === got.length && want.every((v, i) => v === got[i]);
}

/**
 * 判定一段有没有翻成。返回 null = 翻成了(或短文本原样返回,接受为不用翻);否则返回原因。
 * 原因:missing 缺号 / empty 空 / placeholder 占位符对不上 / same 原样返回且原文较长 / kana 残留原文文字(日语 = 假名,英语 = 连着 4 个以上英文单词)
 */
export function judge(masked, text, lang = 'ja') {
    if (text === undefined || text === null) return 'missing';
    const t = tidyTranslation(text);
    if (!t) return 'empty';
    const src = String(masked).trim();
    if (!placeholderOk(src, t)) return 'placeholder';
    if (t === src) {
        if ([...src].length > SHORT_LIMIT) return 'same';
        // 短文本原样返回 = 不用翻(符号、外文缩写、数字之类);但带假名的短句原样返回仍是没翻
        return hasResidue(lang, t) ? 'kana' : null;
    }
    if (hasResidue(lang, t)) return 'kana';
    return null;
}

// ── 分批与重试 ──

/** 按原文字符数上限在段落边界切批;单段超长就自成一批。 */
export function chunkUnits(units, limit) {
    const cap = Math.max(1, Number(limit) || 80000);
    const out = [];
    let cur = [], size = 0;
    for (const u of units) {
        const n = u.masked.length;
        if (cur.length && size + n > cap) { out.push(cur); cur = []; size = 0; }
        cur.push(u); size += n;
    }
    if (cur.length) out.push(cur);
    return out;
}

/** 按指纹去重:同一楼里一模一样的段落只翻一次。 */
export function dedupeUnits(units) {
    const seen = new Set();
    return units.filter(u => (seen.has(u.fp) ? false : (seen.add(u.fp), true)));
}

const errText = (err) => String(err?.message || err?.error?.message || err);

/**
 * 跑一次翻译任务。
 *   units: [{ fp, masked, tokens }]
 *   call(systemPrompt, userContent) → Promise<string>:模型调用;抛错 = 调用本身失败,不重试
 *   onProgress({ batch, batches, retry, requests })
 * 返回 { done: Map<fp, 已还原的译文>, failed: Map<fp, 原因>, requests, error }
 * 规则:批内一次回来后只补没翻成的;一次请求毫无新增就把剩余对半拆开(只剩一段则再试一次后放弃);总请求数硬上限 maxRequests。
 */
export async function translateUnits(units, { call, prompt = '', lang = 'ja', glossary = [], batchChars = 80000, maxRequests = MAX_REQUESTS, onProgress } = {}) {
    const all = dedupeUnits(units || []);
    const done = new Map();
    const failed = new Map();
    let requests = 0;
    let error = null;
    const batches = chunkUnits(all, batchChars);

    async function send(list) {
        const text = list.map(u => u.masked).join('\n');
        const sys = buildSystemPrompt(prompt, pickGlossary(glossary, text), { placeholders: list.some(u => u.tokens?.length) });
        const raw = await call(sys, buildUserMessage(list.map(u => u.masked)));
        const parsed = parseReply(raw);
        const bad = [];
        list.forEach((u, i) => {
            const why = judge(u.masked, parsed.get(i + 1), lang);
            if (why) { failed.set(u.fp, why); bad.push(u); return; }
            failed.delete(u.fp);
            done.set(u.fp, unmask(tidyTranslation(parsed.get(i + 1)), u.tokens || []));
        });
        return bad;
    }

    outer:
    for (let b = 0; b < batches.length; b++) {
        const work = [{ list: batches[b], stalls: 0, retry: false }];
        while (work.length) {
            const item = work.shift();
            if (requests >= maxRequests) { work.unshift(item); break outer; }
            requests++;
            onProgress?.({ batch: b + 1, batches: batches.length, retry: item.retry, requests });
            let bad;
            try { bad = await send(item.list); }
            catch (err) { error = errText(err); break outer; }
            if (!bad.length) continue;
            if (bad.length < item.list.length) { work.unshift({ list: bad, stalls: 0, retry: true }); continue; }
            // 毫无新增:原样重发一个被截断的请求只会再截断,所以拆小
            if (bad.length > 1) {
                const mid = Math.ceil(bad.length / 2);
                work.unshift({ list: bad.slice(0, mid), stalls: 0, retry: true }, { list: bad.slice(mid), stalls: 0, retry: true });
            } else if (item.stalls < 1) {
                work.unshift({ list: bad, stalls: item.stalls + 1, retry: true });
            }
        }
    }
    for (const u of all) if (!done.has(u.fp) && !failed.has(u.fp)) failed.set(u.fp, error ? 'aborted' : 'limit');
    return { done, failed, requests, error };
}
