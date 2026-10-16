# v0.230.0 · 警大成绩「绩点排名情况」改成站点原版式（图标 UI）

> 归属说明：改动进 `public/plugins/cppu-notify/`（属「必须升版本」的目录），
> 随 v0.229.1 之后的 v0.230.0 发布（界面调整 → minor +1）。
> 校验：`node ../tools/sync-version.js --check` → ✓ 三端版本一致；`npm test` → 全部通过。
> 插件 `manifest.json` 1.55.5 → 1.56.0（`sync-version.js` 不管插件版本，手改 + 跑 `node tools/sync-plugins.js`）。

## 起因

用户对照 pdata 学生个人成长中心的「数据报告 · 学情」页后要求：
**「图标 ui 就按照他的这个来」** —— v0.220.1 那张「绩点排名情况」卡当初是我自己重排的
2×2 文字格，与站点原样不符，要照站点改成「左圆底图标 + 右数字/标签」。

## 站点原实现（从 `.tmp-probe/umi.js` 逆出，照抄依据）

DOM（模块 `hQL+`，偏移 7250708 / 7251620）：

```jsx
<div className="myRank">
  <div className="myRank_item">
    <div className="left"><img src={require("./qx.png")} /></div>
    <div className="right"><p>{QXPM}</p><p>全校排名</p></div>
  </div>
  … 学院 xy.png / 专业 zy.png / 班级 bj.png 同构
</div>
```

CSS（站点 `umi.css`）：

```css
.myRank        { display:flex; flex-wrap:wrap; width:76%; max-width:454px;
                 justify-content:space-between; align-items:center; margin:20px auto 0 }
.myRank_item   { width:160px; height:67px; display:flex; margin-bottom:40px }
.myRank_item .left     { width:65px; height:65px; background:#e8f4fc; border-radius:50%;
                         margin-right:20px; display:flex; align-items:center; justify-content:center }
.myRank_item .left img { width:36px; height:40px }
.myRank_item .right p:first-child { color:#2a7eff; font-size:20px; font-family:"HanSansCn" }
.myRank_item .right p:last-child  { color:#666; font-size:14px }
```

### 图标不是 `/static/*.png`，是内联 base64

`require.context` 模块 `9M5L` 把 `"./qx.png"` 映射到 file-loader 模块 id `ijyo`，
而这四个模块的 `module.exports` 就是 `"data:image/png;base64,…"` 字符串。
四张原图都是 **54×59**，PNG 体积 3758–4826 B。

压缩尝试与取舍：PNG8 32 色量化（1525–2044 B）**四张全部没过质量门**
（平均通道误差 > 3），WebP 有损同样掉质 ⇒ **保留原 PNG 内嵌**，base64 后
约 2 KB/张、合计约 8 KB，直接进 `main.js`。

## 改了什么

- `main.js` 新增常量 `const PDATA_RANK_ICONS = { qx, xy, zy, bj }`（四张 base64 data URI），
  由脚本 `.tmp-probe/inject_rank_icons.py` 幂等注入（重复运行先删旧块再插，避免手贴 8 KB base64）。
- `pdataRankCard()` 的条目结构由「`<small>` 标签 + `<b>` 数字」改成站点版式：

  ```html
  <div class="jg-rank-item">
    <span class="jg-rank-badge"><img src="data:image/png;base64,…" width="36" height="40" decoding="async" alt=""></span>
    <span class="jg-rank-right"><b class="jg-rank-num">6519</b><small>全校排名</small></span>
  </div>
  ```

- CSS：`.jg-rank-item` 从纵向堆叠改成 `display:flex; align-items:center; gap:12px`；
  新增 `.jg-rank-badge`（60 px 圆、`#e8f4fc` 底、居中）、`.jg-rank-badge img`（34×38）、
  `.jg-rank-right`、`.jg-rank-num`（`#2a7eff`、`calc(20px * var(--ui-text-scale))`、600 字重）。
  深色模式：`.jg-rank-badge{background:rgba(42,126,255,.16)}`、`.jg-rank-num{color:#7CB6FF}`。
  网格间距放宽到 `gap:12px 8px`，数字 5 位（全校 6519）不再挤。
- `scripts/test-cppu.mjs` 补断言：源码含 `const PDATA_RANK_ICONS = {`；
  渲染结果含 `jg-rank-badge` 与 `data:image/png;base64,`；
  并逐档钉住站点结构 `<b class="jg-rank-num">6519</b><small>全校排名</small>`
  （622 学院 / 145 专业 / 30 班级同理）。

## 验证

- `node --check public/plugins/cppu-notify/main.js` → SYNTAX OK
- `node scripts/test-cppu.mjs` → PASS
- `npm test` → 139 个测试脚本全部通过
- 几何核对（无头 Chrome 真 CSS + 真实值种子，`.workbuddy/before/render-credit.mjs`）：
  浅色下 `.jg-rank-badge` 的 `#e8f4fc` 圆底实测 **4 个**、每个约 60×60，四张 `<img>`
  均自然宽度 54 / 显示 34×38 且加载完成（`complete=true`）；390 px 窄屏下四档仍为 2×2 不溢出。
- 视觉对照图：`output/preview/rankcard-vs-site.png`（左站点截图裁切 / 右插件渲染）、
  `output/preview/rankcard-light-vs-dark.png`（浅色 / 深色并排）、
  `output/preview/cards390-{light,dark}.png`（390 px 窄屏）。

## 边界

- 站点原图是**位图**（54×59 PNG），插件里按 34×38 显示，高 DPI 屏会比 SVG 略软 ——
  为了「与原站一模一样」刻意不做矢量化，也不换 U-Time 自己的图标语言。
- 站点的 `#2a7eff` 数字色是硬编码；插件里浅色沿用该值、深色换 `#7CB6FF`，
  不跟随主题令牌（这是站点色，不是应用语义色）。
