// 纯函数单元测试:node --test test/
// 样本文字全部自编,中性内容;人名一律用「角色甲」「角色乙」,术语用「某术语」。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    findRegions, segment, assemble, maskInline, unmask, paraFingerprint, scanPairedTags, hasStructuralTag,
} from '../core/segment.js';
import {
    parseReply, judge, parseGlossary, mergeGlossary, pickGlossary, translateUnits, chunkUnits, tidyTranslation, hasKana,
} from '../core/translate.js';
import { buildSystemPrompt, buildUserMessage, DEFAULT_PROMPT, GLOSSARY_HEAD, PLACEHOLDER_NOTE } from '../core/prompts.js';
import { writeResults, renderDisplay, reconcile, getRecord, missingUnits, srcFingerprint, clearChat, setOff } from '../core/store.js';

// ── 样本 ──

const CONTENT_BODY = [
    '',
    '　雨が上がった。角色甲は窓を開けて、湿った空気を吸い込んだ。',
    '',
    '「……もう行くの？」',
    '　背後から角色乙の声がした。',
    '',
    '<!-- 場面転換 -->',
    '',
    '　彼は<ruby>某術語<rt>なにか</rt></ruby>を手に取り、静かに笑った。<br>',
    'それから、何も言わずに扉を閉めた。<!-- 注 -->',
    '',
    '***',
    '',
    '<div class="sep"></div>',
    '',
].join('\n');

const LONG_SAMPLE = [
    '<thinking>',
    '角色甲の気持ちを整理する。',
    '',
    '- 前の場面から続く',
    '</thinking>',
    `<content>${CONTENT_BODY}</content>`,
    '<status>',
    '時刻：夕方',
    '',
    '場所：駅前',
    '</status>',
    '<panel><div class="card" data-x="1">好感度 ★★★</div>',
    '',
    '<span>メモ：明日また会う</span></panel>',
    '',
].join('\n');

/** 假翻译:把假名换成「译」,保留占位符和其余字符。 */
const fakeZh = (s) => s.replace(/[ぁ-ゖァ-ヺ]/g, '译');

/** 用 fakeZh 翻完全部可译段落,得到 segs 表(已还原占位符)。 */
function segsFor(mes, tags, pick = () => true) {
    const segs = {};
    for (const u of segment(mes, tags).units) if (pick(u)) segs[u.fp] = unmask(fakeZh(u.masked), u.tokens);
    return segs;
}

// ── 切分 ──

test('切分:单标签', () => {
    const r = findRegions(LONG_SAMPLE, ['content']);
    assert.equal(r.mode, 'tags');
    assert.equal(r.regions.length, 1);
    assert.equal(LONG_SAMPLE.slice(r.regions[0].start, r.regions[0].end), CONTENT_BODY);
    const seg = segment(LONG_SAMPLE, ['content']);
    assert.deepEqual(seg.units.map(u => u.core), [
        '雨が上がった。角色甲は窓を開けて、湿った空気を吸い込んだ。',
        '「……もう行くの？」\n　背後から角色乙の声がした。',
        '彼は<ruby>某術語<rt>なにか</rt></ruby>を手に取り、静かに笑った。<br>\nそれから、何も言わずに扉を閉めた。<!-- 注 -->',
    ]);
    // 区域外的思维链、状态栏、面板一段都不送翻
    for (const u of seg.units) assert.ok(!/時刻|好感度|気持ち/.test(u.core));
});

test('切分:多组同名标签各成一个区域', () => {
    const mes = '<content>一つ目の段落です。</content>\n<status>状態</status>\n<content>二つ目の段落です。</content>';
    const r = findRegions(mes, ['content']);
    assert.equal(r.regions.length, 2);
    assert.deepEqual(segment(mes, ['content']).units.map(u => u.core), ['一つ目の段落です。', '二つ目の段落です。']);
});

test('切分:嵌套只取外层(同名、异名都一样)', () => {
    const same = '<content>外側の文。<content>内側の文。</content>外側の続き。</content>';
    const r1 = findRegions(same, ['content']);
    assert.equal(r1.regions.length, 1);
    assert.equal(same.slice(r1.regions[0].start, r1.regions[0].end), '外側の文。<content>内側の文。</content>外側の続き。');
    const cross = '<main>前置き。<content>本文。</content>後書き。</main><content>別の本文。</content>';
    const r2 = findRegions(cross, ['main', 'content']);
    assert.deepEqual(r2.regions.map(x => cross.slice(x.start, x.end)), ['前置き。<content>本文。</content>後書き。', '別の本文。']);
});

test('切分:未闭合的标签从最后一个开标签算到楼尾', () => {
    const mes = '<status>状態</status>\n<content>\n書きかけの本文。\n\n続きの段落。';
    const r = findRegions(mes, ['content']);
    assert.equal(r.regions.length, 1);
    assert.equal(r.regions[0].end, mes.length);
    assert.deepEqual(segment(mes, ['content']).units.map(u => u.core), ['書きかけの本文。', '続きの段落。']);
    // 两个未闭合:取最后一个
    const two = '<content>一つ目。\n<content>二つ目。';
    const r2 = findRegions(two, ['content']);
    assert.equal(r2.regions.length, 1);
    assert.equal(two.slice(r2.regions[0].start), '二つ目。');
});

test('切分:勾选为空、或这楼完全没有结构性标签,整楼作为一个区域', () => {
    const tagged = '<content>本文。</content><status>状態</status>';
    const r0 = findRegions(tagged, []);
    assert.equal(r0.mode, 'whole');
    assert.deepEqual(r0.regions, [{ start: 0, end: tagged.length, tag: null }]);
    const plain = '一行目の文章。\n\n二行目の文章。';
    const r1 = findRegions(plain, ['content']);
    assert.equal(r1.mode, 'whole');
    assert.equal(segment(plain, ['content']).units.length, 2);
    // 只有行内排版标签、注释:也算「没有标签」,整楼翻
    const inline = '<b>強調</b>された文。<!-- メモ --><br>\n\n次の文。';
    assert.equal(hasStructuralTag(inline), false);
    assert.equal(findRegions(inline, ['content']).mode, 'whole');
});

test('切分:有别的标签却没有勾选的标签 → 空区域 + no-selected-tag', () => {
    const mes = '<status>状態</status>\n本文だけがある。';
    const seg = segment(mes, ['content']);
    assert.equal(seg.mode, 'none');
    assert.equal(seg.reason, 'no-selected-tag');
    assert.deepEqual(seg.regions, []);
    assert.deepEqual(seg.units, []);
    // 注释里的勾选标签不算数
    assert.equal(segment('<status>x</status><!-- <content>偽</content> -->', ['content']).reason, 'no-selected-tag');
});

test('切分:段内行内标签与 HTML 注释换成占位符,还原后逐字一致', () => {
    const seg = segment(LONG_SAMPLE, ['content']);
    const u = seg.units[2];
    assert.equal(u.masked, '彼は⟦1⟧某術語⟦2⟧なにか⟦3⟧⟦4⟧を手に取り、静かに笑った。⟦5⟧\nそれから、何も言わずに扉を閉めた。⟦6⟧');
    assert.deepEqual(u.tokens, ['<ruby>', '<rt>', '</rt>', '</ruby>', '<br>', '<!-- 注 -->']);
    assert.equal(unmask(u.masked, u.tokens), u.core);
    // 段落里没有标签时不产生占位符
    assert.deepEqual(seg.units[0].tokens, []);
    assert.deepEqual(maskInline('a<!-- <b> -->b'), { masked: 'a⟦1⟧b', tokens: ['<!-- <b> -->'] });
});

test('切分:纯标签 / 纯符号 / 纯注释 / 空白段落原样保留', () => {
    const seg = segment(LONG_SAMPLE, ['content']);
    const skipped = seg.paras.filter(p => p.skip).map(p => [p.skip, p.core]);
    assert.deepEqual(skipped, [
        ['comment', '<!-- 場面転換 -->'],
        ['symbol', '***'],
        ['symbol', '<div class="sep"></div>'],
    ]);
    // 区域开头、结尾的空行切出空段落,原样保留
    const blank = segment('<content>\n\n\n本文。\n\n</content>', ['content']);
    assert.deepEqual(blank.paras.map(p => [p.skip, p.core]), [['blank', ''], [null, '本文。'], ['blank', '']]);
    // 注释里的空行不切段(否则注释后半截会被当成正文送翻)
    const mes = '本文の段落。\n\n<!-- 一行目\n\n二行目 -->\n\n次の段落。';
    assert.deepEqual(segment(mes, []).paras.map(p => [p.skip, p.core]), [
        [null, '本文の段落。'], ['comment', '<!-- 一行目\n\n二行目 -->'], [null, '次の段落。'],
    ]);
});

test('切分:段落指纹只看去首尾空白后的原文', () => {
    assert.equal(paraFingerprint('　文章。 \n'), paraFingerprint('文章。'));
    assert.notEqual(paraFingerprint('文章。'), paraFingerprint('文章!'));
    const a = segment('<content>\n\n　同じ段落。\n\n</content>', ['content']).units[0].fp;
    const b = segment('<content>同じ段落。</content>', ['content']).units[0].fp;
    assert.equal(a, b);
});

// ── 装回 ──

test('装回:区域外逐字节不变(含思维链、状态栏、面板的长样本)', () => {
    const tags = ['content'];
    const seg = segment(LONG_SAMPLE, tags);
    const region = seg.regions[0];
    // 恒等译文 → 必须与原文完全相同(换行、缩进、注释全部原样)
    const identity = Object.fromEntries(seg.units.map(u => [u.fp, u.core]));
    assert.equal(assemble(LONG_SAMPLE, tags, identity), LONG_SAMPLE);
    // 真译文:区域前后两截逐字节一致,区域内段落之间的分隔也一致
    const out = assemble(LONG_SAMPLE, tags, segsFor(LONG_SAMPLE, tags));
    assert.notEqual(out, LONG_SAMPLE);
    const prefix = LONG_SAMPLE.slice(0, region.start);
    const suffix = LONG_SAMPLE.slice(region.end);
    assert.ok(out.startsWith(prefix));
    assert.ok(out.endsWith(suffix));
    assert.equal(Buffer.from(out.slice(0, prefix.length)).compare(Buffer.from(prefix)), 0);
    assert.equal(Buffer.from(out.slice(out.length - suffix.length)).compare(Buffer.from(suffix)), 0);
    // 区域内:把每段译文换回原文,应还原出原文
    let back = out;
    for (const u of seg.units) back = back.replace(unmask(fakeZh(u.masked), u.tokens), u.core);
    assert.equal(back, LONG_SAMPLE);
    // 行内标签还原到了正确位置
    assert.ok(out.includes('彼译<ruby>某術語<rt>译译译</rt></ruby>译手译取译'));
});

test('装回:CRLF 与全角空格缩进原样保留', () => {
    const mes = '<content>\r\n　一段目です。\r\n\r\n　二段目です。\r\n</content>\r\n<status>x</status>';
    const tags = ['content'];
    const out = assemble(mes, tags, segsFor(mes, tags));
    assert.equal(out, '<content>\r\n　一段目译译。\r\n\r\n　二段目译译。\r\n</content>\r\n<status>x</status>');
});

test('装回:只翻了一部分段落时,其余保持原文', () => {
    const tags = ['content'];
    const seg = segment(LONG_SAMPLE, tags);
    const first = seg.units[0];
    const out = assemble(LONG_SAMPLE, tags, segsFor(LONG_SAMPLE, tags, u => u.fp === first.fp));
    assert.ok(out.includes(fakeZh(first.core)));
    assert.ok(!out.includes(first.core));
    for (const u of seg.units.slice(1)) assert.ok(out.includes(u.core), u.core);
    // 没有任何译文 → 与原文完全相同
    assert.equal(assemble(LONG_SAMPLE, tags, {}), LONG_SAMPLE);
});

test('装回:装回后再切分,段落结构与未翻段落的指纹不变', () => {
    const tags = ['content'];
    const before = segment(LONG_SAMPLE, tags);
    assert.deepEqual(segment(LONG_SAMPLE, tags), before); // 切分是确定的
    const firstFp = before.units[0].fp;
    const out = assemble(LONG_SAMPLE, tags, segsFor(LONG_SAMPLE, tags, u => u.fp === firstFp));
    const after = segment(out, tags);
    assert.equal(after.paras.length, before.paras.length);
    assert.deepEqual(after.paras.map(p => p.skip), before.paras.map(p => p.skip));
    assert.deepEqual(after.units.slice(1).map(u => u.fp), before.units.slice(1).map(u => u.fp));
    // 原文没变,再装一次仍得到同样的结果(重建不花钱、结果稳定)
    assert.equal(assemble(LONG_SAMPLE, tags, segsFor(LONG_SAMPLE, tags, u => u.fp === firstFp)), out);
    // 译文里多出的空行会被压掉,不会把一段拆成两段
    assert.equal(tidyTranslation('第一行\n\n\n第二行\n'), '第一行\n第二行');
});

// ── 解析 ──

test('解析:三种编号写法', () => {
    for (const [a, b] of [['[[1]]', '[[2]]'], ['【1】', '【2】'], ['[1]', '[2]']]) {
        const m = parseReply(`${a}\n第一段\n${b}\n第二段`);
        assert.equal(m.get(1), '第一段', a);
        assert.equal(m.get(2), '第二段', a);
    }
    assert.equal(parseReply('[[ 3 ]]\n带空格的编号').get(3), '带空格的编号');
});

test('解析:带代码围栏和首尾杂文', () => {
    const raw = '好的,以下是译文:\n```text\n[[1]]\n雨停了。\n[[2]]\n「……要走了吗?」\n```\n以上,如有需要请告诉我。';
    const m = parseReply(raw);
    assert.equal(m.get(1), '雨停了。');
    assert.equal(m.get(2), '「……要走了吗?」');
    // 无围栏时,末段之后空一行的结束语不算进译文
    const m2 = parseReply('译文如下\n[[1]]\n第一段\n\n希望对你有帮助。');
    assert.equal(m2.get(1), '第一段');
    // 段内换行保留
    assert.equal(parseReply('[[1]]\n第一行\n第二行').get(1), '第一行\n第二行');
});

test('解析:缺号、乱序、编号后同一行有字', () => {
    const miss = parseReply('[[1]]\n一\n[[3]]\n三');
    assert.equal(miss.has(2), false);
    assert.equal(miss.get(3), '三');
    const shuffled = parseReply('[[2]]\n二\n[[1]]\n一');
    assert.equal(shuffled.get(1), '一');
    assert.equal(shuffled.get(2), '二');
    const inline = parseReply('[[1]] 同一行的译文\n[[2]]【不是编号的括号】也照收\n续行');
    assert.equal(inline.get(1), '同一行的译文');
    assert.equal(inline.get(2), '【不是编号的括号】也照收\n续行');
});

// ── 没翻成的判定 ──

test('判定:五种没翻成,加短文本原样返回被接受', () => {
    const src = '角色甲は窓を開けて、湿った空気を吸い込んだ。';
    assert.equal(judge(src, undefined), 'missing');
    assert.equal(judge(src, '   '), 'empty');
    assert.equal(judge(src, src), 'same');
    assert.equal(judge(src, '角色甲打开窗,吸了一口潮湿的空气だった。'), 'kana');
    assert.equal(judge('彼は⟦1⟧笑った⟦2⟧', '他⟦1⟧笑了'), 'placeholder');
    assert.equal(judge('彼は⟦1⟧笑った', '他⟦1⟧⟦1⟧笑了'), 'placeholder');
    assert.equal(judge('彼は⟦1⟧笑った', '他⟦1⟧笑了'), null);
    // 短文本(≤12 字符)原样返回:接受为「不用翻」
    assert.equal(judge('OK, 3:00 PM', 'OK, 3:00 PM'), null);
    // 带假名的短句原样返回仍算没翻
    assert.equal(judge('「うん」', '「うん」'), 'kana');
    assert.equal(judge(src, '角色甲打开窗,吸了一口潮湿的空气。'), null);
    // 长音符、中点不算假名
    assert.equal(hasKana('角色甲・角色乙ー'), false);
});

// ── 译名表 ──

test('译名表:四种分隔符', () => {
    const g = parseGlossary('角色甲 = 甲\n角色乙→乙\n某術語 => 某术语\n某場所＝某地\n\n# 注释行\n没有分隔符的行');
    assert.deepEqual(g, [
        { src: '角色甲', dst: '甲' }, { src: '角色乙', dst: '乙' }, { src: '某術語', dst: '某术语' }, { src: '某場所', dst: '某地' },
    ]);
});

test('译名表:只带出现过的条目;角色卡覆盖通用', () => {
    const merged = mergeGlossary('角色甲 = 通用甲\n某術語 = 某术语', '角色甲 = 卡内甲\n某場所 = 某地');
    assert.deepEqual(merged, [{ src: '角色甲', dst: '卡内甲' }, { src: '某術語', dst: '某术语' }, { src: '某場所', dst: '某地' }]);
    const picked = pickGlossary(merged, '角色甲は某場所へ向かった。');
    assert.deepEqual(picked.map(x => x.src), ['角色甲', '某場所']);
    const sys = buildSystemPrompt('', picked);
    assert.ok(sys.startsWith(DEFAULT_PROMPT));
    assert.ok(sys.includes(`${GLOSSARY_HEAD}：\n角色甲 = 卡内甲\n某場所 = 某地`));
    assert.ok(!sys.includes('某術語'));
    // 表为空时整节不出现;无占位符时不带占位符说明
    const bare = buildSystemPrompt('', []);
    assert.ok(!bare.includes(GLOSSARY_HEAD));
    assert.ok(!bare.includes(PLACEHOLDER_NOTE));
    assert.ok(buildSystemPrompt('', [], { placeholders: true }).includes(PLACEHOLDER_NOTE));
    assert.equal(buildUserMessage(['一', '二']), '[[1]]\n一\n[[2]]\n二');
});

// ── 补缺与对半拆分 ──

const mkUnits = (n, len = 30) => Array.from({ length: n }, (_, i) => {
    const masked = `第${i + 1}段の文章です。`.padEnd(len, 'あ');
    return { fp: 'fp' + i, masked, tokens: [] };
});
const parseUser = (user) => [...user.matchAll(/\[\[(\d+)\]\]\n([^\n]*)/g)].map(m => ({ n: +m[1], text: m[2] }));
const reply = (items) => items.map(it => `[[${it.n}]]\n${fakeZh(it.text)}`).join('\n');

test('补缺:第一次只回一半,补译一次回全', async () => {
    const calls = [];
    const call = async (sys, user) => {
        const items = parseUser(user);
        calls.push(items.length);
        return reply(calls.length === 1 ? items.slice(0, Math.ceil(items.length / 2)) : items);
    };
    const res = await translateUnits(mkUnits(6), { call, batchChars: 100000 });
    assert.deepEqual(calls, [6, 3]); // 补译只发没翻成的 3 段
    assert.equal(res.requests, 2);
    assert.equal(res.done.size, 6);
    assert.equal(res.failed.size, 0);
    assert.equal(res.error, null);
});

test('补缺:毫无新增时对半拆分;只剩一段再试一次后放弃', async () => {
    // 前两次什么都不回,之后正常:6 段 → 拆 3+3,第二次又空 → 拆 2+1 ……
    let k = 0;
    const sizes = [];
    const call = async (sys, user) => {
        const items = parseUser(user);
        sizes.push(items.length);
        k++;
        return k <= 2 ? '抱歉,无法完成。' : reply(items);
    };
    const res = await translateUnits(mkUnits(6), { call, batchChars: 100000 });
    assert.deepEqual(sizes, [6, 3, 2, 1, 3]);
    assert.equal(res.done.size, 6);
    assert.equal(res.requests, 5);
});

test('补缺:始终截断(每次只回第一段)时硬上限 8 生效,部分成功照样交回', async () => {
    let n = 0;
    const call = async (sys, user) => { n++; return reply(parseUser(user).slice(0, 1)); };
    const res = await translateUnits(mkUnits(12), { call, batchChars: 100000 });
    assert.equal(n, 8);
    assert.equal(res.requests, 8);
    assert.equal(res.done.size, 8);
    assert.equal(res.failed.size, 4);
});

test('补缺:始终空回复时拆分到底并受硬上限约束', async () => {
    let n = 0;
    const call = async () => { n++; return ''; };
    const res = await translateUnits(mkUnits(8), { call, batchChars: 100000 });
    assert.equal(n, 8);
    assert.equal(res.done.size, 0);
    assert.equal(res.failed.size, 8);
});

test('分批:按字符数上限在段落边界切批,顺序发送;调用报错不重试并报原文', async () => {
    const units = mkUnits(5, 40); // 每段 40 字符
    assert.deepEqual(chunkUnits(units, 100).map(b => b.length), [2, 2, 1]);
    const seen = [];
    const call = async (sys, user) => {
        const items = parseUser(user);
        seen.push(items.map(i => i.text.slice(0, 3)));
        if (seen.length === 2) throw { error: { message: 'HTTP 401 Unauthorized' } };
        return reply(items);
    };
    const res = await translateUnits(units, { call, batchChars: 100 });
    assert.equal(res.requests, 2);
    assert.equal(res.error, 'HTTP 401 Unauthorized');
    assert.equal(res.done.size, 2); // 第一批已翻成的照样交回
    assert.deepEqual(seen.map(s => s[0]), ['第1段', '第3段']);
});

test('补缺:占位符在译文里还原;同一段落出现两次只翻一次', async () => {
    const seg = segment('<content>彼は<b>某術語</b>を見た。\n\n彼は<b>某術語</b>を見た。</content>', ['content']);
    assert.equal(seg.units.length, 2);
    let sent = 0;
    const call = async (sys, user) => {
        assert.ok(sys.includes(PLACEHOLDER_NOTE));
        assert.ok(!user.includes('<b>'));
        sent = parseUser(user).length;
        return '[[1]]\n他看见了⟦1⟧某术语⟦2⟧。';
    };
    const res = await translateUnits(seg.units, { call });
    assert.equal(sent, 1);
    assert.equal(res.done.get(seg.units[0].fp), '他看见了<b>某术语</b>。');
});

// ── 存储 ──

test('存储:写入、装回、off 切换、清掉对不上的旧条目、继承记录按指纹识别', () => {
    const tags = ['content'];
    const msg = { mes: LONG_SAMPLE, extra: {} };
    const units = segment(LONG_SAMPLE, tags).units;
    const res = new Map([[units[0].fp, '雨停了。'], ['stale-fp', '旧译文']]);
    const rec = writeResults(msg, tags, res);
    assert.equal(rec.src, srcFingerprint(LONG_SAMPLE));
    assert.deepEqual(Object.keys(rec.segs), [units[0].fp]); // 对不上的条目不收
    assert.equal(rec.missing, 2);
    assert.equal(renderDisplay(msg).shown, true);
    assert.ok(msg.extra.display_text.includes('雨停了。'));
    assert.equal(msg.mes, LONG_SAMPLE); // 消息本体不动
    assert.equal(setOff(msg, true), false);
    assert.equal(msg.extra.display_text, undefined);
    assert.equal(setOff(msg, false), true);
    assert.equal(missingUnits(msg, tags).length, 2);
    // 一段都没翻成:不写 display_text
    const empty = { mes: LONG_SAMPLE, extra: {} };
    writeResults(empty, tags, new Map());
    renderDisplay(empty);
    assert.equal('display_text' in empty.extra, false);
    // 新 swipe 继承了旧记录:原文不同 → reconcile 清掉旧条目
    const child = { mes: '<content>まったく別の本文。</content>', extra: structuredClone(msg.extra) };
    delete child.extra.display_text;
    assert.equal(reconcile(child, tags), true);
    assert.deepEqual(getRecord(child).segs, {});
    assert.equal(getRecord(child).missing, 1);
    renderDisplay(child);
    assert.equal(child.extra.display_text, undefined);
    // 清除整个聊天(含 swipe 存档)
    const chat = [msg, { mes: 'x', extra: {}, swipe_info: [{ extra: structuredClone(msg.extra) }] }, { mes: 'y' }];
    assert.deepEqual(clearChat(chat), [0, 1]);
    assert.equal(chat[1].swipe_info[0].extra.parallax, undefined);
});

// ── 标签扫描 ──

test('扫描:列出成对标签、预览与字数,行内标签不列', () => {
    const list = scanPairedTags(LONG_SAMPLE);
    // 按首次出现的位置排:content 里那个分隔用的 div 排在 status 之前
    assert.deepEqual(list.map(x => x.tag), ['thinking', 'content', 'div', 'status', 'panel']);
    const content = list.find(x => x.tag === 'content');
    assert.ok(content.preview.startsWith('雨が上がった。'));
    const max = list.reduce((a, b) => (b.chars > a.chars ? b : a));
    assert.equal(max.tag, 'content');
});

// ── 导出译文 ──

import { stripMarkup, floorText, buildExport } from '../core/export.js';

test('导出:去标签与注释,<br> 变换行,空行压成一个', () => {
    assert.equal(stripMarkup('甲<!-- 注 -->乙<br>丙\n\n\n\n<b>丁</b>  '), '甲乙\n丙\n\n丁');
});

test('导出:只收 AI 楼,取指定标签,译文优先,没翻的标出来', () => {
    const mk = (mes, extra = {}) => ({ mes, extra, is_user: false });
    const body = '<think>考える</think>\n<content>\n一段目。\n\n二段目。\n</content>\n<status>\n状態。\n</status>';
    const tags = ['content', 'status'];
    const a = mk(body);
    const units = missingUnits(a, tags);
    writeResults(a, tags, new Map(units.map((u, i) => [u.fp, `译文${i + 1}`])));
    const b = mk(body.replace('一段目', '別の一段目'));
    const ub = missingUnits(b, tags);
    writeResults(b, tags, new Map([[ub[0].fp, '只翻了这一段']]));
    const c = mk(body.replace('一段目', '三楼的一段目'));
    const hidden = { ...mk(body), is_system: true };
    writeResults(hidden, tags, new Map(missingUnits(hidden, tags).map((u, i) => [u.fp, `隐藏楼译文${i + 1}`])));
    const chat = [{ mes: 'ユーザーの入力', is_user: true }, a, { mes: 'again', is_user: true }, b, c, hidden];

    assert.deepEqual(floorText(a, tags, ['content']), { text: '译文1\n\n译文2', state: 'full' });
    assert.equal(floorText(a, tags, []).text, '译文1\n\n译文2\n\n译文3'); // 不指定 = 翻译用的那组
    assert.equal(floorText(b, tags, ['content']).state, 'partial');
    assert.equal(floorText(c, tags, ['content']).state, 'none');

    const res = buildExport(chat, { fallbackTags: tags, exportTags: ['content'], title: '角色甲' });
    assert.equal(res.floors, 4);
    assert.equal(res.untranslated, 2);
    assert.ok(res.text.startsWith('角色甲\n\n\n第 2 楼\n\n译文1\n\n译文2\n\n\n第 4 楼(部分未翻译)\n\n只翻了这一段\n\n二段目。'));
    assert.ok(res.text.includes('第 5 楼(未翻译)\n\n三楼的一段目。'));
    assert.ok(res.text.includes('第 6 楼\n\n隐藏楼译文1')); // 被隐藏的旧楼照收
    assert.ok(!res.text.includes('ユーザー') && !res.text.includes('考える') && !res.text.includes('状態') && !res.text.includes('<'));
});

test('导出:没有标签的楼(开场白之类)整楼导出', () => {
    const m = { mes: 'ようこそ。\n\n<b>始まり</b>だ。', extra: {}, is_user: false };
    assert.deepEqual(floorText(m, ['content'], ['content']), { text: 'ようこそ。\n\n始まりだ。', state: 'none' });
});
