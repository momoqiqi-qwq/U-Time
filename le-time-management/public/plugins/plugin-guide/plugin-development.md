# U-Time · 插件开发文档

> 适用于 U-Time v0.121.0 的 Windows / Android Tauri 插件宿主。`permissions` 是运行时权限闸门：调用未声明的能力时宿主直接抛错。

## 1. 最小插件结构

```text
my-plugin/
├─ manifest.json
└─ main.js
```

`manifest.json` 示例：

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "0.1.0",
  "author": "you",
  "icon": "puzzle-piece",
  "description": "一句话说明插件用途",
  "permissions": ["ui", "tasks", "blocks", "storage", "notify", "events", "http", "openUrl", "timeParse"],
  "entry": "main.js"
}
```

建议：`id` 只使用小写英文字母、数字和短横线；版本号使用语义化版本格式；`description` 直接说明“解决什么问题”。

内置插件的 manifest 还有两个宿主侧字段（外部插件不需要）：`order` 决定侧栏与加载顺序，`platforms` 声明 `windows / android / miniprogram` 三端的可用级别；两者都由 `node tools/sync-plugins.js` 校验。仓库 `public/plugins/` 下任意内置插件的 manifest 都是真实范例。

## 2. 安装与调试

### ZIP 导入

1. 将插件目录打包成 ZIP，确保 ZIP 内直接包含插件目录或插件文件。
2. 打开 **设置 → 插件 → 导入插件**。
3. 导入后检查插件卡片是否显示名称、版本与启用状态。
4. 若插件注册了页面，启用后会出现在应用导航中。

### 文件夹调试

把插件文件夹放到 **设置 → 数据** 所显示的数据目录下的 `plugins/` 子目录，然后在设置页重新扫描插件。

> Android 端对外部插件目录扫描能力有限，优先使用内置插件或 ZIP 导入流程。

## 3. `tide` API 速览

插件入口在函数环境中执行，主程序向入口注入 `tide` 对象。

```js
tide.ui.registerView({
  id: "my-view",
  title: "我的页面",
  icon: "puzzle-piece",
  render(el) {
    el.textContent = "Hello U-Time";
  },
});
```

### 任务

```js
const tasks = tide.tasks.list();
const task = tide.tasks.create({ title: "新任务", quad: 2 });
tide.tasks.update(task.id, { tags: ["插件"] });
tide.tasks.remove(task.id);
```

### 时间块

```js
const blocks = tide.blocks.list("2026-09-11");
const block = tide.blocks.create({
  date: "2026-09-11",
  start: "10:00",
  durMin: 45,
  title: "阅读",
});
tide.blocks.update(block.id, { durMin: 60 });
tide.blocks.remove(block.id);
```

### 插件私有存储

```js
await tide.storage.set("count", 1);
const count = await tide.storage.get("count", 0);
```

### 插件资源

```js
const cfg = await tide.assets.json("data/config.json");
const text = await tide.assets.text("README.txt");
// 把文本真正保存到系统下载目录（重名自动加序号），返回落盘的完整路径
const path = await tide.assets.saveText("导出说明.md", text);
// 二进制同理：base64 直接喂进来，不要拼 data: URI 用 <a download>（WebView 里会静默失败）
const blob = await tide.http.fetch(sid, "GET", fileUrl, { binary: true });
const saved = await tide.assets.saveBase64("附件.docx", blob.body);
```

资源路径必须是插件目录内的相对路径，不能使用绝对路径或 `..`。
`saveText` / `saveBase64` 需要 `ui` 权限；平台没有下载目录时保存到应用数据目录。

### 通知与事件

```js
tide.notify("操作完成");

tide.events.on("pomodoro:finished", (payload) => {
  console.log(payload);
});

tide.events.emit("my-plugin:changed", { ok: true });
```

消息类插件统一用 `notice:new` 广播新消息，载荷契约固定成这样（宿主会按这份契约抄收，字段名别自创）：

```js
tide.events.emit("notice:new", {
  source: "my-plugin",          // 插件 id
  sourceName: "我的消息源",      // 给人看的来源名
  total: 3,                     // 本次新到条数
  items: [{ title: "…", time: "09-23 14:00", sender: "…" }],
});
```

### 发布现有消息与读取汇总

```js
tide.messages.publish([
  { title: "期末考试安排", time: "2026-09-28 08:00", sender: "教务处" },
]);
const list = tide.messages.list(30); // [{ source, sourceName, title, time, sender, at }]
```

`publish` 供消息类插件在加载缓存和刷新后公开**当前列表的摘要**，传空数组即清空该插件先前发布的列表；需声明 `events` 权限。来源 id 由宿主固定为发布插件，不能伪装其他插件；只接受标题、时间、发送者和可选的来源名称，不开放插件私有存储或登录信息。`publish` 不代表“刚收到新消息”，不会触发 `notice:new` 订阅者或微信推送。

任何插件 `emit("notice:new", …)` 时，宿主仍会抄收新消息。`list` 合并新消息与各插件当前公开的摘要，按 `source|time|title` 去重、最多返回 120 条；需声明 `messages` 权限。两条边界要清楚：

- 宿主汇总**只在本次运行期**，重启即空 —— 原始事实仍在各插件自己的存储里；需要跨重启留存的调用方可自行保存汇总（AI 对话插件会这么做）。
- 抄收发生在 `emit` 那一刻，与谁在监听无关；所以晚加载的插件也读得到早加载插件在启动阶段广播的消息，不必自己去 `events.on` 蹲。

### 网络请求

```js
const res = await tide.http.get("https://api.example.com/list");
```

需要 Cookie 会话时：

```js
const sid = await tide.http.session();
await tide.http.fetch(sid, "POST", "https://example.com/login", {
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: "username=a&password=b",
});
const feed = await tide.http.fetch(sid, "GET", "https://example.com/feed");
```

仅支持 `http/https`。

### AI 对话

```js
const st = await tide.ai.status();            // { configured, baseUrl, model, keyMasked }
if (st.configured) {
  const text = await tide.ai.chat([
    { role: "system", content: "只回一句话" },
    { role: "user", content: "把这段摘要成一句" },
  ], { temperature: 0.3 });
}
```

复用「设置 → AI 与自动任务」里用户自己配置的 Base URL / 模型 / API Key（OpenAI 兼容的 `/chat/completions`），密钥只存在 Rust 侧加密保险箱，插件拿不到也看不到。三条限制：

- **非流式**：一次请求返回整段文本，"正在思考"这类等待态由插件自己画；上游总超时 55 秒。
- 一次最多 **24 条消息**、文本总量 **60000 字符**，超了直接抛中文错误。上下文裁剪是调用方的事，宿主不会替插件偷偷删消息。
- `status().configured` 为假时别发请求，先把用户引去配置：
  `window.dispatchEvent(new CustomEvent("tide:open-settings", { detail: { section: "ai" } }))`。

### 工具

```js
tide.util.openUrl("https://example.com");
const parsed = tide.util.parseWhen("明天下午3点到4点 讨论开题");
const cat = tide.util.guessCategory("跑步 30 分钟");
const quad = tide.util.guessQuad("2026-09-12");
tide.util.navigate("timeblock");
```

## 4. 插件页面规范与建议

### 4.1 返回按钮（硬性要求）

**每个插件注册的视图页面必须提供明显的返回按钮，点击后返回上一页。** 这不是建议，是上架/导入插件的门槛：

- 插件内部有多级子页面时，插件自己维护页面栈，返回按钮回退到上一级子页面；首页顶部如需提供返回（例如从其他视图跳转而来），点击应回到跳转来源视图。
- 插件通过 `tide.util.navigate()` 跳到应用其他视图之前，先记录来源视图，返回按钮用 `tide.util.navigate("<来源视图>")` 送用户回去。
- 返回按钮固定在页面顶部显眼位置（手机端尤其重要），不要藏在折叠菜单或长列表底部。
- 没有返回按钮、或点击后无法回退的插件页面，视为不合规。

参考实现（页面栈 + 顶部返回按钮）：

```js
tide.ui.registerView({
  id: "my-view",
  title: "我的页面",
  render(el) {
    const stack = []; // 插件内部页面栈
    const show = (renderPage) => {
      el.textContent = "";
      const topbar = document.createElement("div");
      topbar.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:8px;";
      if (stack.length > 0) {
        const back = document.createElement("button");
        back.textContent = "← 返回";
        back.onclick = () => show(stack.pop());
        topbar.appendChild(back);
      }
      el.appendChild(topbar);
      el.appendChild(renderPage());
    };
    const home = () => {
      const page = document.createElement("div");
      const item = document.createElement("button");
      item.textContent = "打开详情";
      item.onclick = () => { stack.push(home); show(detail); };
      page.appendChild(item);
      return page;
    };
    const detail = () => {
      const page = document.createElement("div");
      page.textContent = "这是子页面，点上方「← 返回」回首页";
      return page;
    };
    show(home);
  },
});
```

跨视图跳转的返回（跳走前记下来源）：

```js
// 进入插件前用户停留在哪个视图，就记下来
let fromView = "quadrant";
// 需要把用户送去其他视图时：
function gotoTimeblock() {
  fromView = "quadrant"; // 或按实际情况记录
  tide.util.navigate("timeblock");
}
// 插件首页返回按钮：
backButton.onclick = () => tide.util.navigate(fromView);
```

### 4.2 安全区（硬性要求）

APK 上是全面屏：状态栏、导航栏、横屏时的前置摄像头挖孔都会盖在网页上面。**这块区域叫安全区**，插件界面压上去就是「标题被状态栏吃掉」「最后一行点不到」。

宿主已经把四条边统一垫在插件页外面了，所以：

| 你的界面 | 要做什么 |
|---|---|
| 正常画在 `render(el)` 给的容器里（包括整页滚动、吸底输入框） | **什么都不用做**，宿主负责 |
| 自己往 `document.body` 挂 `position:fixed` 的全屏遮罩 / 弹层 / 菜单 | 必须自己让开四条边，见下面的配方 |

对应的四个宿主变量（单位 px，由 Android 原生按真实 `WindowInsets` 注入）：

| 变量 | 含义 | 常见故障 |
|---|---|---|
| `--sat` | 顶部状态栏 | 标题、返回按钮压进状态栏 |
| `--sab` | 底部导航栏 | 最后一个按钮、吸底栏点不到 |
| `--sal` / `--sar` | 左 / 右（横屏挖孔、三键导航栏在侧边） | 横屏时内容被挖孔切掉 |

三条硬性禁令：

1. **禁止裸用 `env(safe-area-inset-*)`。** Android WebView 里它恒为 `0`，写了等于没写（AGENTS.md 铁律四）。必须写成 `var(--sat, env(safe-area-inset-top, 0px))` 这种**双路**形式：APK 走原生注入的变量，桌面与 iOS 走 `env()` 兜底。
2. **禁止给页面内容再垫一遍安全区。** 宿主已经垫过了，插件再对自己的容器加一次会**双重计算**（实测过：桌面端插件页底部因此凭空多出 86px 纯空白）。同理，不要为了"避开导航栏"去猜一个固定像素值。
3. **禁止假设 `100vh` / `innerHeight` 就是可视区。** 它们包含安全区，用它算高度会把内容算到导航栏底下。

> 为什么 `position:fixed` 是唯一的例外：fixed 元素的包含块是宿主内容区那个元素的 **padding box**，padding 划不出它的新边界 —— 所以浮层只能自己让开。（`scripts/test-plugin-safe-area.mjs` 会拦前两条，写错直接红。）

> **让开的边 = 你钉住的边。** 声明了 `bottom:` 就得让开 `--sab`，钉了 `inset:` 就是四条全让；只让底、不让左右是最典型的错法（课程表的个性化抽屉就这么漏过：竖屏看不出问题，横屏时挖孔压在滑杆上）。同理，用 `innerWidth` / `innerHeight` 算夹取边界时也要减掉安全区 —— 视口的边不等于可视区的边。

**配方 A：CSS 浮层**（遮罩 + 居中弹窗）

```css
/* 遮罩铺满整屏是对的，让内边距去吃安全区 */
.my-mask {
  position: fixed; inset: 0; z-index: 1900;
  display: flex; align-items: center; justify-content: center;
  padding: calc(16px + var(--sat, env(safe-area-inset-top, 0px)))
           calc(16px + var(--sar, env(safe-area-inset-right, 0px)))
           calc(16px + var(--sab, env(safe-area-inset-bottom, 0px)))
           calc(16px + var(--sal, env(safe-area-inset-left, 0px)));
}
/* 弹窗高度别用 82vh：vh 不扣安全区，弹窗会比可视区高，底边照样被导航栏压住 */
.my-dialog { max-height: min(82vh, 100%); overflow: auto; }
```

**配方 B：JS 按坐标定位的浮层**（右键菜单、跟随手指的气泡）

夹取边界时把安全区算进去，读法与宿主的 `bottomInsetPx()` 一致：

```js
const px = (v) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(v)) || 0;
const [sat, sab, sal, sar] = [px("--sat"), px("--sab"), px("--sal"), px("--sar")];
// 变量取不到时 parseFloat 出 NaN → 0，桌面端行为不变
const x = Math.max(8 + sal, Math.min(rawX, window.innerWidth - sar - MENU_W));
const y = Math.max(8 + sat, Math.min(rawY, window.innerHeight - sab - MENU_H));
```

**真机自检**：APK 装好后把手机转成横屏（挖孔跑到左侧）打开插件页，内容左边缘应留出挖孔宽度；再开一个弹层，确认它不压状态栏与导航栏。

### 4.3 其他建议

- 首屏先展示插件能做什么，再展示配置项。
- 登录类插件明确说明账号信息如何保存、是否落盘。
- 网络请求提供加载、失败、重试和空状态。
- 会产生任务或时间块的操作，在执行前明确说明影响范围。
- 不要把密钥、Cookie、Token 写进源码或示例仓库。

### 4.4 筛选菜单（Windows / APK）

分类、月份、学年、来源等筛选条件超过一项时，页面只常驻一个“筛选”按钮。宿主提供 `.plugin-filter-menu` 样式，用原生 `<details>` 就能展开下拉区域，不需要固定定位遮罩；已选条件仍由插件自己的状态管理和 `tide.storage` 保存。

```html
<details class="plugin-filter-menu">
  <summary>筛选</summary>
  <div class="plugin-filter-menu-panel">
    <label>分类 <select aria-label="筛选分类"><option>全部</option></select></label>
    <label>月份 <select aria-label="筛选月份"><option>全部</option></select></label>
  </div>
</details>
```

选择条件后同步更新列表、计数和按钮的“已设置”提示；列表重渲染时保留当前筛选状态。搜索输入框、刷新按钮及“添加源”等操作仍放在菜单外。使用 `<summary>` 的键盘与触屏开合能力，不用自建全屏遮罩；下拉内容在窄屏允许换行，避免把通知列表挤到多屏之后。内置实现可参考 `cppu-notify/main.js`、`gx-news/main.js` 和 `rss-reader/main.js`。

## 5. 安全说明

外部插件属于“受信任扩展”模型：插件代码在应用前端上下文中执行（`new Function` 注入 `tide`，不是安全隔离，代码可访问 `document` / `window`）。宿主侧的防线是**运行时权限闸门**——插件调用未在 `permissions` 声明的能力时直接抛错，但这是约束“插件作者声明要真实”，不是安全边界。只安装你自己编写、审核过或可信来源提供的插件 ZIP。不要把未知来源插件当作完全隔离的沙箱应用。

后续若需要面向公开插件市场，建议把第三方插件迁移到隔离 iframe / Worker / 独立 WebView，并通过消息桥暴露最小权限 API。

## 6. 发布前自检

- `manifest.json` 可被 JSON 解析。
- `id` 唯一且稳定。
- `entry` 文件存在。
- 所声明权限与实际能力一致。
- 每个插件页面都有返回按钮，点击后能正确返回上一页（子页面回上一级，跨视图跳转回来源视图）。
- 界面没有超出安全区：页内容不重复垫（宿主已垫），自建 `position:fixed` 浮层让开了 `--sat/--sab/--sal/--sar`，全文没有裸用 `env(safe-area-inset-*)`。跑 `node scripts/test-plugin-safe-area.mjs` 会自动拦这三条。
- 无硬编码密钥、账号、Cookie、上传私钥。
- 离线状态不会卡死页面。
- 失败信息对用户可读。
- 至少完成一次导入、启用、停用、重新扫描、导出测试。

## 7. 项目资源

- 项目仓库：https://github.com/momoqiqi-qwq/le-time-management
- 在线版手册：仓库 `docs/index.html`（GitHub Pages），内容与本文件同步维护
- 官方网站：https://YOUR-WEBSITE.example

> 官网地址为待配置占位符。请在发布前替换为你的真实网站域名。
