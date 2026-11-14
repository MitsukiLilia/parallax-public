// 全局设置(extensionSettings.parallax)。读取时归一化:缺项补默认值,不整份深拷贝(保持酒馆持有的同一个对象)。

export const SETTINGS_KEY = 'parallax';

export const DEFAULT_SETTINGS = {
    enabled: true,
    auto: true,
    batchChars: 6000,
    prompt: '',              // 空 = 用默认译法
    presets: {},             // { <预设名>: { tags: [...] } }
    glossary: { common: '', chars: {} }, // chars: { <角色卡键>: '...' }
    profileId: '',
    customApi: { enabled: false, baseUrl: '', apiKey: '', model: '' },
};

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

export function getSettings(ctx) {
    const store = ctx.extensionSettings;
    let cur = store[SETTINGS_KEY];
    if (!isObj(cur)) cur = store[SETTINGS_KEY] = {};
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (cur[k] === undefined) {
            const d = DEFAULT_SETTINGS[k];
            cur[k] = isObj(d) ? structuredClone(d) : d;
        }
    }
    if (!isObj(cur.presets)) cur.presets = {};
    if (!isObj(cur.glossary)) cur.glossary = { common: '', chars: {} };
    if (typeof cur.glossary.common !== 'string') cur.glossary.common = '';
    if (!isObj(cur.glossary.chars)) cur.glossary.chars = {};
    if (!isObj(cur.customApi)) cur.customApi = { ...DEFAULT_SETTINGS.customApi };
    for (const k of Object.keys(DEFAULT_SETTINGS.customApi)) {
        if (cur.customApi[k] === undefined) cur.customApi[k] = DEFAULT_SETTINGS.customApi[k];
    }
    const n = Math.floor(Number(cur.batchChars));
    cur.batchChars = Number.isFinite(n) && n >= 200 ? n : DEFAULT_SETTINGS.batchChars;
    return cur;
}

export function saveSettings(ctx) {
    ctx.saveSettingsDebounced?.();
}

// ── 与当前环境相关的取值 ──

/** 当前预设名;取不到返回 ''(这时标签勾选记在空名下,等同一份「无预设」配置)。 */
export function currentPresetName(ctx) {
    try { return String(ctx.getPresetManager?.()?.getSelectedPresetName?.() ?? ''); } catch { return ''; }
}

/** 本预设勾选的标签;未配置 = []。 */
export function presetTags(ctx, s = getSettings(ctx)) {
    const p = s.presets[currentPresetName(ctx)];
    return Array.isArray(p?.tags) ? p.tags.filter(t => typeof t === 'string' && t.trim()) : [];
}

/** 当前角色卡:{ key, name };群聊或没打开角色时返回 null。 */
export function currentCharacter(ctx) {
    if (ctx.groupId) return null;
    const ch = ctx.characters?.[ctx.characterId];
    if (!ch?.avatar) return null;
    return { key: String(ch.avatar), name: String(ch.name || ch.avatar) };
}
