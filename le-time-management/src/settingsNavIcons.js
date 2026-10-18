/**
 * 设置分类的线性图标集（24×24 描边风格）。
 *
 * 为什么不用打包里的 Font Awesome：`.settings-nav-ico` 原先取的是 **solid 实体字**，
 * 13px 下是一团实心块，颜色只能整块填充、没法做「细描边 + 随文字色」的层级感。
 * 导航栏要的是后者，所以这里自绘：零依赖、可离线、只用基础图元，测试能直接断言。
 *
 * 每个图标 = `[标签, 属性]` 列表；`stroke` 系列属性由 createSettingsNavIcon 统一注入，
 * 所以这里**只写几何**。坐标按 24×24 网格手工推算，半径/弧向都已核对过。
 *
 * 新增分类时：往 SETTINGS_NAV_ICONS 加一条；名字对不上会落到 `gear` 兜底，不会开天窗。
 */
const SVG_NS = "http://www.w3.org/2000/svg";

/** 描边风格：细线 + 圆头圆角，与导航栏文字同级重量。 */
const STROKE_WIDTH = "1.7";

export const SETTINGS_NAV_ICONS = {
  // 任务与排程：三根滑杆（调参 → 默认值 / 排程规则）
  sliders: [
    ["path", { d: "M4 7h16M4 12h16M4 17h16" }],
    ["circle", { cx: "9", cy: "7", r: "2.1" }],
    ["circle", { cx: "15", cy: "12", r: "2.1" }],
    ["circle", { cx: "7", cy: "17", r: "2.1" }],
  ],
  // 界面与交互：带顶栏与侧栏的窗口（布局）
  "layout-panel": [
    ["rect", { x: "3", y: "4.5", width: "18", height: "15", rx: "2.6" }],
    ["path", { d: "M3 9.4h18M9.4 9.4v10.1" }],
  ],
  // 主题：调色板（外盘 + 三个颜料孔）
  palette: [
    ["circle", { cx: "12", cy: "12", r: "9" }],
    ["circle", { cx: "8.4", cy: "9.6", r: "1.15" }],
    ["circle", { cx: "12", cy: "7.6", r: "1.15" }],
    ["circle", { cx: "15.6", cy: "9.6", r: "1.15" }],
  ],
  // 关键词标注：荧光笔（斜笔身 + 笔尖分割线）
  highlighter: [
    ["path", { d: "M15.6 4.4 4.6 15.4V19.4h4L19.6 8.4a2.8 2.8 0 0 0-4-4Z" }],
    ["path", { d: "M13.4 6.6 17.4 10.6" }],
  ],
  // 任务提醒：铃铛
  bell: [
    ["path", { d: "M18 8.6a6 6 0 0 0-12 0c0 6.4-2.7 8.4-2.7 8.4h17.4c0 0-2.7-1.7-2.7-8.4Z" }],
    ["path", { d: "M13.9 20.6a2.2 2.2 0 0 1-3.8 0" }],
  ],
  // 数据中心：三层圆柱
  database: [
    ["ellipse", { cx: "12", cy: "5.6", rx: "8", ry: "3" }],
    ["path", { d: "M4 5.6V12c0 1.7 3.6 3 8 3s8-1.3 8-3V5.6" }],
    ["path", { d: "M4 12v6.4c0 1.7 3.6 3 8 3s8-1.3 8-3V12" }],
  ],
  // 可选同步：云 + 云内上箭头
  "cloud-arrow-up": [
    ["path", { d: "M17.4 17.6h-8a6.2 6.2 0 1 1 5.9-8h2.1a4.1 4.1 0 0 1 0 8Z" }],
    ["path", { d: "M12 16.6v-6.4m-2.4 2.4L12 10.2l2.4 2.4" }],
  ],
  // AI 与自动任务：魔杖 + 星
  "wand-magic-sparkles": [
    ["path", { d: "M3.6 20.4 14.4 9.6" }],
    ["path", { d: "M17 3.2 18.1 6.1 21 7.2 18.1 8.3 17 11.2 15.9 8.3 13 7.2 15.9 6.1Z" }],
    ["circle", { cx: "8.6", cy: "6", r: "1.05" }],
  ],
  // 全局快捷键：键盘
  keyboard: [
    ["path", { d: "M3 6.6a2.4 2.4 0 0 1 2.4-2.4h13.2A2.4 2.4 0 0 1 21 6.6v10.8a2.4 2.4 0 0 1-2.4 2.4H5.4A2.4 2.4 0 0 1 3 17.4Z" }],
    ["path", { d: "M6.6 9h.01M10 9h.01M13.4 9h.01M16.8 9h.01" }],
    ["path", { d: "M7.4 13.6h9.2" }],
  ],
  // 局域网联动：三节点互连（share-2 语义）
  "network-wired": [
    ["circle", { cx: "18", cy: "5.2", r: "2.6" }],
    ["circle", { cx: "6", cy: "12", r: "2.6" }],
    ["circle", { cx: "18", cy: "18.8", r: "2.6" }],
    ["path", { d: "M8.3 10.7 15.7 6.5M8.3 13.3 15.7 17.5" }],
  ],
  // 插件管理：拼图块（右侧带一个凸头）
  "puzzle-piece": [
    ["path", { d: "M6.3 5h7.4a1.8 1.8 0 0 1 1.8 1.8v2.2a2.6 2.6 0 1 1 0 5.2v2a1.8 1.8 0 0 1-1.8 1.8H6.3A1.8 1.8 0 0 1 4.5 16.2V6.8A1.8 1.8 0 0 1 6.3 5Z" }],
  ],
  // 警大登录设置（兜底也用这个）：齿轮
  gear: [
    ["circle", { cx: "12", cy: "12", r: "3.4" }],
    ["path", { d: "M12 2.6v2.6M12 18.8v2.6M2.6 12h2.6M18.8 12h2.6M5.4 5.4l1.9 1.9M16.7 16.7l1.9 1.9M18.6 5.4l-1.9 1.9M7.3 16.7l-1.9 1.9" }],
  ],
  // 赞助支持：咖啡杯 + 两缕热气（「请作者喝杯咖啡」）
  "mug-hot": [
    ["path", { d: "M6 9.4h8.4v5.2a4.2 4.2 0 0 1-4.2 4.2 4.2 4.2 0 0 1-4.2-4.2Z" }],
    ["path", { d: "M14.4 11.2h1.5a2.3 2.3 0 0 1 0 4.6h-1.5" }],
    ["path", { d: "M7.9 6.6c.8-.8.8-1.7 0-2.5" }],
    ["path", { d: "M11.5 6.6c.8-.8.8-1.7 0-2.5" }],
    ["path", { d: "M4.8 21.4h10.8" }],
  ],
  // 警大获奖名单：奖杯
  trophy: [
    ["path", { d: "M8 3.6h8V9a4 4 0 0 1-8 0Z" }],
    ["path", { d: "M8 5.6H6.3a2.3 2.3 0 0 0 0 4.6H8" }],
    ["path", { d: "M16 5.6h1.7a2.3 2.3 0 0 1 0 4.6H16" }],
    ["path", { d: "M12 13v4" }],
    ["path", { d: "M9.2 17h5.6l.8 3.4H8.4Z" }],
  ],
  // 测试：手机 + 底部按键
  "mobile-screen-button": [
    ["path", { d: "M7 2.8h10A2.2 2.2 0 0 1 19.2 5v14a2.2 2.2 0 0 1-2.2 2.2H7A2.2 2.2 0 0 1 4.8 19V5A2.2 2.2 0 0 1 7 2.8Z" }],
    ["path", { d: "M10.4 5.6h3.2" }],
    ["path", { d: "M12 18.4h.01" }],
  ],
  // 隐私展示：盾牌 + 被遮住的人脸（展示模式 = 遮住私人信息）
  "user-shield": [
    ["path", { d: "M12 2.8 20 5.6v6c0 4.5-3.4 8.3-8 9.6-4.6-1.3-8-5.1-8-9.6v-6Z" }],
    ["circle", { cx: "12", cy: "9.4", r: "2.1" }],
    ["path", { d: "M8.6 15.6a3.6 3.6 0 0 1 6.8 0" }],
    ["path", { d: "M8.2 10.9 15.8 10.9" }],
  ],
  // 关于：圆 + i
  "circle-info": [
    ["path", { d: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z" }],
    ["path", { d: "M12 11.2v5.2" }],
    ["path", { d: "M12 7.8h.01" }],
  ],
};

/** 名字是否在表里 —— 测试守卫用，避免「加了分类忘了配图标」这种事静默发生。 */
export const hasSettingsNavIcon = (name) => Object.prototype.hasOwnProperty.call(SETTINGS_NAV_ICONS, name);

/** 供测试遍历：表里现有多少个图标名。 */
export const settingsNavIconNames = () => Object.keys(SETTINGS_NAV_ICONS);

/**
 * 造一个线性图标节点。名字不认识时落到 `gear`（宁可给个通用齿轮，也不要留一格空白）。
 * @param {string} name SETTINGS_NAV_ICONS 里的键，或 settingEntries 的 entry.icon
 * @param {Document} [doc] 便于测试注入替身
 */
export function createSettingsNavIcon(name, doc = document) {
  const shapes = SETTINGS_NAV_ICONS[name] || SETTINGS_NAV_ICONS.gear;
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "settings-nav-glyph");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  // 描边属性挂在 svg 上，形状自身只带几何 —— 换风格只要改这三行。
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", STROKE_WIDTH);
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const [tag, attrs] of shapes) {
    const node = doc.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    svg.append(node);
  }
  return svg;
}
