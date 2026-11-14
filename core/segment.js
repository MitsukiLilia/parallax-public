// 切分与装回(纯函数,不碰酒馆)。整个插件的命门:区域外的内容必须逐字节不变。
// 做法是只记「位置」,不改写原文:切分产出每个可译段落在原文里的 [start, end),
// 装回时用 slice 把原文拼回去、只替换这些区间。区域外的字节根本不经过任何变换,自然不会变。

const NAME = '[\\p{L}_][\\p{L}\\p{N}_.:-]*';
// 标签记号:开、闭、自闭合都算。属性里不允许出现 < >,避免把「a < b > c」这种正文误认成标签。
const TAG_RE = new RegExp(`<\\/?${NAME}(?:\\s[^<>]*)?\\/?>`, 'gu');
// HTML 注释:未闭合的注释按浏览器的规矩一直吞到末尾。
const COMMENT_RE = /<!--[\s\S]*?(?:-->|$)/g;
// 段内要换成占位符的东西:注释优先(注释里可能有长得像标签的文字)。
const INLINE_RE = new RegExp(`<!--[\\s\\S]*?(?:-->|$)|<\\/?${NAME}(?:\\s[^<>]*)?\\/?>`, 'gu');
// 空行:一个换行之后,跟着一行或多行「只有空白」的行。下一段第一行的缩进不吞进来,留给段落自己的前导空白。
const BLANK_LINE_RE = /\r?\n(?:[ \t　\f\v]*\r?\n)+/g;
const HAS_LETTER_RE = /\p{L}/u;

// 正文里夹着的这些行内排版标签不算「XML 样式标签」:
// 模型忘了套结构、只在正文里用了加粗/注音/换行时,应该整楼翻译,而不是报「没找到勾选的标签」。
const INLINE_HTML = new Set([
    'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'center', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font',
    'hr', 'i', 'img', 'ins', 'kbd', 'mark', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'small', 'span',
    'strike', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr',
]);

export const PLACEHOLDER_RE = /⟦(\d+)⟧/g;
export const SHORT_LIMIT = 12;

/** 53 位字符串散列(cyrb53),输出 base36。只用于「这段文字还是不是那段文字」,不做安全用途。 */
export function hash(str) {
    const s = String(str ?? '');
    let h1 = 0xdeadbeef ^ s.length, h2 = 0x41c6ce57 ^ s.length;
    for (let i = 0; i < s.length; i++) {
        const ch = s.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** 段落指纹:去首尾空白后的原文。缩进、前后空行变了不算这段变了。 */
export const paraFingerprint = (core) => hash(String(core).trim());

const lower = (s) => String(s).toLowerCase();

/** 原文里所有注释的区间(用于:注释里的标签不算数、注释中间的空行不切段)。 */
function commentRanges(src) {
    const out = [];
    for (const m of src.matchAll(COMMENT_RE)) out.push([m.index, m.index + m[0].length]);
    return out;
}
const inRanges = (pos, ranges) => ranges.some(([a, b]) => pos >= a && pos < b);

/** 扫出原文里的标签记号(跳过注释内部):[{ name, kind: 'open'|'close'|'self', start, end }] */
export function scanTagTokens(src) {
    const s = String(src ?? '');
    const comments = commentRanges(s);
    const out = [];
    for (const m of s.matchAll(TAG_RE)) {
        if (inRanges(m.index, comments)) continue;
        const raw = m[0];
        const name = raw.match(new RegExp(`^<\\/?(${NAME})`, 'u'))[1];
        const kind = raw[1] === '/' ? 'close' : (raw.endsWith('/>') ? 'self' : 'open');
        out.push({ name, kind, start: m.index, end: m.index + raw.length });
    }
    return out;
}

/** 这一楼是否含有「结构性」标签(行内排版标签和注释不算)。 */
export function hasStructuralTag(src) {
    return scanTagTokens(src).some(t => !INLINE_HTML.has(lower(t.name)));
}

/**
 * 取区域。返回 { mode, reason, regions: [{ start, end, tag }] },start/end 是区域内部(不含标签本身)在原文里的位置。
 * mode: 'whole' 整楼 | 'tags' 按勾选标签 | 'none' 一个区域都没有(reason 说明原因)。
 */
export function findRegions(mes, tags) {
    const src = String(mes ?? '');
    const wanted = new Set((tags || []).map(t => lower(String(t).trim())).filter(Boolean));
    if (!wanted.size || !hasStructuralTag(src)) {
        return { mode: 'whole', reason: null, regions: [{ start: 0, end: src.length, tag: null }] };
    }
    const found = [];
    const stacks = new Map(); // 每个标签名各自一个栈:不同名的标签交错时互不干扰
    for (const t of scanTagTokens(src)) {
        const key = lower(t.name);
        if (!wanted.has(key) || t.kind === 'self') continue;
        if (!stacks.has(key)) stacks.set(key, []);
        const st = stacks.get(key);
        if (t.kind === 'open') { st.push(t); continue; }
        const open = st.pop();
        if (!open) continue; // 多出来的闭标签:不成对,忽略
        found.push({ start: open.end, end: t.start, tag: open.name, from: open.start });
    }
    // 只有开标签没有闭标签:取最后一个未闭合的开标签,到楼尾算一个区域。
    let lastOpen = null;
    for (const st of stacks.values()) for (const o of st) if (!lastOpen || o.start > lastOpen.start) lastOpen = o;
    if (lastOpen) found.push({ start: lastOpen.end, end: src.length, tag: lastOpen.name, from: lastOpen.start });
    if (!found.length) return { mode: 'none', reason: 'no-selected-tag', regions: [] };
    // 嵌套只取外层:按开标签位置排序,落在已取区域之内(或与之交叠)的一律丢掉。
    found.sort((a, b) => a.from - b.from || b.end - a.end);
    const regions = [];
    let edge = -1;
    for (const r of found) {
        if (r.from < edge) continue;
        regions.push({ start: r.start, end: r.end, tag: r.tag });
        edge = r.end;
    }
    return { mode: 'tags', reason: null, regions };
}

/** 一个段落是否要送翻;不送的给出原因。 */
export function classifyParagraph(core) {
    if (!core) return 'blank';
    const noComment = core.replace(COMMENT_RE, '');
    if (!noComment.trim()) return 'comment';
    if (!HAS_LETTER_RE.test(noComment.replace(TAG_RE, ''))) return 'symbol';
    return null;
}

/** 把段内的行内标签与注释换成 ⟦1⟧ ⟦2⟧…;tokens[k-1] 是第 k 个占位符对应的原文。 */
export function maskInline(core) {
    const tokens = [];
    const masked = String(core).replace(INLINE_RE, (m) => { tokens.push(m); return `⟦${tokens.length}⟧`; });
    return { masked, tokens };
}

/** 占位符还原;tokens 不够时留着占位符原样(调用方应已校验过数量)。 */
export function unmask(text, tokens) {
    return String(text).replace(PLACEHOLDER_RE, (m, k) => (tokens[Number(k) - 1] ?? m));
}

/** 区域内按空行切段(注释内部的空行不切)。返回 [{ start, end }](相对原文的绝对位置,含段落首尾空白)。 */
function splitRegion(src, region, comments) {
    const text = src.slice(region.start, region.end);
    const pieces = [];
    let cur = 0;
    for (const m of text.matchAll(BLANK_LINE_RE)) {
        if (inRanges(region.start + m.index, comments)) continue;
        pieces.push({ start: region.start + cur, end: region.start + m.index });
        cur = m.index + m[0].length;
    }
    pieces.push({ start: region.start + cur, end: region.end });
    return pieces;
}

/**
 * 切分一楼。返回:
 *   mode / reason / regions:同 findRegions
 *   paras: 区域内全部段落 [{ start, end, core, skip, fp?, masked?, tokens? }]
 *          start/end 是去掉首尾空白之后的段落正文在原文里的位置
 *   units: 要送翻的段落(paras 里 skip 为 null 的那些)
 */
export function segment(mes, tags) {
    const src = String(mes ?? '');
    const reg = findRegions(src, tags);
    const comments = commentRanges(src);
    const paras = [];
    for (const region of reg.regions) {
        for (const p of splitRegion(src, region, comments)) {
            const raw = src.slice(p.start, p.end);
            const lead = raw.length - raw.trimStart().length;
            const core = raw.trim();
            const start = p.start + lead;
            const end = start + core.length;
            const skip = classifyParagraph(core);
            const para = { start, end, core, skip };
            if (!skip) Object.assign(para, { fp: paraFingerprint(core) }, maskInline(core));
            paras.push(para);
        }
    }
    return { ...reg, paras, units: paras.filter(p => !p.skip) };
}

/**
 * 装回:segs 是「段落指纹 → 译文(已还原占位符)」。有译文的段落换成译文,其余一切按原文 slice 拼回。
 * 返回显示用全文。一段都没换时返回值与原文完全相同。
 */
export function assemble(mes, tags, segs) {
    const src = String(mes ?? '');
    if (!segs || typeof segs !== 'object') return src;
    let out = '';
    let pos = 0;
    for (const u of segment(src, tags).units) {
        const t = Object.prototype.hasOwnProperty.call(segs, u.fp) ? segs[u.fp] : null;
        if (typeof t !== 'string' || !t) continue;
        out += src.slice(pos, u.start) + t;
        pos = u.end;
    }
    return out + src.slice(pos);
}

/**
 * 扫描一楼里出现的成对标签(给面板勾选用),行内排版标签不列。
 * 返回 [{ tag, preview, chars }],按首次出现的顺序;chars 是该标签全部内容去掉标签后的字数。
 */
export function scanPairedTags(mes, previewLen = 60) {
    const src = String(mes ?? '');
    const order = [];
    const info = new Map();
    const stacks = new Map();
    for (const t of scanTagTokens(src)) {
        const key = lower(t.name);
        if (INLINE_HTML.has(key) || t.kind === 'self') continue;
        if (!stacks.has(key)) stacks.set(key, []);
        const st = stacks.get(key);
        if (t.kind === 'open') { st.push(t); continue; }
        const open = st.pop();
        if (!open) continue;
        if (st.length) continue; // 同名嵌套只算最外层,免得字数重复累计
        const inner = src.slice(open.end, t.start).replace(COMMENT_RE, '').replace(TAG_RE, '');
        const flat = inner.replace(/\s+/g, ' ').trim();
        if (!info.has(open.name)) { info.set(open.name, { tag: open.name, preview: '', chars: 0, pos: open.start }); order.push(open.name); }
        const it = info.get(open.name);
        if (!it.preview) it.preview = flat.slice(0, previewLen);
        it.chars += [...inner.replace(/\s+/g, '')].length;
    }
    return order.map(n => info.get(n)).sort((a, b) => a.pos - b.pos).map(({ tag, preview, chars }) => ({ tag, preview, chars }));
}
