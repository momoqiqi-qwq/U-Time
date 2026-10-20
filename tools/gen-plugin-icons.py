#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""U-Time · 图标生成器（自有扁平母版优先，Icons8 / iGoutu Color 兜底）

v0.250.0 起的首选来源：tools/icon-masters/
    统一的扁平双色风格（柔和两档明暗、奶油色内高光、圆润几何、无描边），由 AI 按同一张风格
    参考图逐个生成，再抠成透明底 256px 母版入库。母版是本项目自有素材，无需第三方署名。
    tools/icon-masters/<插件ID 或 视图ID>.png   ← 插件图标 / 插件内视图图标
    tools/icon-masters/nav/<key>.png            ← 主导航图标（capture 复用 inbox 的母版）
    有母版就用母版（风格列记为 `master`），没有才走下面的 Icons8 线路 ——
    新增插件时先补母版；临时没有母版也能出图，只是风格会与其余图标不一致。
    **仍然不要手工替换输出目录里的 PNG**：改母版，再重跑本脚本。

用途
    ① 把内置插件的图标统一成 Icons8「Color」彩色风格（品牌类走 3D 图标）；
       没有合适图形素材的插件走 TEXT_ICONS 代码绘制（印章式文字图标）；
    ② 把 7 个主导航图标（四象限/时间线/时间块/收件箱/插件中心/设置/快速捕获）
       也做成随包 Color PNG —— 此前导航图标走 Icons8 CDN 的 iOS Filled 直链，
       离线即裂，且与插件图标的彩色风格不统一（v0.42.0 起随包化）。
    生成 81×81 的透明 PNG，并把来源台账写进各自目录的 ATTRIBUTION.md。

来源
    图标集：https://igoutu.cn/icons/set/标志--style-color
    CDN：   https://img.icons8.com/<style>/96/<slug>.png  （style = color / 3d-fluency）
    igoutu.cn 是 Icons8 的中文镜像，slug 与 style 与 icons8.com 完全一致。

输出
    le-time-management/public/icons/plugins/<plugin-id>.png   ← 桌面端插件（src/icons.js 直接读）
    le-time-management/public/icons/plugins/ATTRIBUTION.md    ← 插件图标来源与 sha256 台账
    le-time-management/public/icons/nav/<key>.png             ← 桌面端主导航（src/icons.js 直接读）
    le-time-management/public/icons/nav/ATTRIBUTION.md        ← 导航图标来源台账
    miniprogram/images/plugins/<plugin-id>.png                ← 小程序（与桌面端同一份素材）
    （主导航 PNG 小程序不需要：小程序 tabBar 是 FA 单色成对图标，由 sync-tab-icons.py 管）

依赖
    Pillow。用项目专用 venv 跑：
    "C:/Users/yile/.workbuddy/binaries/python/envs/default/Scripts/python.exe" tools/gen-plugin-icons.py
    参数 --offline 表示只用缓存（.workbuddy/icon-cache/）不联网。
"""

import argparse
import hashlib
import io
import json
import os
import sys
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parent.parent
DESKTOP_OUT = REPO / "le-time-management" / "public" / "icons" / "plugins"
NAV_OUT = REPO / "le-time-management" / "public" / "icons" / "nav"
MINI_OUT = REPO / "miniprogram" / "images" / "plugins"
CACHE = REPO / ".workbuddy" / "icon-cache"
MASTERS = REPO / "tools" / "icon-masters"
# 导航 key 与母版文件不一一对应时在这里映射（快速捕获与收件箱同形）
NAV_MASTER_ALIAS = {"capture": "inbox"}

CANVAS = 81          # 画布边长，与历史素材（FA 50px 落在 81px 画布）保持一致
GLYPH = 58           # 图形最长边，略大于历史 50px，暗色底板下更清楚

# plugin-id -> (CDN 风格, slug, 说明)
ICONS = {
    "plugin-guide":      ("color",      "help",             "插件使用说明 / 帮助"),
    "pomodoro":          ("color",      "tomato",           "番茄专注 / 番茄"),
    "cppu-notify":       ("color",      "university",       "警大门户通知 / 大学建筑"),
    "gx-news":           ("color",      "trophy",           "竞赛消息雷达 / 奖杯"),
    "mojinghub":         ("color",      "medal",            "模竞竞赛平台 / 奖牌"),
    "rss-reader":        ("color",      "rss",              "RSS 信息流 / RSS 信号波"),
    "exam-calendar":     ("color",      "test-passed",      "考试日历 / 考核清单"),
    "shiguang-schedule": ("color",      "timetable",        "课程表 / 日历+时钟"),
    "web-collector":     ("color",      "bookmark-ribbon",  "网页收集 / 书签"),
    "wechat-push":       ("3d-fluency", "wechat",           "微信提醒推送 / 微信标志"),
    "chaoxing-notify":   ("color",      "books",            "学习通 / 一摞书"),
    "school-notice":     ("color",      "school",           "学校通知网站 / 校舍"),
    "cn-holiday":        ("color",      "lantern",          "中国节假日 / 中式灯笼"),
    "weekly-report":     ("color",      "statistics",       "周度报告 / 数据看板"),
    "dorm-duty":         ("color",      "broom",            "轮换值日 / 扫帚"),
    "inbox-drop":        ("color",      "downloading-updates", "拖入消息收纳 / 箭头入托盘"),
    "ai-chat":           ("color",      "artificial-intelligence", "AI 对话 / 智能大脑"),
    "github-readme":     ("3d-fluency", "github",           "GitHub 文档 / GitHub 猫标志"),
}

# 插件内视图图标（v0.216.0）：同一个插件的不同分类在侧栏各用各的图标，所以它们和插件图标
# 一样要随包 —— key = 视图 id（= registerView 的 id），落到同一个目录
# public/icons/plugins/<视图 id>.png。候选 slug 按序尝试：Icons8 的 slug 与 FontAwesome
# 名字并不对齐（FA 的 calendar-days 在 Icons8 是 calendar），一个 slug 不保证存在。
# 选定后要把生效 slug 同步进 src/icons.js 的 VIEW_ICONS8（做 CDN 回落与轮廓图标映射）。
VIEW_ICONS = {
    "cppu-card":     (["bank-cards", "credit-card", "card-in-hand"],   "警大门户通知 · 警大一卡通"),
    "cppu-award":    (["prize", "trophy"],                             "警大门户通知 · 警大获奖名单"),
    "cppu-xk":       (["todo-list", "checklist", "list"],              "警大门户通知 · 学生选课"),
    "cppu-qj":       (["calendar-delete", "calendar-minus", "leave"],  "警大门户通知 · 学生请假"),
    "cppu-credit":   (["line-chart", "combo-chart--v1", "statistics"], "警大门户通知 · 警大成绩"),
    "cppu-cx":       (["medal", "medal2", "diploma"],                  "警大门户通知 · 创新学分"),
    "cppu-calendar": (["calendar", "calendar--v1"],                    "警大门户通知 · 警大校历"),
    "cppu-growth":   (["sprout", "seedling", "plant-under-sun"],       "警大门户通知 · 学生成长"),
    "cppu-profile":  (["contact-card", "id-card", "business-contact"], "警大门户通知 · 个人信息"),
    # 上网记录（v0.253.0）：Dr.COM 自助服务的流量账单。取「联网」语义而不是图表语义 ——
    # line-chart 已经是警大成绩，同侧栏里再放一张图表图标会读成同一类东西。
    "cppu-net":      (["network", "data-transfer", "network-wireless"], "警大门户通知 · 上网记录"),
    # 邮箱（v0.255.0）：取「信封」语义。侧栏「警大邮箱」快捷入口用的也是信封，
    # 视图图标与入口图标同形，扫一眼就知道是同一个东西。
    "cppu-mail":     (["email", "mail", "envelope"],                    "警大门户通知 · 警大邮箱"),
    # 自习室查询（v0.265.0）：取「教室 / 敞开的门」语义 —— 自习室看的是「这间屋现在能不能进」，
    # 不用日历 / 图表那类（calendar 已是校历、line-chart 已是成绩，同侧栏里会读成同一类东西）。
    # 图标口径与其它视图一致：Icons8 Color 随包 PNG，**不放母版**
    # （有 tools/icon-masters/cppu-room.png 就会被 master_bytes 优先读取，侧栏静默退回扁平风格，
    #  scripts/test-icon-masters.mjs 也守着这条）。
    # 首选 classroom：本机 img.icons8.com 握手被重置，走镜像 img.icons8.ru 取到并缓存
    # （door* 三个 slug 在该镜像上是 404）。book 类排后面只是语义兜底，正常不会用到。
    "cppu-room":     (["classroom", "door-open", "door", "open-door", "books"], "警大门户通知 · 自习室查询"),
}

# 印章式文字图标：plugin-id -> (文字(至多 2 字，竖排堆叠), 说明)。
# 图标系统没有合适图形素材时用代码绘制：圆角渐变朱红底 + 白字，
# 视觉上是一枚中式印章。不依赖网络，输出确定性（同机重生成 sha 一致，--check 可校验）。
# 当前没有使用者（example-plugin 曾用过，已随插件移除）——需要时把插件 ID 加进下方即可。
TEXT_ICONS = {}

# 主导航 key -> (候选 slug 列表, 说明)。Color 风格，候选按序尝试、第一个下载成功的生效；
# 选定后要把同一个 slug 同步进 src/icons.js 的 NAV_ICONS8（做 CDN 回落与外部 key 兜底）。
# capture 是「快速捕获」入口，与收件箱同形，只为 key 独立落一份文件。
NAV_ICONS = {
    "quadrant":  (["grid-2", "four-squares", "grid"],       "四象限 / 田字格"),
    "timeline":  (["vertical-timeline", "timeline", "time-span"], "时间线 / 垂直时间轴（v0.52.0 新增，APK 端核心视图）"),
    "timeblock": (["clock", "clock--v1"],                   "时间块 / 时钟"),
    "inbox":     (["inbox", "filled-in-box", "inbox--v1"],  "收件箱 / 收件托盘"),
    "market":    (["puzzle", "puzzle-piece"],               "插件中心 / 拼图"),
    "settings":  (["settings", "gear"],                     "设置 / 齿轮"),
    "capture":   (["inbox", "filled-in-box", "inbox--v1"],  "快速捕获（与收件箱同形）"),
}

UA = {"User-Agent": "Mozilla/5.0 (compatible; Le-time-management-icon-sync/1.0)"}


# 下载主机按序尝试：主站 + 俄语镜像。本机实测 img.icons8.com 与 maxst.icons8.com
# 的 TLS 握手直接被重置（SSL EOF / Connection reset，走 127.0.0.1:7897 代理也一样），
# 而 img.icons8.ru 可直连 200 —— 两边是同一套 slug 与 style，只是域名不同。
# 对外文档与 src/icons.js 的 CDN 回落仍写 img.icons8.com（用户端能连的是主站）。
CDN_HOSTS = ("img.icons8.com", "img.icons8.ru")


def cdn_url(style: str, slug: str, host: str = CDN_HOSTS[0]) -> str:
    return f"https://{host}/{style}/96/{slug}.png"


def fetch(style: str, slug: str, offline: bool) -> bytes:
    CACHE.mkdir(parents=True, exist_ok=True)
    cache_file = CACHE / f"{style}__{slug}.png"
    if cache_file.exists():
        return cache_file.read_bytes()
    if offline:
        raise SystemExit(f"缓存缺失且处于 --offline：{cache_file}")
    last = None
    for host in CDN_HOSTS:
        for _ in range(2):
            try:
                req = urllib.request.Request(cdn_url(style, slug, host), headers=UA)
                with urllib.request.urlopen(req, timeout=25) as res:
                    body = res.read()
                if len(body) < 600:
                    raise RuntimeError(f"返回内容异常（{len(body)} 字节）")
                cache_file.write_bytes(body)
                return body
            except Exception as exc:  # noqa: BLE001
                last = exc
    raise SystemExit(f"下载失败 {style}/{slug}：{last}")


def fetch_first(style: str, candidates: list, offline: bool):
    """按候选顺序尝试下载，返回 (bytes, 生效的 slug)；全部失败才报错。
    offline 也继续试下一个候选——首选 slug 在 CDN 上可能根本不存在（如 grid-2 恒 404），
    它永远不会有缓存，offline 时不应因此放弃后续候选。"""
    last = None
    for slug in candidates:
        try:
            return fetch(style, slug, offline), slug
        except SystemExit as exc:
            last = exc
    raise SystemExit(f"候选 slug 全部失败 {style}/{candidates}：{last}")


def master_bytes(rel: str):
    """母版存在就返回其字节，否则 None。rel 相对 MASTERS，如 "pomodoro.png"、"nav/inbox.png"。"""
    p = MASTERS / rel
    return p.read_bytes() if p.exists() else None


def normalize(raw: bytes) -> Image.Image:
    """把任意尺寸的图标缩放到 81×81 画布，图形最长边统一为 GLYPH，居中（保留透明边）。"""
    src = Image.open(io.BytesIO(raw)).convert("RGBA")
    bbox = src.getbbox()
    if bbox:
        src = src.crop(bbox)
    ratio = GLYPH / max(src.width, src.height)
    size = (max(1, round(src.width * ratio)), max(1, round(src.height * ratio)))
    src = src.resize(size, Image.LANCZOS)
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.alpha_composite(src, ((CANVAS - size[0]) // 2, (CANVAS - size[1]) // 2))
    return canvas


def _cn_font(size: int):
    """挑一个可用的中文粗体字体（Windows 自带，按优先级）。"""
    windir = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
    for name in ("msyhbd.ttc", "msyh.ttc", "simhei.ttf"):
        p = windir / name
        if p.exists():
            return ImageFont.truetype(str(p), size)
    raise SystemExit("找不到中文字体（msyhbd.ttc / msyh.ttc / simhei.ttf）")


def draw_text_icon(text: str) -> Image.Image:
    """印章式文字图标：81×81 透明画布中央一枚 GLYPH 见方的圆角渐变朱红印章，
    文字（至多 2 字）白色竖排堆叠。确定性绘制，重生成 sha 不变。"""
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    side = GLYPH
    x0 = (CANVAS - side) // 2
    y0 = (CANVAS - side) // 2

    # 底板：上亮下暗的垂直渐变朱红（linear_gradient 上黑下白，0→亮色、255→暗色）
    grad = Image.linear_gradient("L").resize((side, side), Image.LANCZOS)
    c_light = Image.new("RGBA", (side, side), (226, 96, 74, 255))
    c_dark = Image.new("RGBA", (side, side), (190, 54, 40, 255))
    seal = Image.composite(c_dark, c_light, grad)

    mask = Image.new("L", (side, side), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, side - 1, side - 1], radius=13, fill=255)
    canvas.paste(seal, (x0, y0), mask)

    # 白字竖排：每字占印章高度的一半，水平垂直居中
    font = _cn_font(26)
    draw = ImageDraw.Draw(canvas)
    cx = x0 + side / 2
    chars = list(text)[:2]
    for i, ch in enumerate(chars):
        cy = y0 + side * (i + 0.5) / len(chars)
        draw.text((cx, cy), ch, font=font, fill=(255, 255, 255, 255), anchor="mm")
    return canvas


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true", help="只使用本地缓存，不联网")
    ap.add_argument("--check", action="store_true", help="只校验落地文件是否与 CDN 一致（需缓存或联网）")
    args = ap.parse_args()

    DESKTOP_OUT.mkdir(parents=True, exist_ok=True)
    NAV_OUT.mkdir(parents=True, exist_ok=True)
    MINI_OUT.mkdir(parents=True, exist_ok=True)

    rows = []
    for plugin_id, (text, note) in TEXT_ICONS.items():
        img = draw_text_icon(text)
        buf = io.BytesIO()
        img.save(buf, "PNG", optimize=True)
        data = buf.getvalue()
        digest = hashlib.sha256(data).hexdigest()

        existing = DESKTOP_OUT / f"{plugin_id}.png"
        if args.check:
            same = existing.exists() and hashlib.sha256(existing.read_bytes()).hexdigest() == digest
            print(f"{'OK ' if same else 'DIFF'} {plugin_id:20} text/{text}")
            continue

        existing.write_bytes(data)
        (MINI_OUT / f"{plugin_id}.png").write_bytes(data)
        rows.append((plugin_id, "text", text, note, digest))
        print(f"写入 {plugin_id:20} text/{text:14} {len(data):6} B  sha256={digest[:12]}")

    for plugin_id, (style, slug, note) in ICONS.items():
        raw = master_bytes(f"{plugin_id}.png")
        if raw is not None:
            style, slug = "master", f"icon-masters/{plugin_id}.png"
        else:
            raw = fetch(style, slug, args.offline)
        img = normalize(raw)
        buf = io.BytesIO()
        img.save(buf, "PNG", optimize=True)
        data = buf.getvalue()
        digest = hashlib.sha256(data).hexdigest()

        existing = DESKTOP_OUT / f"{plugin_id}.png"
        if args.check:
            same = existing.exists() and hashlib.sha256(existing.read_bytes()).hexdigest() == digest
            print(f"{'OK ' if same else 'DIFF'} {plugin_id:20} {style}/{slug}")
            continue

        existing.write_bytes(data)
        (MINI_OUT / f"{plugin_id}.png").write_bytes(data)
        rows.append((plugin_id, style, slug, note, digest))
        print(f"写入 {plugin_id:20} {style}/{slug:18} {len(data):6} B  sha256={digest[:12]}")

    for view_id, (candidates, note) in VIEW_ICONS.items():
        raw = master_bytes(f"{view_id}.png")
        if raw is not None:
            vstyle, slug = "master", f"icon-masters/{view_id}.png"
        else:
            raw, slug = fetch_first("color", candidates, args.offline)
            vstyle = "color"
        img = normalize(raw)
        buf = io.BytesIO()
        img.save(buf, "PNG", optimize=True)
        data = buf.getvalue()
        digest = hashlib.sha256(data).hexdigest()

        existing = DESKTOP_OUT / f"{view_id}.png"
        if args.check:
            same = existing.exists() and hashlib.sha256(existing.read_bytes()).hexdigest() == digest
            print(f"{'OK ' if same else 'DIFF'} [view] {view_id:20} {vstyle}/{slug}")
            continue

        existing.write_bytes(data)
        (MINI_OUT / f"{view_id}.png").write_bytes(data)
        rows.append((view_id, vstyle, slug, f"{note}（插件内视图）", digest))
        print(f"写入 [view] {view_id:20} {vstyle}/{slug:18} {len(data):6} B  sha256={digest[:12]}")

    nav_rows = []
    for key, (candidates, note) in NAV_ICONS.items():
        mkey = NAV_MASTER_ALIAS.get(key, key)
        raw = master_bytes(f"nav/{mkey}.png")
        if raw is not None:
            slug = f"icon-masters/nav/{mkey}.png"
        else:
            raw, slug = fetch_first("color", candidates, args.offline)
        img = normalize(raw)
        buf = io.BytesIO()
        img.save(buf, "PNG", optimize=True)
        data = buf.getvalue()
        digest = hashlib.sha256(data).hexdigest()

        existing = NAV_OUT / f"{key}.png"
        if args.check:
            same = existing.exists() and hashlib.sha256(existing.read_bytes()).hexdigest() == digest
            print(f"{'OK ' if same else 'DIFF'} [nav] {key:20} {slug}")
            continue

        existing.write_bytes(data)
        nav_rows.append((key, slug, note, digest))
        print(f"写入 [nav] {key:20} {slug:28} {len(data):6} B  sha256={digest[:12]}")

    if not args.check:
        text_rows = [r for r in rows if r[1] == "text"]
        master_rows = [r for r in rows if r[1] == "master"]
        icons8_rows = [r for r in rows if r[1] not in ("text", "master")]
        lines = [
            "# public/icons/plugins 素材台账（内置插件图标 + 插件内视图图标）",
            "",
            f"共 {len(rows)} 个图标：",
            "",
            f"- {len(master_rows)} 个来自**本项目自有扁平母版**（`风格` 列为 `master`，`tools/icon-masters/`）："
            "AI 按同一张风格参考图生成、抠成透明底后入库，是本产品自有素材，**无需第三方署名**；"
            "品牌类插件（微信推送、GitHub 文档）是按用途重新设计的图形，不含任何品牌标志。",
            f"- {len(icons8_rows)} 个仍来自 **Icons8 / iGoutu**（`风格` 列为 `color` / `3d-fluency`）："
            "暂无母版的插件，按 Icons8 License 署名。",
            f"- {len(text_rows)} 个为印章式文字图标（`风格` 列为 `text`，由本脚本代码绘制，无需署名）。",
            "",
            f"其中 {len(VIEW_ICONS)} 个是**插件内视图图标**（说明里带「插件内视图」）：同一个插件的不同分类"
            "在侧栏各用各的图标（v0.216.0），key = 视图 id，与插件图标同目录、同风格 —— "
            "`src/icons.js` 的 `VIEW_ICONS8` / `VIEW_FA_ICONS` 是它们的消费口径。",
            "",
            "图标集入口：<https://igoutu.cn/icons/set/标志--style-color> ｜ "
            "CDN 直链格式：`https://img.icons8.com/<style>/96/<slug>.png`",
            "",
            "生成方式：`tools/gen-plugin-icons.py`（Pillow，输出 81×81 透明 PNG，"
            f"图形最长边 {GLYPH}px）。**不要手工替换这些 PNG** —— 改 `tools/icon-masters/` 的母版后重新生成。",
            "",
            "| 插件 ID | 风格 | 来源（母版路径 / Icons8 slug） | 说明 | sha256 |",
            "|---|---|---|---|---|",
        ]
        for plugin_id, style, slug, note, digest in rows:
            lines.append(f"| `{plugin_id}` | {style} | `{slug}` | {note} | `{digest[:16]}…` |")
        lines += [
            "",
            "## 许可",
            "",
            "`master` 行：本项目自有素材，随本项目许可使用，无第三方署名要求。",
            "",
            "其余 Icons8 行（以及 `src/icons.js` 随包 PNG 加载失败时回落的 CDN 直链）："
            "Icons8 License（免费使用需在产品内署名）。署名入口见设置 → 关于（`src/aboutData.js`）"
            "与 `public/OPEN_SOURCE_NOTICES.md`。",
            "素材仅作为本产品界面的组成部分使用，**不得作为独立图标库转售或再分发**。",
            "",
            "## 消费方",
            "",
            "| 端 | 路径 | 读取方式 |",
            "|---|---|---|",
            "| 桌面 / Android | `le-time-management/public/icons/plugins/*.png` | `src/icons.js` 的 `appIcon()` 按插件 ID 直读 |",
            "| 微信小程序 | `miniprogram/images/plugins/*.png` | `pages/plugins/index.js`、`pages/plugin/index.js` 拼 `/images/plugins/${id}.png` |",
            "",
            "两份文件字节一致，由本脚本一次写入。",
            "",
        ]
        (DESKTOP_OUT / "ATTRIBUTION.md").write_text("\n".join(lines), encoding="utf-8")
        print(f"\n台账已写入 {DESKTOP_OUT / 'ATTRIBUTION.md'}")

        nav_lines = [
            "# public/icons/nav 素材台账（主导航图标）",
            "",
            f"共 {len(nav_rows)} 个图标，其中 {sum(1 for r in nav_rows if r[1].startswith('icon-masters/'))} 个来自"
            "**本项目自有扁平母版**（`tools/icon-masters/nav/`，与插件图标同一套风格，无需第三方署名）；"
            "其余（如有）来自 **Icons8 / iGoutu** 的 **Color 彩色风格**。",
            "",
            "`capture`（快速捕获）与 `inbox`（收件箱）同形，是刻意为之的两份独立文件。",
            "",
            "图标集入口：<https://igoutu.cn/icons/set/标志--style-color> ｜ "
            "CDN 直链格式：`https://img.icons8.com/color/96/<slug>.png`",
            "",
            "生成方式：`tools/gen-plugin-icons.py`（Pillow，输出 81×81 透明 PNG，"
            f"图形最长边 {GLYPH}px）。**不要手工替换这些 PNG** —— 重新生成会覆盖。",
            "",
            "| key | 来源（母版路径 / Icons8 slug） | 说明 | sha256 |",
            "|---|---|---|---|",
        ]
        for key, slug, note, digest in nav_rows:
            nav_lines.append(f"| `{key}` | `{slug}` | {note} | `{digest[:16]}…` |")
        nav_lines += [
            "",
            "## 许可与消费方",
            "",
            "母版图标为本项目自有素材。加载失败时回落的 CDN 直链仍是 Icons8 Color，"
            "按 Icons8 License 署名（设置 → 关于 `src/aboutData.js` 与 `public/OPEN_SOURCE_NOTICES.md`），"
            "仅作为本产品界面的组成部分使用，**不得作为独立图标库转售或再分发**。",
            "",
            "消费方：`le-time-management/public/icons/nav/*.png` ← `src/icons.js` 的 `appIcon()` 按导航 key 直读，"
            "加载失败才回落 Icons8 Color 的 CDN 直链（候选清单在 `NAV_ICONS8`）。",
            "微信小程序不需要这批 PNG（tabBar 是 FA 单色成对图标，由 `miniprogram/tools/sync-tab-icons.py` 管）。",
            "",
        ]
        (NAV_OUT / "ATTRIBUTION.md").write_text("\n".join(nav_lines), encoding="utf-8")
        print(f"台账已写入 {NAV_OUT / 'ATTRIBUTION.md'}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
