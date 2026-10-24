# v0.280.0 · 隐私模式补属性面：`title` / `aria-label` / `alt` 里的真名也要遮

> 接 v0.279.0。那一版用 `[data-private-text]` + `filter: blur()` 把身份字段糊掉了，
> 但**只糊了文字节点**。鼠标停在名字上、读屏念出按钮、图片加载失败时的替代文本 ——
> 这三条路径都走属性，CSS 一个字都碰不到。

## 一、CSS 的能力边界正好卡在这

`filter: blur()` 作用于**元素的渲染结果**，而 `title=` / `aria-label=` / `alt=` 是**属性**：

| 属性 | 什么时候被看见 | 里面写什么 |
|---|---|---|
| `title` | 鼠标悬停 1 秒后浮出的提示框 | 常常是「给 梁逸乐 改名」这种带名字的文案 |
| `aria-label` | 读屏器直接念出来 | 同上，且它是无障碍场景下**唯一**被念的内容 |
| `alt` | 图片加载失败 / 读屏 | 头像的 alt 常直接写人名 |

所以第五条要在属性面再走一遍：**同一个跳过区范围内的属性，换成固定串 `已隐藏`**。

## 二、实现：与文本同一套保存 / 还原纪律

```js
const PRIVATE_ATTRS = ["title", "aria-label", "alt"];
const ATTR_MASK_TEXT = "已隐藏";
const ATTR_RECORDS = new WeakMap();   // 元素 → { title: 原值, ... }
```

三条硬约束，抄的是文本那套（`NODE_TEXT` / `LIVE_NODES`）：

1. **记原值再改**，还原时逐属性比对「现在是不是还等于 `已隐藏`」。
   应用自己改过的（比如按钮在别处被重新设置了 label）**绝不盖回去** —— 否则关掉模式
   会把新文案冲成旧文案。
2. **`WeakMap` + `Set` 双份**：`WeakMap` 让卸载的 DOM 能被回收，`Set` 提供可迭代的
   还原名单。与 `LIVE_NODES` 同一个理由。
3. **不改 `textContent`**：属性与文字是两条线，改了文字等于绕过 CSS 那层。

### 挂在哪：holder 自己 + 它所在的可交互容器

```js
for (const holder of scope.querySelectorAll("[data-private-text],[data-private-face]")) {
  hosts.add(holder);
  const owner = holder.closest("button,a,label,summary");   // ← 关键的一句
  if (owner) hosts.add(owner);
}
```

只认 holder 会漏掉最常见的一种写法：名字在 `<span>` 里，但「给 X 改名」的 `aria-label`
挂在外层 `<button>` 上（`dorm-duty` 的床位牌就是）。向上只走到
`button / a / label / summary` 这四类可交互标签就停 —— 再往上会摸到页面容器，
把与这个内容无关的 `title` 一起换掉。

### 接线点：两处，不能只做一处

| 时机 | 调用 | 为什么 |
|---|---|---|
| 打开模式 | `applyPrivacyMask()` → `maskPrivateAttrs(document)` | 首屏 |
| 之后每批新节点 | `scan(root)` 开头 | 翻页 / 切分组都是重画 DOM，只做首屏等于只遮了第一页 |

`scan()` 是 MutationObserver 与 1.2s 兜底全量重扫的共同入口，挂在这里两点一起覆盖。

## 三、边界

- **属性遮蔽是「换字」不是「糊」**：`title` 就没法糊（它是浏览器画的浮层），
  只能整串换掉，所以关掉模式靠记录还原 —— 这也是为什么必须记原值。
- **`data-*` 属性不处理**：那是给代码读的，不是给人看的。
- **剪贴板仍是原值**：复制名字拿到的还是真名，剪贴板不属「屏幕显示」。
- **登录表单里的账号**：`FORM_SELECTOR` 整棵跳过，属「输入中」不属展示数据。

## 影响面

- 三端全量（桌面 / Android / 小程序），逻辑都在 `src/privacyMask.js`，无平台分支。
- **无数据迁移**：只多了一张元素 → 属性原值的映射表，进程内有效、关掉即清。
- 关掉模式后属性写回原值；DOM 已被重建的那些元素随卸载一起消失，不留痕迹。
