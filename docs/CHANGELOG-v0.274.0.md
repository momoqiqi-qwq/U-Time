# v0.274.0 · 返回不再把人甩回顶部

## 改了什么

只动渲染外壳（`src/shell.js` + 新增 `src/viewScroll.js`），三端同源，无数据迁移。

**根因。** `.view` 是**所有页面共用的同一个**滚动容器（插件页里还多一层 `.plugview` 自己滚）。
`switchTo` 里原来只有一句「换到别的视图就把 `scrollTop` 归零」—— 于是
「列表滚到一半 → 点进详情 / 换个插件 → 按返回」必然回到顶上。APK 上返回键是主要导航方式，
这个损失感知最强。

**现在按视图记账。** 切走之前 `remember(id)` 把外层 `.view` 与内层 `.plugview` 的偏移各存一份，
渲染完 `restore(id)` 放回去；**没记过的视图照旧从顶部开始**，不会把上一页的偏移带进新页面。
同一视图的「刷新重绘」（插件 refresh、插件注册表变化后回正）也走同一条路 —— 那条以前同样会把插件页弹回顶部。
只记本次会话：冷启动停在顶部是对的，持久化反而会把陈旧偏移套到新数据上。

**两个必须守住的细节**（写在 `src/viewScroll.js` 顶部）：

- `styles.css` 给 `.view` 定了 `scroll-behavior: smooth`，直接赋值 `scrollTop` 会**缓慢滚**。
  恢复期间临时把内联 `scroll-behavior` 压成 `auto`，写完立刻删掉 —— 返回是瞬移，不是从顶部滑下来。
- 插件页内容是异步到的，赋值那一刻 `scrollHeight` 可能还不够高，浏览器会把偏移截断成 0。
  所以恢复 = 「立刻赋值 + 若干次重试」（前 ~16 帧走 rAF，之后 60ms 一次，共约 2s）。
  内容姗姗来迟也能追到位；**用户在这段时间里触摸 / 滚轮 / 按键就立刻收手**，不跟人抢滚动条。

## 回归断言

`scripts/test-view-scroll.mjs`（新增，进 `npm test`）：静态接线（remember 必须在 `replaceChildren` 之前、
restore 在渲染之后、旧的硬归零已撤掉）+ 用假滚动容器把重试逻辑真跑起来：

- 首次进入归零、不排重试、不挂手势监听
- 滚到 800 → 换页（新页为 0）→ 回来仍是 800
- 内容变短时先 clamp、长回来后追到原偏移
- 异步长高时一路追到目标，落位后不再排帧、摘掉监听
- 手势一到立即停手，之后不再抢位置
- 赋值期间 `scrollBehavior` 必须是 `auto`，且写完不留内联样式
- 存档上限 32 条；`forget` / `clear` 生效

真浏览器核过（`dev/probe-view-scroll.mjs`，Chrome headless `--dump-dom` 读回 iframe 里的真 `.view`）：

```
market scrolled 600 / fresh view starts at 0 / back 30ms & 530ms → 600 600 → PASS core
plugin plug:plugin-guide 300 -> 300 → PASS plugin
```

30ms 就已经在 600，证明恢复是瞬移（smooth 的话此刻还在半路）。

## 未做

- 插件自己内部的二级页面（插件内部 replaceChildren 重绘）仍归插件管，宿主不代管
- 位置不做持久化，冷启动一律从顶部开始
