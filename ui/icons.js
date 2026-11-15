// 图标全部内联 SVG,线稿用 currentColor 描边,跟随文字颜色。禁 emoji、禁渐变。

const S = (inner, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${inner}</svg>`;

// 两层错开的纸页:同一段文字的两个视角
export const ICON_MENU = S('<rect x="3.5" y="3.5" width="12" height="12" rx="2"/><path d="M8.5 19.5v.5a.5.5 0 0 0 .5.5h10a1.5 1.5 0 0 0 1.5-1.5V9a.5.5 0 0 0-.5-.5h-.5"/><path d="M6.5 7.5h6M6.5 10.5h6M6.5 13.5h3.5"/>');
// 每楼按钮:左「A」右「文」的简笔
export const ICON_FLOOR = S('<path d="M3 17 6.5 7l3.5 10M4.3 13.5h4.4"/><path d="M14 8.5h7M17.5 6.5v2M15 11.5c1 2.6 3 4.6 6 5.5M20 11.5c-1 2.6-3 4.6-6 5.5"/>');
export const ICON_CLOSE = S('<path d="M6 6l12 12M18 6L6 18"/>', 'stroke-width="2"');
export const ICON_HOME = S('<path d="M4 11.5 12 4l8 7.5"/><path d="M6 10v9.5h4.5v-5h3v5H18V10"/>');
export const ICON_BOOK = S('<path d="M12 6.5C10 5 7 4.6 4 5v13c3-.4 6 0 8 1.5 2-1.5 5-1.9 8-1.5V5c-3-.4-6 0-8 1.5Z"/><path d="M12 6.5v13"/>');
export const ICON_GEAR = S('<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4 18 18M18 6l-1.6 1.6M7.6 16.4 6 18"/>');
export const ICON_REFRESH = S('<path d="M20 5v5h-5"/><path d="M19.5 10A8 8 0 1 0 20 13"/>');
export const ICON_TRASH = S('<path d="M5 7h14M10 7V4.5h4V7M7 7l.8 12h8.4L17 7"/>');
export const ICON_EYE = S('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/>');
export const ICON_PLAY = S('<path d="M8 5.5v13l10-6.5-10-6.5Z"/>');
export const ICON_PATCH = S('<path d="M5 12h14M12 5v14"/>');
export const ICON_SCAN = S('<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><path d="M8 12h8"/>');
export const ICON_UNDO = S('<path d="M8 8H4V4"/><path d="M4 8c1.8-2.6 4.6-4 8-4 4.8 0 8 3.4 8 8s-3.2 8-8 8c-3.2 0-5.8-1.4-7.4-3.6"/>');
export const ICON_DOWNLOAD = S('<path d="M12 4v11M7.5 11 12 15.5 16.5 11"/><path d="M5 19.5h14"/>');
// 标题前的小月牙
export const ICON_MOON = S('<path d="M19.5 14.6A8 8 0 0 1 9.4 4.5a8 8 0 1 0 10.1 10.1Z"/>');
// 恒星视差示意图:轨道弧上的两个观测点,各引一条视线汇到同一颗星
export const ART_PARALLAX = '<svg viewBox="0 0 150 34" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5Q1 17 9 29"/><circle cx="9" cy="5" r="2.4"/><circle cx="9" cy="29" r="2.4"/><path d="M11.4 5.4 133 16.6M11.4 28.6 133 17.4"/><path d="M139 10.5q.9 5.6 6.5 6.5-5.6.9-6.5 6.5-.9-5.6-6.5-6.5 5.6-.9 6.5-6.5Z"/></svg>';
// 月相一排:蛾眉、上弦、满月、下弦、残月(两头各两枚月牙)
const CRESCENT_L = 'a7 7 0 1 0 0 14 8.6 8.6 0 0 1 0-14Z';
const CRESCENT_R = 'a7 7 0 1 1 0 14 8.6 8.6 0 0 0 0-14Z';
export const ART_PHASES = `<svg viewBox="0 0 150 18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2${CRESCENT_L}M33 2${CRESCENT_L}M117 2${CRESCENT_R}M138 2${CRESCENT_R}"/><circle cx="54" cy="9" r="7"/><path d="M54 2v14"/><circle cx="75" cy="9" r="7"/><circle cx="96" cy="9" r="7"/><path d="M96 2v14"/></svg>`;
