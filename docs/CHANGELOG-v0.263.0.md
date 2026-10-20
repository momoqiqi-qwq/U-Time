# v0.263.0 · 学习通课件界面（点课程卡片进专门的课件获取页）

## 改了什么

学习通插件从 2.20.0 → **2.21.0**：课程卡片不再只是"展开开课时间"，**点卡片主体直接进入这门课的课件界面**。

- 课程卡片：主体点击 = 进课件界面；新增「开课时间」小按钮，点它才展开原来的开课～结课详情。
  （原来的「打开课程门户」按钮留在展开区里，顺序仍是「门户 → 展开 → 整卡」，点门户不会顺带进课件页。）
- 课件界面：按**一级章节 → 知识点 → 附件**三层列出来，每节给出文件名、类型徽标（课件 / PDF / 视频 / 文档 / 附件）、
  大小与下载按钮；章节可折叠（默认全展开），顶部有「← 课程」「重新读取」「全部下载」。
- 下载分流：**≤40 MB 走应用内落盘**（`tide.assets.saveBase64` → 系统下载目录）；
  **>40 MB 交给系统浏览器**（`tide.util.openUrl` 打开学习通给的 cldisk 签名直链）。
  156 MB 的 PPT 若走 binary base64 会变成 200 MB 字符串跨 IPC，必崩，所以这条阈值是硬约束。
- 切页签会清掉课件界面状态；章节空、会话失效都给中文人话提示，不白屏。

## 数据链路（都走宿主 `tide.http.fetch`，无 CORS 问题）

```
课程卡片 url(?courseid&clazzid&cpi&enc)
  → finalUrl 里的 enc
  → /mooc2-ans/mycourse/studentcourse?...&stuenc=<enc>      解析 toOld('cid','kid','clz',0)
  → /knowledge/cards?clazzid&courseid&knowledgeid           解析 iframe[data] 的 objectid/name/type/size
  → /ananas/status/<objectid>?k=&flag=normal                download(签名直链) / pdf
```

坑记两条：

1. `studentcourse` 的 URL 以 `…/mycourse/stu` 开头，请求分流时必须**先判 studentcourse**，否则章节请求会被当成课程卡片页拿到空目录。
2. `knowledge/cards` 里附件元数据字段是 **name / type / size**（不是 filename），且 `data="…"` 是 `&quot;` 转义过的 JSON，要先 decodeEntities 再 JSON.parse。

## 影响面

- 仅 Windows / Android / 微信三端同源的学习通插件；无数据迁移。
- 新增 `scripts/test-chaoxing-course-files.mjs`（真跑解析 + 下载分流 + 卡片入口 + 失败提示）。
- 改了卡片点击语义，`test-chaoxing.mjs` 的 7c 段同步改成新契约。
