// 内置译法提示词与请求格式。译法按原文语言各备一份,不开放给用户改;格式约定、译名表节、占位符说明由代码拼在后面。

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

const EN_PROMPT = `你是一位文学译者。把下面的小说正文译成简体中文。原文通常是英语。

译法：
1. 忠实原文：不添原文没有的形容词、比喻和夸张，也不删减。原文是平常话就译成平常话，不为了文气添成语和四字词。
2. 按中文的语序重新组织句子：从句和分号串起的长句可以拆成几个短句；后置的时间、伴随、原因状语按中文习惯挪到前面。只在一段之内调整。
3. 要避开的是翻译腔：不堆「的」字长定语，不滥用「被」字句，不把从句连词一律对成「当……时」「如果……的话」，中文里多余的代词、冠词和物主词省去。同时不往中文网络小说的腔调上靠，不用「一抹」「一丝」「不由得」这类套话。
4. 对话提示语的位置照原文（句首、句中、句末）。「说」类动词按语境译成说、问、答、喊等相称的动词；修饰它的副词按分量译，不逐个硬套「……地说」。
5. 口音、方言拼写和不规范的语法，不做成中文方言，也不故意写错字；人物的粗朴、腔调或教养，靠用词和语气来立。说话方式本身的特征（比如用名字自称、句句带敬称）照样保留。
6. 第二人称按关系与口吻译成「你」或「您」。称谓和敬称按关系换成自然的中文称呼。
7. 俚语、粗口、感叹语按语境找分量相当的中文说法，同一个词不必处处同译；习语译意思，不逐字直译。
8. 全大写表示的喊叫与强调不保留字形，用语气、用词和标点表现；牌匾、标题、书信里的文字按中文习惯处理。
9. 人名、地名等专有名词，译名表里没有的按通行译法音译，名与姓之间用间隔号「·」。译文里不留成句的英文。引号、括号等标点的样式照原文保留。`;

/** 支持的原文语言。glossaryHint = 译名表页上「什么最该填」的提示。加一种语言 = 这里加一项 + 下面加一份译法 + translate.js 里加一条「没翻成」的判据。 */
export const SOURCE_LANGS = [
    { id: 'ja', label: '日语', glossaryHint: '片假名、平假名的人名最需要填,例如「カガミ → 镜」。' },
    { id: 'en', label: '英语', glossaryHint: '人名、地名和自造的词最需要填,例如「Evelyn → 伊芙琳」。' },
];
const PROMPTS = { ja: DEFAULT_PROMPT, en: EN_PROMPT };
export const normalizeLang = (lang) => (SOURCE_LANGS.some(l => l.id === lang) ? lang : SOURCE_LANGS[0].id);
/** 这种原文语言的译法。 */
export const promptFor = (lang) => PROMPTS[normalizeLang(lang)];
/** 译名表页的提示,按原文语言取。 */
export const glossaryHintFor = (lang) => SOURCE_LANGS.find(l => l.id === normalizeLang(lang)).glossaryHint;

export const GLOSSARY_HEAD = '译名表（表里有的必须照用，不得换成别的译法）';
export const PLACEHOLDER_NOTE = '形如 ⟦1⟧ 的记号原样保留在译文中对应的位置，不翻译、不增删';

const FORMAT_RULES = `格式约定：
- 用户消息里是带编号的段落，每段以独占一行的 [[n]] 开头，下面是这一段的原文。
- 按同样的 [[n]] 编号逐段交回译文：编号独占一行，下一行起是这一段的译文。
- 一个编号对应一段，不合并、不拆分、不漏段，不加任何说明、注释或标题。
- 全部译文放在一对 <parallax_output> 和 </parallax_output> 标签之间：先写 <parallax_output>，再写各段译文，最后写 </parallax_output>。标签外不写任何内容。`;

/** 生效的译法:没给(空)就用日语那份。 */
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
