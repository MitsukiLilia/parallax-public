// 默认译法提示词与请求格式。译法原文照任务书,不改写;格式约定、译名表节、占位符说明由代码拼在后面。

export const DEFAULT_PROMPT = `你是一位文学译者。把下面的小说正文译成简体中文。原文通常是日语。

译法：
1. 忠实原文：不添原文没有的形容词、比喻、四字词和夸张，也不删减。
2. 留住原文的呼吸：短句、省略、倒置的节奏、换行的留白尽量保留，不改写成华丽的中文文学腔。目标是优质的日系小说译文——简洁、干净，带一点原文的质感。
3. 要避开的只有生硬的逐字直译；同时不往中文网络小说的腔调上靠，不用「一抹」「一丝」「不由得」这类套话。
4. 自称一律译「我」，复数译「我们」：不论角色，都不译成「老子」「本大爷」「老夫」「本小姐」「在下」之类。角色的粗野、气派或教养，靠措辞和语气来立，不靠自称。
5. 第二人称按关系与口吻译成「你」或「您」。敬称与昵称后缀不音译，换成关系相称的自然中文称呼。
6. 语尾口癖不音译，用中文里相称的语气处理。
7. 吐息、拟声、拟态词不留假名、不生硬音译，换成自然的中文表达或对声音与感觉的描写。
8. 译文里不留任何假名。引号、括号等标点的样式照原文保留。`;

export const GLOSSARY_HEAD = '译名表（表里有的必须照用，不得换成别的译法）';
export const PLACEHOLDER_NOTE = '形如 ⟦1⟧ 的记号原样保留在译文中对应的位置，不翻译、不增删';

const FORMAT_RULES = `格式约定：
- 用户消息里是带编号的段落，每段以独占一行的 [[n]] 开头，下面是这一段的原文。
- 按同样的 [[n]] 编号逐段交回译文：编号独占一行，下一行起是这一段的译文。
- 一个编号对应一段，不合并、不拆分、不漏段，不加任何说明、注释或标题。`;

/** 当前生效的译法:用户没改(空)就用默认。 */
export const effectivePrompt = (custom) => (String(custom ?? '').trim() ? String(custom).trim() : DEFAULT_PROMPT);

/**
 * 系统提示词 = 译法 + 译名表节(表空则整节不出现)+ 格式约定(+ 有占位符时的说明)。
 * glossary: [{ src, dst }],应已按本批文字筛过。
 */
export function buildSystemPrompt(promptText, glossary, { placeholders = false } = {}) {
    const parts = [effectivePrompt(promptText)];
    if (glossary?.length) parts.push(`${GLOSSARY_HEAD}：\n${glossary.map(g => `${g.src} = ${g.dst}`).join('\n')}`);
    parts.push(placeholders ? `${FORMAT_RULES}\n- ${PLACEHOLDER_NOTE}。` : FORMAT_RULES);
    return parts.join('\n\n');
}

/** 用户消息:[[1]]\n第一段\n[[2]]\n第二段 …… texts 是送翻的(已换占位符的)段落文字。 */
export function buildUserMessage(texts) {
    return texts.map((t, i) => `[[${i + 1}]]\n${t}`).join('\n');
}
