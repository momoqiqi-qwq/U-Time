import { readProductSource } from "./lib/read-product-source.mjs";
import assert from "node:assert/strict";

/* v0.286.1 · 多入口卡片的高度按内容自适应
   背景：卡片高度是用户拖动出来的**一个像素值**（--market-card-h，全体共用），
   而入口胶囊的行数取决于插件自己注册了几个视图（cppu-notify 注册 13 个）。
   高度写死 + overflow:hidden ⇒ 入口多的卡片必裁内容（v0.286.0 实测第二行被切掉）。

   守三条，缺一条这个 bug 就回来了：
   ① has-views 卡片在桌面断点把 height 交回内容，拖动值降为 min-height（下限）；
   ② 普通卡片的 `height: var(--market-card-h)` 与 overflow:hidden 一个字不动
      —— v0.214.3 修的「往下拖时卡片跟手缩小」靠的就是它；
   ③ 窄屏仍由 .market-manage-card 的 height:auto 接管（紧凑列表不该被桌面像素高度裁）。 */

const styles = readProductSource(new URL("../src/styles.css", import.meta.url), "utf8");
const shell = readProductSource(new URL("../src/shell.js", import.meta.url), "utf8");
// 先剥注释再压空白：注释里会写 `.market-manage-card{height:auto}` 这类带花括号的例子，
// 不剥会把「规则体」截断在注释里的 `}` 上。
const flat = styles.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\s+/g, " ");

// ① 桌面端 has-views 规则（选择器必须比 .mcard 高，才不会被后面 900px 之前的规则压回去）
assert.ok(
  flat.includes(".market-grid .mcard.has-views { height: auto; min-height: var(--market-card-h, auto); }"),
  "桌面端必须有 `.market-grid .mcard.has-views { height: auto; min-height: var(--market-card-h, auto) }`："
    + "入口胶囊换行后卡片要跟着长高，拖动值只当下限",
);
const fitRule = /@media \(min-width: 901px\) \{ \.market-grid \.mcard\.has-views \{[^}]*\}/.exec(flat);
assert.ok(fitRule, "自适应规则要写在 min-width: 901px 里（窄屏另有紧凑列表规则）");

// ② 普通卡片保持像素高度 + 裁切（拖动缩小的手感与防外溢都依赖这一条）
// 同一份表里 .mcard 有好几条（早期那条只有 will-change），按 height 声明定位到高度那条
const baseRule = /\.mcard \{[^}]*height: var\(--market-card-h, auto\);[^}]*\}/.exec(flat);
assert.ok(baseRule, "找不到 .mcard 的高度规则");
assert.match(baseRule[0], /height: var\(--market-card-h, auto\);/, "普通卡片的 height 必须仍是 --market-card-h");
assert.match(baseRule[0], /overflow: hidden;/, "普通卡片必须保留 overflow:hidden，否则内容外溢到隔壁卡片");

// ③ 窄屏兜底没被删
assert.match(
  flat,
  /@media \(max-width: 900px\) \{.*?\.market-manage-card \{[^}]*?height: auto;/,
  "窄屏 .market-manage-card 必须保留 height:auto",
);

// 类名按入口数量实时同步（插件注册视图是异步的，创建时可能还是 0 个入口）
assert.match(shell, /cardViews\.length > 1 \? " has-views" : ""/, "卡片创建时要按入口数量挂 has-views");
assert.match(shell, /classList\.toggle\("has-views", views\.length > 1\)/, "入口数量变化后要重新同步 has-views");

console.log("✓ 插件中心：多入口卡片高度按内容自适应，普通卡片仍听拖动值");
