#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""U-Time · 图标生成器（Icons8 / iGoutu Color 彩色图标集）

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

CANVAS = 81          # 画布边长，与历史素材（FA 50px 落在 81px 画布）保持一致
GLYPH = 58           # 图形最长边，略大于历史 50px，暗色底板下更清楚

# plugin-id -> (CDN 风格, slug, 说明)
ICONS = {
    "plugin-guide":      ("color",      "help",             "插件使用说明 / 帮助"),
    "pomodoro":          ("color",      "tomato",           "番茄专注 / 番茄"),
    "cppu-notify":       ("color",      "university",       "警大门户通知 / 大学建筑"),
    "cppu-calendar":     ("color",      "calendar",         "警大校历 / 月历"),
    "gx-news":           ("color",      "trophy",           "竞赛消息雷达 / 奖杯"),
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


def cdn_url(style: str, slug: str) -> str:
    return f"https://img.icons8.com/{style}/96/{slug}.png"


def fetch(style: str, slug: str, offline: bool) -> bytes:
    CACHE.mkdir(parents=True, exist_ok=True)
    cache_file = CACHE / f"{style}__{slug}.png"
    if cache_file.exists():
        return cache_file.read_bytes()
    if offline:
        raise SystemExit(f"缓存缺失且处于 --offline：{cache_file}")
    last = None
    for _ in range(3):
        try:
            req = urllib.request.Request(cdn_url(style, slug), headers=UA)
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
        img = normalize(fetch(style, slug, args.offline))
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

    nav_rows = []
    for key, (candidates, note) in NAV_ICONS.items():
        raw, slug = fetch_first("color", candidates, args.offline)
        img = normalize(raw)
        buf = io.BytesIO()
        img.save(buf, "PNG", optimize=True)
        data = buf.getvalue()
        digest = hashlib.sha256(data).hexdigest()

        existing = NAV_OUT / f"{key}.png"
        if args.check:
            same = existing.exists() and hashlib.sha256(existing.read_bytes()).hexdigest() == digest
            print(f"{'OK ' if same else 'DIFF'} [nav] {key:20} color/{slug}")
            continue

        existing.write_bytes(data)
        nav_rows.append((key, slug, note, digest))
        print(f"写入 [nav] {key:20} color/{slug:18} {len(data):6} B  sha256={digest[:12]}")

    if not args.check:
        text_rows = [r for r in rows if r[1] == "text"]
        lines = [
            "# public/icons/plugins 素材台账（内置插件图标）",
            "",
            f"共 {len(rows)} 个图标：{len(rows) - len(text_rows)} 个来自 **Icons8 / iGoutu** 的 **Color 彩色风格**"
            "（`wechat-push` 用 `3d-fluency` 风格，因为 Color 风格没有微信标志）；"
            f"{len(text_rows)} 个为印章式文字图标（`风格` 列为 `text`，由本脚本代码绘制，"
            "非 Icons8 素材、无需署名）。",
            "",
            "图标集入口：<https://igoutu.cn/icons/set/标志--style-color> ｜ "
            "CDN 直链格式：`https://img.icons8.com/<style>/96/<slug>.png`",
            "",
            "生成方式：`tools/gen-plugin-icons.py`（Pillow，输出 81×81 透明 PNG，"
            f"图形最长边 {GLYPH}px）。**不要手工替换这些 PNG** —— 重新生成会覆盖。",
            "",
            "| 插件 ID | 风格 | slug | 说明 | sha256 |",
            "|---|---|---|---|---|",
        ]
        for plugin_id, style, slug, note, digest in rows:
            lines.append(f"| `{plugin_id}` | {style} | `{slug}` | {note} | `{digest[:16]}…` |")
        lines += [
            "",
            "## 许可",
            "",
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
            f"共 {len(nav_rows)} 个图标，全部来自 **Icons8 / iGoutu** 的 **Color 彩色风格**，"
            "与插件图标同一套方案（v0.42.0 起随包化，此前导航走 iOS Filled CDN 直链）。",
            "",
            "`capture`（快速捕获）与 `inbox`（收件箱）同形，是刻意为之的两份独立文件。",
            "",
            "图标集入口：<https://igoutu.cn/icons/set/标志--style-color> ｜ "
            "CDN 直链格式：`https://img.icons8.com/color/96/<slug>.png`",
            "",
            "生成方式：`tools/gen-plugin-icons.py`（Pillow，输出 81×81 透明 PNG，"
            f"图形最长边 {GLYPH}px）。**不要手工替换这些 PNG** —— 重新生成会覆盖。",
            "",
            "| key | 生效 slug | 说明 | sha256 |",
            "|---|---|---|---|",
        ]
        for key, slug, note, digest in nav_rows:
            nav_lines.append(f"| `{key}` | `{slug}` | {note} | `{digest[:16]}…` |")
        nav_lines += [
            "",
            "## 许可与消费方",
            "",
            "Icons8 License（免费使用需在产品内署名）。署名入口见设置 → 关于（`src/aboutData.js`）"
            "与 `public/OPEN_SOURCE_NOTICES.md`。素材仅作为本产品界面的组成部分使用，"
            "**不得作为独立图标库转售或再分发**。",
            "",
            "消费方：`le-time-management/public/icons/nav/*.png` ← `src/icons.js` 的 `appIcon()` 按导航 key 直读，"
            "加载失败才回落 CDN 同风格直链（候选清单在 `NAV_ICONS8`，须与本台账 slug 对齐）。",
            "微信小程序不需要这批 PNG（tabBar 是 FA 单色成对图标，由 `miniprogram/tools/sync-tab-icons.py` 管）。",
            "",
        ]
        (NAV_OUT / "ATTRIBUTION.md").write_text("\n".join(nav_lines), encoding="utf-8")
        print(f"台账已写入 {NAV_OUT / 'ATTRIBUTION.md'}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
