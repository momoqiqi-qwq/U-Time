(function () {
  "use strict";

  /* ═══════════════════ GitHub Flavored Markdown 渲染 ═══════════════════
     README 全文来自第三方仓库，属于不可信输入。做法与 ai-chat 的 md() 同一条路：
     整份文本先 esc()，之后只有本文件自己生成的标签才是活的。
     裸 HTML 走「标签 + 属性」双白名单 —— README 里 <picture> 换深浅色 logo、
     <div align=center> 排徽章太常见，全转义会把首屏变成一坨可见源码；白名单外的
     标签按源码显示是刻意的（GitHub 会渲染出来，我们不渲染）。
     所有生成的标签都先经 hold() 存成 \u0000N\u0000 占位、最后一步才回填，
     这样「裸 URL 自动成链」不会把已经拼好的 href 再吃一遍。 */

  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
  // 属性值一律在「进入解析器之前」就 esc 过（见 attrsOf 的第二参），所以这里直接拼。
  const attr = (k, v) => (v === "" || v == null ? ` ${k}` : ` ${k}="${v}"`);

  // 标签 → 放行的属性（空 = 不带属性）。style 和一切 on* 都不在表内，永远剥掉。
  const TAGS = {
    br: "", wbr: "", hr: "", picture: "", center: "", span: "", b: "", strong: "", em: "", i: "",
    u: "", s: "", del: "", ins: "", mark: "", kbd: "", samp: "", code: "", pre: "", small: "",
    sub: "", sup: "", p: "align", div: "align", a: "href", img: "src alt width height",
    source: "srcset media width height", details: "open", summary: "", blockquote: "",
    ul: "", ol: "", li: "", table: "", thead: "", tbody: "", tfoot: "", tr: "",
    td: "align colspan", th: "align colspan", h1: "", h2: "", h3: "", h4: "", h5: "", h6: "",
  };
  const BLOCKED = /^(?:javascript|data|vbscript|file):/i;

  /** 仓库相对路径 → 绝对地址。kind=raw 给图片（raw 域名），kind=blob 给文档链接（看渲染页）。 */
  function resolveHref(raw, ctx, kind) {
    const href = String(raw || "").trim().replace(/[<>]/g, "");
    if (!href) return "";
    if (href[0] === "#") return href;
    if (BLOCKED.test(href)) return null;
    if (/^(?:https?:|mailto:|tel:)/i.test(href)) return href;
    const clean = href.replace(/^\.\//, "").replace(/^\//, "").replace(/^(?:\.\.\/)+/, "");
    const dir = ctx.dir ? (ctx.dir.endsWith("/") ? ctx.dir : `${ctx.dir}/`) : "";
    const host = kind === "blob"
      ? `https://github.com/${ctx.owner}/${ctx.repo}/blob/${ctx.branch}/`
      : `https://raw.githubusercontent.com/${ctx.owner}/${ctx.repo}/${ctx.branch}/`;
    return `${host}${dir}${clean}`;
  }

  /** 图片标签。http 图源在 APK 上会被 WebView 当混合内容静默拦，所以降级成可点链接。 */
  function imgHtml(src, alt, size, ctx) {
    const url = resolveHref(src, ctx, "raw");
    if (!url || BLOCKED.test(url)) return `![${alt || ""}](${src || ""})`;
    if (/^http:/i.test(url)) {
      return `<a class="gh-img-off" href="${url}" data-insecure="1" rel="noopener noreferrer">🖼 ${alt || "图片"}</a>`;
    }
    const dim = Object.entries(size || {}).filter(([, v]) => v).map(([k, v]) => attr(k, v)).join("");
    return `<img src="${url}" alt="${alt || ""}"${dim} loading="lazy">`;
  }

  /** escape=true 用于裸 HTML 属性：那份文本还没整体 esc 过，取值必须就地转义。 */
  function attrsOf(raw, escape) {
    const out = [];
    const re = /([A-Za-z_:][-:\w.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/g;
    let m;
    while ((m = re.exec(String(raw || "")))) {
      const v = m[2] ?? m[3] ?? m[4] ?? "";
      out.push([m[1].toLowerCase(), escape ? esc(v) : v]);
    }
    return out;
  }

  /** <picture> 的 media="(prefers-color-scheme: dark)" 读的是系统主题，而应用内深色是
      data-theme-mode —— 两者可以相反。所以拆成两个带主题类的 img，由宿主主题选择器决定显示哪个。 */
  function pictureHtml(block, ctx) {
    const sources = [...block.matchAll(/<source\b([^>]*)>/gi)].map((m) => attrsOf(m[1], true));
    const img = attrsOf((block.match(/<img\b([^>]*)>/i) || [, ""])[1], true);
    const pick = (list, name) => (list.find((a) => a[0] === name) || [, ""])[1];
    const size = { width: pick(img, "width"), height: pick(img, "height") };
    const alt = pick(img, "alt");
    const dark = sources.find((a) => /dark/i.test(pick(a, "media")));
    const light = sources.find((a) => !/dark/i.test(pick(a, "media"))) || img;
    const src = pick(dark || [], "srcset") || pick(dark || [], "src");
    const lite = pick(light, "srcset") || pick(light, "src") || pick(img, "src");
    const parts = [];
    if (src) parts.push(imgHtml(src, alt, size, ctx).replace("<img", '<img class="gh-theme-dark"'));
    if (lite) parts.push(imgHtml(lite, alt, size, ctx).replace("<img", '<img class="gh-theme-light"'));
    return parts.length ? `<span class="gh-picture">${parts.join("")}</span>` : esc(block);
  }

  /** 单个裸标签：放行就重建成干净标签，否则原样留着等整体 esc。 */
  function tameTag(tag, ctx, hold) {
    const m = tag.match(/^<\s*(\/?)\s*([A-Za-z][A-Za-z0-9-]*)\s*([\s\S]*?)\s*(\/?)>$/);
    if (!m) return tag;
    const [, closing, lname] = m;
    const name = lname.toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(TAGS, name)) return tag;
    if (closing) return hold(`</${name}>`);
    const want = TAGS[name] ? TAGS[name].split(" ") : [];
    const kept = [];
    let cls = "";
    for (const [k, v] of attrsOf(m[3], true)) {
      if (!want.includes(k)) continue;
      if (k === "media") continue;
      if (k === "align") { cls = `gh-${v}`; continue; }
      if (k === "href") { const u = resolveHref(v, ctx, "blob"); if (u === null) continue; kept.push([k, u]); continue; }
      if (k === "src") { kept.push([k, resolveHref(v, ctx, "raw") || ""]); continue; }
      if (k === "srcset") { kept.push([k, resolveHref(v.split(/[\s,]+/)[0], ctx, "raw") || ""]); continue; }
      kept.push([k, v]);
    }
    if (name === "img") {
      const src = (kept.find((a) => a[0] === "src") || [, ""])[1];
      const alt = (kept.find((a) => a[0] === "alt") || [, ""])[1];
      return hold(imgHtml(src, alt, {
        width: (kept.find((a) => a[0] === "width") || [, ""])[1],
        height: (kept.find((a) => a[0] === "height") || [, ""])[1],
      }, ctx));
    }
    if (want.includes("open") && /\bopen\b(?!\s*=)/i.test(m[3])) kept.push(["open", ""]);
    const body = kept.map(([k, v]) => attr(k, v)).join("");
    return hold(`<${name}${cls ? attr("class", cls) : ""}${body}>`);
  }

  function slug(text) {
    return String(text).toLowerCase().trim()
      .replace(/[^\p{L}\p{N} -]/gu, "").replace(/\s+/g, "-");
  }

  function inline(text, ctx, hold) {
    let s = text;
    s = s.replace(/`([^`\n]+)`/g, (m, code) => hold(`<code>${code}</code>`));
    s = s.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+[^)]*)?\)/g, (m, alt, href) => hold(imgHtml(href, alt, {}, ctx)));
    s = s.replace(/\[((?:[^\[\]]|\[[^\]]*\])*)\]\(\s*([^)\s]+)(?:\s+[^)]*)?\)/g, (m, label, href) => {
      const url = resolveHref(href, ctx, "blob");
      if (!url) return m;
      const ext = /^(?:https?:|mailto:|tel:)/i.test(url) ? ' rel="noopener noreferrer"' : "";
      return hold(`<a href="${url}"${ext}>${label}</a>`);
    });
    s = s.replace(/&lt;((?:https?|ftp):\/\/[^\s<>]+)&gt;/g, (m, u) => hold(`<a href="${u}" rel="noopener noreferrer">${u}</a>`));
    s = s.replace(/&lt;([\w.+-]+@[\w-]+(?:\.[\w-]+)+)&gt;/g, (m, e) => hold(`<a href="mailto:${e}">${e}</a>`));
    s = s.replace(/(^|[\s(])((?:https?:\/\/|www\.)[^\s<>()]+[^\s<>().,;:!?])/g,
      (m, pre, u) => pre + hold(`<a href="${u.startsWith("www.") ? `https://${u}` : u}" rel="noopener noreferrer">${u}</a>`));
    s = s.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^\w])\*([^*\n]+)\*(?![\w*])/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^\w])__([^_\n]+)__(?![\w_])/g, "$1<strong>$2</strong>");
    s = s.replace(/(^|[^\w])_([^_\n]+)_(?![\w_])/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    return s;
  }

  const splitRow = (line) => {
    let s = line.trim().replace(/^\|/, "").replace(/\|\s*$/, "");
    const cells = [];
    let cur = "";
    for (let i = 0; i < s.length; i += 1) {
      if (s[i] === "\\" && s[i + 1] === "|") { cur += "|"; i += 1; continue; }
      if (s[i] === "|") { cells.push(cur.trim()); cur = ""; continue; }
      cur += s[i];
    }
    cells.push(cur.trim());
    return cells;
  };
  const isDelim = (line) => /^ {0,3}\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line)
    && splitRow(line).length && splitRow(line).every((c) => /^:?-+:?$/.test(c.replace(/\s/g, "")));
  const alignOf = (cell) => (cell.startsWith(":") ? (cell.endsWith(":") ? "center" : "left") : cell.endsWith(":") ? "right" : "");

  const IND = (line) => (line.match(/^\s*/) || [""])[0].length;
  const ITEM_RE = /^(\s*)([-*+]|\d+[.)])[ \t]+(.*)$/;
  const QUOTE_RE = /^ {0,3}&gt;\s?/;
  /** 整行只有 hold() 占位符 —— 即「这一行原本就是一块裸 HTML 或一个围栏代码块」。 */
  const BLOCK_ONLY = /^(?:[\u0000\u0001]\d+[\u0000\u0001])+$/;
  // 块级裸 HTML 的起始标签。GitHub 的 HTML block 规则是「一路吃到空行为止都不再解析 markdown」，
  // 必须照做：README 里 <p align=center> 排徽章的写法太常见，逐行包 <p> 会造出 <p> 套 <p>，
  // 浏览器自动纠形后结构就和作者写的不一样了。
  const HTML_BLOCK_TAG = /^<\/?(?:p|div|span|table|thead|tbody|tfoot|tr|td|th|ul|ol|li|blockquote|details|summary|pre|h[1-6]|picture|center|section|header|footer|aside|figure|dl|dt|dd|form|iframe|script|style)\b/i;

  function opensHtmlBlock(line, peek) {
    const t = String(line).trim();
    const m = t.match(/^[\u0000\u0001](\d+)[\u0000\u0001]/);
    return !!m && HTML_BLOCK_TAG.test(peek(m[1]));
  }

  function startsBlock(line, next, peek) {
    return BLOCK_ONLY.test(line.trim())
      || opensHtmlBlock(line, peek)
      || /^ {0,3}#{1,6}\s/.test(line)
      || /^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line) || QUOTE_RE.test(line)
      || ITEM_RE.test(line) || /^ {4}\S/.test(line)
      || (line.includes("|") && isDelim(next || ""));
  }

  function listBlock(lines, from, ctx, hold, peek) {
    const base = IND(lines[from]);
    const ordered = /^\s*\d/.test(lines[from]);
    const items = [];
    let i = from;
    while (i < lines.length) {
      const ln = lines[i];
      if (!ln.trim()) {
        const nx = lines[i + 1] || "";
        if (IND(nx) > base || (IND(nx) === base && ITEM_RE.test(nx))) { i += 1; continue; }
        break;
      }
      const m = ln.match(ITEM_RE);
      if (m && IND(ln) <= base) {
        if (IND(ln) < base) break;
        items.push({ body: [m[3]], nest: [] });
        i += 1;
        continue;
      }
      if (items.length && IND(ln) > base) { items[items.length - 1].nest.push(ln.slice(base + 2)); i += 1; continue; }
      break;
    }
    let task = false;
    const html = items.map((it) => {
      let text = it.body.join(" ");
      const t = text.match(/^\[( |x|X)\]\s+([\s\S]*)$/);
      let cls = "";
      if (t) { task = true; cls = ` class="${t[1] === " " ? "off" : "on"}"`; text = t[2]; }
      const nest = it.nest.length ? blocks(it.nest.join("\n"), ctx, hold, peek) : "";
      return `<li${cls}>${inline(text, ctx, hold)}${nest}</li>`;
    }).join("");
    return [`<${ordered ? "ol" : "ul"}${task ? ' class="task"' : ""}>${html}</${ordered ? "ol" : "ul"}>`, i];
  }

  function blocks(src, ctx, hold, peek) {
    const lines = String(src).split("\n");
    let out = "";
    let i = 0;
    while (i < lines.length) {
      const ln = lines[i];
      if (!ln.trim()) { i += 1; continue; }

      // 块级裸 HTML：一路吃到空行，中间不再解析 markdown（与 GitHub 的 HTML block 一致）
      if (opensHtmlBlock(ln, peek)) {
        const body = [];
        while (i < lines.length && lines[i].trim()) { body.push(lines[i].trim()); i += 1; }
        out += body.join("\n");
        continue;
      }

      // 整行只有占位符 = 块级内容（围栏代码块，或 README 里那种缩进的裸 HTML 块）。
      // 直接落地不套 <p>，更要赶在「四空格 = 缩进代码」那条之前判掉：
      // vite 的 README 顶部就是缩进 4 空格的 <picture>，晚一步整个 logo 会被吞进 <pre>。
      if (BLOCK_ONLY.test(ln.trim())) { out += ln.trim(); i += 1; continue; }

      let m = ln.match(/^ {0,3}(#{1,6})\s+(.*)$/);
      if (m) {
        const text = m[2].replace(/\s+#+\s*$/, "");
        out += `<h${m[1].length} id="${esc(slug(text))}">${inline(text, ctx, hold)}</h${m[1].length}>`;
        i += 1;
        continue;
      }

      if (/^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(ln)) { out += "<hr>"; i += 1; continue; }

      if (QUOTE_RE.test(ln)) {
        const body = [];
        while (i < lines.length && lines[i].trim()) { body.push(lines[i].replace(QUOTE_RE, "")); i += 1; }
        out += `<blockquote>${blocks(body.join("\n"), ctx, hold, peek)}</blockquote>`;
        continue;
      }

      if (ln.includes("|") && isDelim(lines[i + 1] || "")) {
        const head = splitRow(ln);
        const align = splitRow(lines[i + 1]).map(alignOf);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) { rows.push(splitRow(lines[i])); i += 1; }
        const cell = (v, k, tag) => `<${tag}${align[k] ? attr("align", align[k]) : ""}>${inline(v || "", ctx, hold)}</${tag}>`;
        out += `<table><thead><tr>${head.map((v, k) => cell(v, k, "th")).join("")}</tr></thead><tbody>`
          + rows.map((r) => `<tr>${head.map((_, k) => cell(r[k], k, "td")).join("")}</tr>`).join("")
          + "</tbody></table>";
        continue;
      }

      if (ITEM_RE.test(ln)) { const [html, next] = listBlock(lines, i, ctx, hold, peek); out += html; i = next; continue; }

      if (/^ {4}\S/.test(ln)) {
        const body = [];
        while (i < lines.length && (!lines[i].trim() || /^ {4}/.test(lines[i]))) { body.push(lines[i].replace(/^ {4}/, "")); i += 1; }
        while (body.length && !body[body.length - 1].trim()) body.pop();
        out += `<pre><code>${body.join("\n")}\n</code></pre>`;
        continue;
      }

      if (/^ {0,3}(=+|-+)\s*$/.test(lines[i + 1] || "") && ln.trim()) {
        const lv = lines[i + 1].trim()[0] === "=" ? 1 : 2;
        out += `<h${lv} id="${esc(slug(ln))}">${inline(ln, ctx, hold)}</h${lv}>`;
        i += 2;
        continue;
      }

      const para = [];
      while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1] || "", peek)
        && !/^ {0,3}(=+|-+)\s*$/.test(lines[i + 1] || "")) { para.push(lines[i].trim()); i += 1; }
      if (para.length) out += `<p>${inline(para.join(" "), ctx, hold)}</p>`;
      else i += 1;
    }
    return out;
  }

  /** 围栏代码块必须比裸 HTML 更早摘出来：块里的 <b>、|表格|、**星号** 全都该按字面显示。
      内容在这里就地 esc（后面那次整体 esc 已经碰不到它了）。
      hold 分两种：\u0001 = 块级（独占一行时不再套 <p>），\u0000 = 行内。 */
  function liftFences(src, hold) {
    const lines = src.split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const m = lines[i].match(/^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/);
      if (!m) { out.push(lines[i]); i += 1; continue; }
      const mark = m[1][0]; const len = m[1].length;
      const lang = m[2].trim().split(/\s+/)[0] || "";
      const body = [];
      i += 1;
      const close = new RegExp(`^ {0,3}\\${mark}{${len},}[ \\t]*$`);
      while (i < lines.length && !close.test(lines[i])) { body.push(lines[i]); i += 1; }
      i += 1;
      out.push(hold(`<pre${lang ? attr("lang", lang) : ""}><code>${esc(body.join("\n"))}${body.length ? "\n" : ""}</code></pre>`, true));
    }
    return out.join("\n");
  }

  function gfm(md, ctx) {
    const store = [];
    const hold = (html, block) => { store.push(html); return `${block ? "\u0001" : "\u0000"}${store.length - 1}${block ? "\u0001" : "\u0000"}`; };
    let src = String(md || "").replace(/\r\n?/g, "\n");
    src = liftFences(src, hold);
    src = src.replace(/<picture\b[\s\S]*?<\/picture>/gi, (m) => hold(pictureHtml(m, ctx)));
    src = src.replace(/<!--[\s\S]*?-->/g, "");
    src = src.replace(/<\s*\/?\s*[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*?)?\/?>/g, (m) => tameTag(m, ctx, hold));
    src = esc(src);
    const peek = (k) => store[Number(k)] ?? "";
    let html = blocks(src, ctx, hold, peek);
    for (let n = 0; n <= store.length; n += 1) {
      const next = html.replace(/[\u0000\u0001](\d+)[\u0000\u0001]/g, (_, k) => store[Number(k)] ?? "");
      if (next === html) break;
      html = next;
    }
    return html;
  }

  /* ═══════════════════ 取数与变更检测 ═══════════════════
     平时靠 per-path Atom feed 查提交，正文走 raw 域名；Atom 不可用时才走 commits API，
     避免正常轮询消耗匿名 API 配额。添加仓库时用 README API 识别真实文件名与分支。 */

  const apiReadmeUrl = (owner, repo, ref) =>
    `https://api.github.com/repos/${owner}/${repo}/readme${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
  const readmePathOf = (r) => String(r.path || "").includes("/") ? r.path : `${r.dir || ""}${r.path}`;
  const rawUrlOf = (r) => `https://raw.githubusercontent.com/${r.owner}/${r.repo}/${r.branch}/${readmePathOf(r)}`;
  const atomUrlOf = (r) => `https://github.com/${r.owner}/${r.repo}/commits/${r.branch}/${readmePathOf(r)}.atom`;
  const commitsApiUrlOf = (r) => `https://api.github.com/repos/${r.owner}/${r.repo}/commits?path=${encodeURIComponent(readmePathOf(r))}&sha=${encodeURIComponent(r.branch)}&per_page=20`;
  const repoKey = (r) => `${r.owner}/${r.repo}`;

  const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  /** Atom 实体只解这一趟。&amp;lt; 二次解码就会变成活的 < —— 那是 XSS 入口。 */
  const decodeEnt = (s) => String(s).replace(/&(amp|lt|gt|quot|apos);/g, (m, k) => ENT[k]);

  function parseRepoRef(input) {
    const s = String(input || "").trim();
    if (!s) return null;
    const ssh = s.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
    if (ssh) return { owner: ssh[1], repo: ssh[2], ref: "" };
    const url = s.match(/^https?:\/\/(?:www\.)?github\.com\/(.+)$/i);
    let seg;
    if (url) seg = url[1].split("/").filter(Boolean);
    else if (/^[\w.-]+\/[\w.-]+$/.test(s)) seg = s.split("/");
    else return null;
    if (seg.length < 2) return null;
    // 裸写法只认两段：foo/bar/baz 到底是分支还是子路径猜不出来，宁可不接
    if (!url && seg.length > 2) return null;
    const clean = (v) => String(v).replace(/\.git$/, "").replace(/^\.+|\.+$/g, "");
    const owner = clean(seg[0]);
    const repo = clean(seg[1]);
    if (!owner || !repo) return null;
    return { owner, repo, ref: seg[2] === "tree" && seg[3] ? clean(seg[3]) : "" };
  }

  function parseReadmeMeta(text) {
    let j = null;
    try { j = JSON.parse(String(text || "")); } catch { return null; }
    const url = j && j.download_url;
    const path = j && j.path;
    if (!url || !path) return null;
    const m = String(url).match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/.+$/);
    if (!m) return null;
    return {
      owner: m[1], repo: m[2], branch: m[3], path: String(path),
      dir: String(path).includes("/") ? String(path).slice(0, String(path).lastIndexOf("/") + 1) : "",
    };
  }

  function atomEntries(xml) {
    const out = [];
    for (const m of String(xml || "").matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
      const e = m[1];
      const grab = (re) => { const hit = e.match(re); return hit ? hit[1] : ""; };
      const id = grab(/<id>([\s\S]*?)<\/id>/).trim();
      const sha = (id.match(/\/([^/]+)$/) || [, (id.match(/:([^:]+)$/) || [, ""])[1]])[1].trim();
      if (!sha) continue;
      out.push({
        sha,
        title: decodeEnt(grab(/<title>([\s\S]*?)<\/title>/)).replace(/\s+/g, " ").trim(),
        time: grab(/<updated>([\s\S]*?)<\/updated>/).trim(),
        author: decodeEnt((grab(/<author>([\s\S]*?)<\/author>/).match(/<name>([\s\S]*?)<\/name>/) || [, ""])[1]).trim(),
        url: grab(/<link[^>]*\bhref="([^"]*)"/),
      });
    }
    return out;
  }

  function apiEntries(body) {
    let rows;
    try { rows = JSON.parse(String(body || "")); } catch { return []; }
    if (!Array.isArray(rows)) return [];
    return rows.filter((row) => row && row.sha).map((row) => ({
      sha: String(row.sha), title: String(row.commit?.message || "").split("\n")[0],
      time: String(row.commit?.author?.date || ""), author: String(row.commit?.author?.name || ""),
      url: String(row.html_url || ""),
    }));
  }

  const state = {
    repos: [], docs: {}, seen: new Set(), known: {}, syncing: false, lastAt: 0, error: "", auto: true,
    async persist() {
      await tide.storage.set("repos", state.repos);
      await tide.storage.set("seen", [...state.seen].slice(-800));
      await tide.storage.set("known", state.known);
      await tide.storage.set("docs", state.docs);
    },
  };

  async function restore() {
    const repos = await tide.storage.get("repos", null);
    if (!Array.isArray(repos) || !repos.length) return false;
    state.repos = repos.filter((r) => r && r.owner && r.repo && r.branch && r.path);
    state.seen = new Set((await tide.storage.get("seen", [])) || []);
    state.known = (await tide.storage.get("known", null)) || {};
    state.docs = (await tide.storage.get("docs", null)) || {};
    state.repos.forEach(countUnread);
    publishCommits();
    return true;
  }

  /** 未读只看界面，绝不参与广播差分 —— 那个只在点开卡片时才写，
      拿它做差分等于每刷新一次就把没点开的旧提交重推一遍。 */
  function countUnread(repo) {
    repo.unread = repo.sha && !state.seen.has(`${repoKey(repo)}:${repo.sha}`) ? 1 : 0;
  }

  async function fetchHead(repo) {
    let res;
    let atomError = "";
    try { res = await tide.http.get(atomUrlOf(repo)); } catch (e) { atomError = String(e?.message || e); }
    if (res?.status === 403 || res?.status === 429) return { error: "GitHub 访问太频繁，歇一会儿再试", throttled: true };
    if (res?.status === 200) {
      const entries = atomEntries(res.body);
      if (entries.length) return { entries };
      atomError = "提交订阅为空";
    } else if (res) atomError = `HTTP ${res.status}`;
    try {
      const fallback = await tide.http.get(commitsApiUrlOf(repo));
      if (fallback.status === 403 || fallback.status === 429) return { error: "GitHub API 限流，请稍后重试", throttled: true };
      const entries = fallback.status === 200 ? apiEntries(fallback.body) : [];
      if (entries.length) return { entries };
      return { error: `提交记录拉取失败：订阅 ${atomError || "不可用"}；API HTTP ${fallback.status}` };
    } catch (e) {
      return { error: `提交记录拉取失败：订阅 ${atomError || "不可用"}；API ${String(e?.message || e)}`.slice(0, 180) };
    }
  }

  function publishCommits() {
    try {
      tide.messages?.publish(state.repos.filter((repo) => repo.commit).map((repo) => ({
        title: `${repoKey(repo)}：${repo.commit.title || "（无说明的提交）"}`,
        time: repo.commit.time || "", sender: repo.commit.author || repo.repo,
      })));
    } catch {}
  }

  async function fetchDoc(repo) {
    try {
      const res = await tide.http.get(rawUrlOf(repo));
      if (res.status !== 200) { repo.error = repo.error || `README 下载失败（HTTP ${res.status}）`; return false; }
      state.docs[repoKey(repo)] = String(res.body || "");
      repo.size = state.docs[repoKey(repo)].length;
      repo.at = Date.now();
      return true;
    } catch (e) {
      repo.error = repo.error || `README 下载失败：${e && e.message ? e.message : "网络异常"}`;
      return false;
    }
  }

  async function addRepo(input) {
    const ref = parseRepoRef(input);
    if (!ref) return { ok: false, error: "没认出来。填 owner/仓库名，或直接粘 GitHub 仓库链接" };
    if (state.repos.some((r) => r.owner === ref.owner && r.repo === ref.repo)) {
      return { ok: false, duplicate: true, error: `${ref.owner}/${ref.repo} 已经在列表里了` };
    }
    let res;
    try { res = await tide.http.get(apiReadmeUrl(ref.owner, ref.repo, ref.ref)); } catch { return { ok: false, error: "网络不通，查不到这个仓库" }; }
    const meta = res.status === 200 ? parseReadmeMeta(res.body) : null;
    if (!meta) {
      return { ok: false, error: res.status === 404 ? `没找到 ${ref.owner}/${ref.repo} 的 README` : `GitHub 返回 HTTP ${res.status}` };
    }
    const repo = {
      owner: meta.owner, repo: meta.repo, branch: meta.branch, dir: meta.dir, path: meta.path,
      sha: "", commit: null, at: 0, size: 0, error: "", unread: 0,
    };
    state.repos.push(repo);
    const head = await fetchHead(repo);
    if (head.entries) {
      repo.commit = head.entries[0];
      repo.sha = head.entries[0].sha;
      // 首次只播种：不播种的话下一轮会把整条历史当新提交推出去
      state.known[repoKey(repo)] = head.entries.map((e) => e.sha).slice(0, 40);
      await fetchDoc(repo);
    } else repo.error = head.error;
    state.lastAt = Date.now();
    countUnread(repo);
    publishCommits();
    await state.persist();
    return { ok: true, repo };
  }

  async function syncAll(forceKey = "") {
    if (state.syncing) return { skipped: true };
    state.syncing = true;
    const fresh = [];
    let throttled = false;
    try {
      for (const repo of state.repos) {
        const head = await fetchHead(repo);
        if (!head.entries) {
          repo.error = head.error;
          if (head.throttled) throttled = true;
          continue;
        }
        repo.error = "";
        const key = repoKey(repo);
        const had = Object.prototype.hasOwnProperty.call(state.known, key);
        const known = new Set(state.known[key] || []);
        const added = head.entries.filter((e) => !known.has(e.sha));
        state.known[key] = head.entries.map((e) => e.sha).slice(0, 40);
        if (had && added.length) fresh.push(...added.map((e) => ({ repo, e })));
        const newest = head.entries[0];
        if (repo.sha !== newest.sha || forceKey === key || !state.docs[key]) {
          repo.sha = newest.sha;
          repo.commit = newest;
          await fetchDoc(repo);
        }
        countUnread(repo);
      }
      state.lastAt = Date.now();
      publishCommits();
      if (fresh.length) {
        // 一轮只广播一次（多仓库攒成一条），省 PushPlus 频次；广播抛错不许影响抓取
        try {
          tide.events.emit("notice:new", {
            source: "github-readme", sourceName: "GitHub 文档", total: fresh.length,
            items: fresh.slice(0, 5).map(({ repo, e }) => ({
              title: `${repoKey(repo)}：${e.title || "（无说明的提交）"}`, time: e.time || "", sender: e.author || repo.repo,
            })),
          });
        } catch {}
      }
      await state.persist();
    } finally {
      state.syncing = false;
    }
    return { throttled };
  }

  function markSeen(key, sha) {
    state.seen.add(`${key}:${sha}`);
    const repo = state.repos.find((r) => repoKey(r) === key);
    if (repo) countUnread(repo);
    return state.persist();
  }

  /* ═══════════════════ 界面 ═══════════════════
     一个注册视图、页内两级（仓库列表 ⇄ README 阅读）。本文件不挂任何全屏遮罩或弹层，
     四条边的安全区一律由宿主 .view 负责，所以界面里一次都不碰宿主的安全区变量。 */

  const AUTO_MS = 10 * 60 * 1000;
  const page = { at: "list", key: "" };
  let rootEl = null;
  let renderEpoch = 0;
  const boundRoots = new WeakSet();
  let timer = null;

  // 右键/长按是快捷入口；常用编辑操作也在卡片上直接提供。
  let repoMenu = null;
  let repoMenuBound = false;
  /** 长按弹过菜单后浏览器还会补一个 click —— 不吞掉的话长按的同时顺手把阅读页打开了。 */
  let longPressed = false;
  const LONG_PRESS_MS = 550;
  const MENU_W = 196;
  const MENU_H = 168;
  const REPO_ICONS = ["📦", "📚", "🔧", "⚡", "🔒", "🤖", "🌱", "🚀", "🧪", "📝", "🎯", "🧭"];

  let editor = null;
  let adding = false;
  let inputDraft = "";
  let feedback = "";

  function openEditor(key, field = "name", remove = false) {
    const r = state.repos.find((x) => repoKey(x) === key);
    if (!r || editor?.saving) return;
    if (editor) {
      feedback = "请先保存或取消当前编辑，再操作其他仓库"; paint();
      rootEl?.querySelector("[data-gh-editor]")?.scrollIntoView?.({ block: "nearest" });
      return;
    }
    repoMenu = null;
    editor = { key, alias: r.alias || "", note: r.note || "", icon: r.icon || "", remove, saving: false, error: "" };
    paint();
    const panel = rootEl?.querySelector("[data-gh-editor]");
    panel?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    panel?.querySelector(remove ? "[data-gh-cancel]" : field === "icon" ? "[data-gh-edit-icon]" : `[data-gh-field="${field}"]`)?.focus();
  }

  function editorHtml() {
    if (!editor) return "";
    const d = editor;
    const busy = d.saving || state.syncing || adding ? " disabled" : "";
    return `<section class="gh-editor" data-gh-editor aria-label="${d.remove ? "移除仓库" : "编辑仓库"}" aria-busy="${d.saving}">
      <h3>${d.remove ? "移除仓库？" : "编辑仓库"}</h3>
      <p class="gh-sub">${esc(d.key)} · ${d.remove ? "仅移除本地追踪和缓存，不会删除 GitHub 仓库。" : "只修改本地展示，不影响 GitHub 仓库。"}</p>
      ${d.remove ? "" : `<label>显示名称 <span class="gh-sub">最多 40 字，留空恢复仓库名</span><input data-gh-field="name" maxlength="40" value="${esc(d.alias)}" placeholder="${esc(d.key)}"${busy}></label>
      <label>备注 <span class="gh-sub">最多 80 字</span><textarea data-gh-field="note" maxlength="80" rows="2" placeholder="记录用途或阅读计划"${busy}>${esc(d.note)}</textarea></label>
      <fieldset${busy}><legend>图标</legend><div class="gh-icon-grid">${["", ...REPO_ICONS].map((ic) => `<button type="button" class="gh-icon-cell${d.icon === ic ? " on" : ""}" data-gh-edit-icon="${esc(ic)}" aria-label="${ic ? `图标 ${esc(ic)}` : "不显示图标"}" aria-pressed="${d.icon === ic}"${busy}>${esc(ic || "无")}</button>`).join("")}</div></fieldset>`}
      <div class="gh-err" role="alert">${esc(d.error)}</div>
      <div class="gh-foot"><button type="button" class="gh-btn" data-gh-cancel${busy}>取消</button><button type="button" class="gh-btn" data-gh-save${busy}>${d.saving ? "保存中…" : state.syncing || adding ? "请等待当前操作…" : d.remove ? "确认移除" : "保存修改"}</button></div>
      <p class="gh-sub">${d.remove ? "" : "Enter 保存名称，Ctrl / ⌘ + Enter 保存备注；Esc 取消。"}</p>
    </section>`;
  }

  function closeEditor() {
    if (!editor || editor.saving) return;
    const key = editor.key;
    editor = null;
    paint();
    const btn = [...(rootEl?.querySelectorAll("[data-gh-edit]") || [])].find((x) => x.dataset.ghEdit === key);
    btn?.focus();
  }

  async function saveEditor() {
    if (!editor || editor.saving || state.syncing || adding) return;
    const d = editor;
    const r = state.repos.find((x) => repoKey(x) === d.key);
    if (!r) return closeEditor();
    d.saving = true; d.error = ""; paint();
    const updated = { ...r, alias: d.alias.trim().slice(0, 40), note: d.note.replace(/\s+/g, " ").trim().slice(0, 80), icon: d.icon };
    const repos = d.remove ? state.repos.filter((x) => x !== r) : state.repos.map((x) => x === r ? updated : x);
    try {
      // 先落盘再更新界面，保存失败保留用户草稿，不显示虚假的成功提示。
      await tide.storage.set("repos", repos);
      state.repos = repos;
      if (d.remove) {
        delete state.docs[d.key]; delete state.known[d.key];
        [...state.seen].forEach((x) => { if (x.startsWith(`${d.key}:`)) state.seen.delete(x); });
        try { await state.persist(); } catch { feedback = "仓库已移除，缓存清理未完成，将在下次保存时重试。"; }
      }
      feedback = (feedback.includes("缓存清理未完成") ? feedback : "") || (d.remove ? `已移除 ${d.key}，GitHub 仓库不受影响` : "修改已保存");
      d.saving = false;
      if (editor === d) closeEditor();
      if (rootEl?.isConnected) startTimer();
    } catch {
      d.saving = false; d.error = "保存失败，修改尚未生效。请重试或取消。";
      if (editor === d) paint();
    }
  }

  /** 卡片与阅读页共用的显示名：没改过名就是 owner/仓库名。 */
  const repoTitle = (r) => r.alias || repoKey(r);

  function ensureStyle() {
    if (document.getElementById("github-readme-style")) return;
    const st = document.createElement("style");
    st.id = "github-readme-style";
    st.textContent = `
      .gh-wrap{max-width:960px;margin:0 auto}
      .gh-editor{background:var(--panel);border:1px solid var(--deep);border-radius:13px;padding:16px;margin:12px 0}
      .gh-editor h3{margin:0;color:var(--ink)}
      .gh-editor label{display:block;margin:12px 0;color:var(--ink)}
      .gh-editor input,.gh-editor textarea{display:block;box-sizing:border-box;width:100%;margin-top:6px;padding:10px;font:inherit;color:var(--ink);background:var(--paper);border:1px solid var(--line);border-radius:8px}
      .gh-editor fieldset{border:0;padding:0;margin:12px 0;color:var(--ink)}
      .gh-editor .gh-icon-grid{display:flex;flex-wrap:wrap}
      .gh-editor :focus-visible{outline:2px solid var(--deep);outline-offset:2px}
      .gh-card-read{display:block;width:100%;text-align:left;background:none;border:0;padding:0;font:inherit;cursor:pointer;color:var(--ink)}
      .gh-card-read:focus-visible{outline:2px solid var(--deep);outline-offset:4px}
      .gh-foot{gap:8px;flex-wrap:wrap}
      .gh-status{color:var(--deep);font-size:13px;margin:8px 0;overflow-wrap:anywhere}
      .gh-bar{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin:0 0 10px}
      .gh-spacer{flex:1}
      .gh-title{color:var(--ink);font-size:calc(16px * var(--ui-text-scale));font-weight:700}
      .gh-sub{color:var(--ink-3);font-size:calc(11px * var(--ui-text-scale));overflow-wrap:anywhere}
      .gh-btn,.gh-back{font:inherit;font-size:calc(12.5px * var(--ui-text-scale));color:var(--deep);background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:0 14px;min-height:42px;cursor:pointer;transition:border-color .16s ease,background .16s ease;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
      .gh-btn:hover,.gh-back:hover{border-color:var(--deep);background:var(--paper)}
      .gh-btn:focus-visible,.gh-back:focus-visible,.gh-card:focus-visible{outline:3px solid var(--deep);outline-offset:2px}
      .gh-btn[disabled]{opacity:.5;cursor:default}
      .gh-add{display:flex;gap:8px;margin:0 0 12px}
      .gh-add input{flex:1;min-width:0;font:inherit;font-size:calc(13px * var(--ui-text-scale));color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:0 12px;min-height:42px}
      .gh-auto{display:flex;align-items:center;gap:7px;color:var(--ink-3);font-size:calc(11.5px * var(--ui-text-scale));margin:12px 0 4px;cursor:pointer}
      .gh-card{background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:12px 13px;margin:0 0 9px;cursor:pointer;transition:border-color .16s ease;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
      .gh-card:hover{border-color:var(--deep)}
      .gh-card b{display:block;color:var(--deep);font-size:calc(14.5px * var(--ui-text-scale));line-height:1.35;overflow-wrap:anywhere}
      .gh-card p{margin:5px 0 0;color:var(--ink);font-size:calc(12px * var(--ui-text-scale));line-height:1.55;overflow-wrap:anywhere}
      .gh-meta{margin-top:5px;color:var(--ink-3);font-size:calc(10.5px * var(--ui-text-scale));overflow-wrap:anywhere}
      .gh-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--coral,#F07167);margin-left:6px;vertical-align:middle}
      .gh-foot{display:flex;justify-content:flex-end;margin-top:4px}
      .gh-del{font:inherit;font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-3);background:transparent;border:0;border-radius:8px;padding:0 10px;min-width:44px;min-height:40px;cursor:pointer}
      .gh-del:hover{color:var(--coral,#F07167);background:var(--paper)}
      .gh-ico{display:inline-block;margin-right:7px;font-style:normal;font-weight:400}
      .gh-note{margin-top:3px;color:var(--ink-3);font-size:calc(11px * var(--ui-text-scale));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .gh-note-line{flex-basis:100%;color:var(--ink)}
      /* 右键菜单钉在视口坐标上（left/top 由 JS 写内联样式），所以这里刻意不写 top/left/right/bottom
         —— 一写就等于把宿主安全区当 0，手机上菜单会压进状态栏。 */
      .gh-menu{position:fixed;z-index:60;width:196px;max-height:min(340px,72vh);overflow:auto;display:grid;gap:2px;padding:6px;background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:0 12px 30px rgba(20,30,36,.18)}
      .gh-menu-title{color:var(--deep);font-size:calc(11.5px * var(--ui-text-scale));font-weight:750;padding:6px 9px 7px;margin-bottom:4px;border-bottom:1px solid var(--line-soft);overflow-wrap:anywhere}
      .gh-menu-item{display:block;width:100%;min-height:38px;padding:0 9px;border:0;border-radius:8px;background:transparent;color:var(--ink);font-family:inherit;font-size:calc(12.5px * var(--ui-text-scale));text-align:left;cursor:pointer;overflow-wrap:anywhere}
      .gh-menu-item:hover{background:var(--paper)}
      .gh-icon-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;padding:2px 3px 6px}
      .gh-icon-cell{min-height:40px;font-size:calc(18px * var(--ui-text-scale));line-height:1;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--ink);cursor:pointer}
      .gh-icon-cell.none{font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-3)}
      .gh-icon-cell.on{border-color:var(--deep);background:var(--paper)}
      .gh-err{color:var(--coral,#C4534A);font-size:calc(11px * var(--ui-text-scale));margin-top:6px;overflow-wrap:anywhere}
      .gh-empty{color:var(--ink-3);font-size:calc(12.5px * var(--ui-text-scale));text-align:center;padding:26px 14px;border:1px dashed var(--line);border-radius:13px;line-height:1.8}
      .gh-md{color:var(--ink);font-size:calc(13.5px * var(--ui-text-scale));line-height:1.78}
      .gh-md h1,.gh-md h2,.gh-md h3,.gh-md h4,.gh-md h5,.gh-md h6{color:var(--deep);margin:1.5em 0 .5em;line-height:1.4;overflow-wrap:anywhere}
      .gh-md h1{font-size:calc(21px * var(--ui-text-scale));border-bottom:1px solid var(--line);padding-bottom:.3em}
      .gh-md h2{font-size:calc(17.5px * var(--ui-text-scale));border-bottom:1px solid var(--line-soft);padding-bottom:.25em}
      .gh-md h3{font-size:calc(15px * var(--ui-text-scale))}
      .gh-md p{margin:.75em 0;overflow-wrap:anywhere}
      .gh-md a{color:var(--deep);text-decoration:underline}
      .gh-md code{color:var(--ink);background:var(--paper);border:1px solid var(--line-soft);border-radius:5px;padding:.12em .38em;font-family:ui-monospace,Consolas,monospace;font-size:.88em}
      .gh-md pre{background:var(--paper);border:1px solid var(--line);border-radius:11px;padding:12px 13px;margin:.9em 0;overflow-x:auto;overscroll-behavior-x:contain;-webkit-overflow-scrolling:touch}
      .gh-md pre code{background:none;border:0;padding:0;color:var(--ink);font-size:calc(12px * var(--ui-text-scale));white-space:pre;overflow-wrap:normal}
      .gh-md pre[lang]::before{content:attr(lang);display:block;color:var(--ink-3);font-size:calc(10px * var(--ui-text-scale));margin-bottom:7px;letter-spacing:.06em}
      .gh-md blockquote{margin:.85em 0;padding:.15em 0 .15em 14px;border-left:3px solid var(--line);color:var(--ink-3)}
      .gh-md ul,.gh-md ol{margin:.6em 0;padding-left:1.5em}
      .gh-md li{margin:.28em 0}
      .gh-md ul.task{list-style:none;padding-left:.25em}
      .gh-md ul.task>li::before{content:"\\25A2\\00a0";color:var(--ink-3)}
      .gh-md ul.task>li.on::before{content:"\\25A3\\00a0";color:var(--deep)}
      .gh-md hr{border:0;border-top:1px solid var(--line);margin:1.6em 0}
      /* 只写 max-width，不写 height:auto —— 那是响应式图片的常规配方，但 README 里的 SVG
         常常只报宽高比不报固有尺寸，height:auto 会连作者写的 height="60" 一起覆盖掉，
         结果按容器满宽铺（实测 vite 的 logo 被拉成 860×148）。GitHub 自己也只写 max-width。 */
      .gh-md img{max-width:100%}
      .gh-md .gh-img-off{display:inline-block;margin:.2em .3em;color:var(--ink-3);font-size:calc(11.5px * var(--ui-text-scale));border:1px dashed var(--line);border-radius:8px;padding:5px 9px;text-decoration:none}
      /* .gh-picture 必须是 inline：它是 inline-block 时，里面 img 的 max-width:100%
         要按自己父亲的宽度算，而父亲的宽度又由这个子元素撑 —— Chrome 解成 0 宽，logo 直接消失。 */
      .gh-md .gh-picture{display:inline}
      .gh-scroll{margin:.9em 0;overflow-x:auto;overscroll-behavior-x:contain;-webkit-overflow-scrolling:touch}
      /* 不给 table 写 max-width:100%：写了它，超宽表格就被压扁换行，外层 .gh-scroll 永远滚不起来
         （实测 190px 容器里表格自己缩成 190），等于白套一层滚动容器。让它保持内容宽度、由外层滚。 */
      .gh-md table{border-collapse:collapse;width:max-content;font-size:calc(12.5px * var(--ui-text-scale))}
      .gh-md th,.gh-md td{border:1px solid var(--line);padding:6px 11px;text-align:left;vertical-align:top;overflow-wrap:anywhere}
      .gh-md th{color:var(--deep);background:var(--paper);font-weight:650}
      .gh-md tbody tr:nth-child(even){background:var(--paper)}
      .gh-md [align="center"]{text-align:center}
      .gh-md [align="right"]{text-align:right}
      .gh-center{text-align:center}
      .gh-left{text-align:left}
      .gh-right{text-align:right}
      .gh-theme-dark{display:none}
      [data-theme-mode="dark"] .gh-theme-dark{display:inline-block}
      [data-theme-mode="dark"] .gh-theme-light{display:none}
    `;
    document.head.append(st);
  }

  const pad2 = (n) => String(n).padStart(2, "0");
  /** Atom 的时间是 UTC（带 Z），必须按 UTC 解析后再按本地时区显示，否则差一个时区。 */
  function fmtTime(iso) {
    const s = String(iso || "").trim();
    if (!s) return "时间未知";
    const d = new Date(/Z|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`);
    if (Number.isNaN(d.getTime())) return s;
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  const kb = (n) => (n > 0 ? `${(n / 1024).toFixed(1)} KB` : "—");

  function repoCard(r) {
    const k = repoKey(r);
    const c = r.commit || {};
    return `<article class="gh-card" data-gh-card="${esc(k)}"><button type="button" class="gh-card-read" data-gh-open="${esc(k)}" aria-label="阅读 ${esc(k)} 的 README">
      <b>${r.icon ? `<i class="gh-ico">${esc(r.icon)}</i>` : ""}${esc(repoTitle(r))}${r.unread ? '<i class="gh-dot" aria-label="有未读更新"></i>' : ""}</b>
      ${r.alias ? `<div class="gh-sub">${esc(k)}</div>` : ""}
      ${r.note ? `<div class="gh-note">${esc(r.note)}</div>` : ""}
      <p>${esc(c.title || "（还没读到提交记录）")}</p>
      <div class="gh-meta">${esc(r.branch)} · ${esc(c.author || "作者未知")} · ${esc(fmtTime(c.time))} · README ${esc(kb(r.size))}</div>
      <span class="gh-sub">阅读 README →</span></button>
      ${r.error ? `<div class="gh-err">${esc(r.error)}</div>` : ""}
      <div class="gh-foot"><button type="button" class="gh-btn" data-gh-edit="${esc(k)}" aria-label="编辑 ${esc(k)}">编辑</button><button type="button" class="gh-del" data-gh-del="${esc(k)}" aria-label="从列表移除 ${esc(k)}">移除</button></div>
    </article>`;
  }

  /** 右键菜单。菜单项刻意与卡片上已有的动作分开命名空间（data-gh-menu-act），
      否则事件委托里 [data-gh-open] 分支会先把点击抢走。 */
  function repoMenuHtml() {
    if (!repoMenu) return "";
    const r = state.repos.find((x) => repoKey(x) === repoMenu.key);
    if (!r) return "";
    const item = (act, label) => `<button type="button" role="menuitem" class="gh-menu-item" data-gh-menu-act="${act}">${esc(label)}</button>`;
    const head = `<div class="gh-menu" data-gh-menu role="menu" aria-label="仓库操作" style="left:${repoMenu.x}px;top:${repoMenu.y}px">`
      + `<span class="gh-menu-title">${esc(r.icon ? `${r.icon} ` : "")}${esc(repoTitle(r))}</span>`;
    return `${head}${item("name", "修改名称")}${item("note", r.note ? "修改备注" : "添加备注")}${item("icon", "更改图标")}</div>`;
  }

  function openRepoMenu(key, x, y) {
    // ⚠️ 视口坐标从屏幕角量起，而 fixed 的包含块是宿主 .view 的 padding box —— .view 垫掉的
    // 安全区拦不住 fixed 后代，夹取必须自己减掉四边（读法同宿主 bottomInsetPx()）。
    const px = (v) => { try { return parseFloat(getComputedStyle(document.documentElement).getPropertyValue(v)) || 0; } catch { return 0; } };
    const [sat, sab, sal, sar] = [px("--sat"), px("--sab"), px("--sal"), px("--sar")];
    if (editor) return;
    const h = MENU_H;
    repoMenu = {
      key,
      x: Math.max(8 + sal, Math.min(x, (window.innerWidth || 1024) - sar - MENU_W)),
      y: Math.max(8 + sat, Math.min(y, (window.innerHeight || 768) - sab - h)),
      step: "",
    };
    paint();
    rootEl?.querySelector("[data-gh-menu-act]")?.focus();
  }
  function closeRepoMenu() { if (!repoMenu) return; repoMenu = null; paint(); }

  function runRepoMenu(act, picked) {
    if (!repoMenu) return;
    const r = state.repos.find((x) => repoKey(x) === repoMenu.key);
    if (!r) { repoMenu = null; return paint(); }
    openEditor(repoKey(r), act === "note" ? "note" : act === "icon" ? "icon" : "name");
  }

  function listHtml() {
    const cards = state.repos.length
      ? state.repos.map(repoCard).join("")
      : `<div class="gh-empty">还没有追踪的仓库。上面填 <b>owner/仓库名</b>，或者直接把 GitHub 仓库链接粘进来 —— 只读 README 那一个文件，不会去碰源码。</div>`;
    return `<div class="gh-wrap">
      <div class="gh-bar">
        <b class="gh-title">GitHub 文档</b>
        <span class="gh-sub">${state.lastAt ? `上次同步 ${fmtTime(new Date(state.lastAt).toISOString())}` : "还没同步过"}${state.syncing ? " · 同步中…" : ""} · 共 ${state.repos.length} 个仓库</span>
        <span class="gh-spacer"></span>
        <button type="button" class="gh-btn" data-gh-sync${state.syncing || adding || editor?.saving ? " disabled" : ""}>${state.syncing ? "同步中…" : "同步全部"}</button>
      </div>
      <div class="gh-add">
        <input type="text" data-gh-input value="${esc(inputDraft)}" placeholder="owner/repo，或仓库链接" aria-label="要追踪的 GitHub 仓库">
        <button type="button" class="gh-btn" data-gh-add${adding || state.syncing || editor?.saving ? " disabled" : ""}>${adding ? "添加中…" : "添加仓库"}</button>
      </div>
      ${state.error ? `<div class="gh-err">${esc(state.error)}</div>` : ""}
      <div class="gh-status" role="status" aria-live="polite">${esc(feedback)}</div>
      ${editorHtml()}
      ${cards}
      <label class="gh-auto"><input type="checkbox" data-gh-auto${state.auto ? " checked" : ""}>开着本页时每 10 分钟自动同步</label>
      ${repoMenuHtml()}
    </div>`;
  }

  /** 表格套一层横向滚动容器：README 里的对照表经常超宽，压行会挤成一团。
      gfm() 只产不带属性的 <table>，所以这里成对替换是安全的。 */
  function mdHtml(doc, r) {
    return gfm(doc, { owner: r.owner, repo: r.repo, branch: r.branch, dir: r.dir })
      .replace(/<table>/g, '<div class="gh-scroll"><table>').replace(/<\/table>/g, "</table></div>");
  }

  function readerHtml(r) {
    const doc = state.docs[repoKey(r)] || "";
    const c = r.commit || {};
    return `<div class="gh-wrap">
      <div class="gh-bar">
        <button type="button" class="gh-back" data-gh-back>← 返回</button>
        <b class="gh-title">${r.icon ? `<span class="gh-ico">${esc(r.icon)}</span>` : ""}${esc(repoTitle(r))}</b>
        <span class="gh-sub">${esc(r.branch)} · ${esc(r.path)}</span>
        ${r.note ? `<span class="gh-sub gh-note-line">${esc(r.note)}</span>` : ""}
      </div>
      <div class="gh-bar">
        <span class="gh-sub">最近改动：${esc(c.title || "未知")} · ${esc(c.author || "未知")} · ${esc(fmtTime(c.time))}</span>
        <span class="gh-spacer"></span>
        <button type="button" class="gh-btn" data-gh-web>在 GitHub 打开</button>
        <button type="button" class="gh-btn" data-gh-todo>记为待办</button>
        <button type="button" class="gh-btn" data-gh-sync-one${state.syncing ? " disabled" : ""}>${state.syncing ? "拉取中…" : "重新拉取"}</button>
      </div>
      ${r.error ? `<div class="gh-err">${esc(r.error)}</div>` : ""}
      <div class="gh-status" role="status" aria-live="polite">${esc(feedback || state.error)}</div>
      ${doc ? `<div class="gh-md">${mdHtml(doc, r)}</div>` : `<div class="gh-empty">${esc(r.error || "还没拉到 README 正文，点上方「重新拉取」")}</div>`}
    </div>`;
  }

  function paint() {
    if (!rootEl || !rootEl.isConnected) return;
    // 整页是 innerHTML 重绘的：自动同步正好赶上用户在输入框里打字时，不护住就把半截仓库名抹掉
    const typed = rootEl.querySelector("[data-gh-input]");
    const active = document.activeElement;
    const field = active?.dataset?.ghField;
    const start = active?.selectionStart;
    const end = active?.selectionEnd;
    const draft = typed && active === typed ? inputDraft : null;
    const repo = state.repos.find((r) => repoKey(r) === page.key);
    if (page.at === "reader" && repo) rootEl.innerHTML = readerHtml(repo);
    else { page.at = "list"; page.key = ""; rootEl.innerHTML = listHtml(); }
    if (field && editor) {
      const next = rootEl.querySelector(`[data-gh-field="${field}"]`);
      next?.focus(); if (typeof start === "number") next?.setSelectionRange?.(start, end);
    }
    if (draft != null) {
      const next = rootEl.querySelector("[data-gh-input]");
      if (next) { next.value = draft; next.focus(); }
    }
  }

  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }
  function startTimer() {
    stopTimer();
    if (!state.auto || !state.repos.length) return;
    timer = setInterval(async () => {
      if (!rootEl || !rootEl.isConnected || document.visibilityState === "hidden" || state.syncing || adding || editor) return;
      await doSync();
    }, AUTO_MS);
  }

  async function doSync(forceKey = "") {
    if (state.syncing || adding || editor?.saving) return;
    state.error = ""; feedback = "";
    // syncAll 自己持有忙碌锁；不能提前置 true，否则它会直接 skipped。
    const pending = syncAll(forceKey);
    paint();
    try {
      const res = await pending;
      feedback = res?.throttled ? "GitHub 访问频繁，请稍后重试" : state.repos.some((r) => r.error) ? "同步结束，部分仓库失败，请查看卡片提示" : "同步完成";
    } catch { state.error = "同步未完成，可能是网络或本地保存失败，请重试。"; }
    finally { paint(); }
  }

  async function doAdd(el) {
    if (adding || state.syncing || editor?.saving) return;
    const input = el.querySelector("[data-gh-input]");
    const text = (input?.value || inputDraft).trim();
    inputDraft = text;
    if (!text) { state.error = "请输入 owner/repo 或 GitHub 仓库链接"; paint(); return; }
    adding = true; state.error = ""; feedback = ""; paint();
    try {
      const res = await addRepo(text);
      if (!res.ok) state.error = res.error;
      else { inputDraft = ""; feedback = `已添加 ${repoKey(res.repo)}`; }
    } catch { state.error = "添加未完成，请检查网络和本地存储；若仓库已出现在列表中，请同步重试。"; }
    finally { adding = false; startTimer(); paint(); }
  }

  function bind(el) {
    if (boundRoots.has(el)) return;
    boundRoots.add(el);
    el.addEventListener("click", async (e) => {
      if (e.target.closest("[data-gh-cancel]")) { closeEditor(); return; }
      if (e.target.closest("[data-gh-save]")) { await saveEditor(); return; }
      const editIcon = e.target.closest("[data-gh-edit-icon]");
      if (editIcon && editor && !editor.saving) {
        editor.icon = editIcon.dataset.ghEditIcon;
        rootEl.querySelectorAll("[data-gh-edit-icon]").forEach((btn) => {
          const on = btn.dataset.ghEditIcon === editor.icon;
          btn.classList.toggle("on", on); btn.setAttribute("aria-pressed", String(on));
        });
        return;
      }
      const edit = e.target.closest("[data-gh-edit]");
      if (edit) { feedback = ""; openEditor(edit.dataset.ghEdit); return; }
      const act = e.target.closest("[data-gh-menu-act]");
      if (act) { runRepoMenu(act.dataset.ghMenuAct); return; }
      const del = e.target.closest("[data-gh-del]");
      if (del) { feedback = ""; openEditor(del.dataset.ghDel, "name", true); return; }
      const open = e.target.closest("[data-gh-open]");
      if (open) {
        if (editor) { feedback = "请先保存或取消正在编辑的仓库"; paint(); return; }
        if (longPressed) { longPressed = false; return; }   // 长按弹过菜单，这个 click 是它的尾巴
        repoMenu = null;
        page.at = "reader";
        page.key = open.dataset.ghOpen;
        // 读过了就清未读点：否则回到列表它一直红着，点多少次都不消失
        const target = state.repos.find((r) => repoKey(r) === page.key);
        if (target && target.sha) markSeen(repoKey(target), target.sha);
        paint();
        return;
      }
      if (e.target.closest("[data-gh-back]")) { repoMenu = null; page.at = "list"; page.key = ""; paint(); return; }
      if (e.target.closest("[data-gh-add]")) { await doAdd(el); return; }
      if (e.target.closest("[data-gh-sync]") || e.target.closest("[data-gh-sync-one]")) { await doSync(e.target.closest("[data-gh-sync-one]") ? page.key : ""); return; }
      const repo = state.repos.find((r) => repoKey(r) === page.key);
      if (e.target.closest("[data-gh-web]") && repo) {
        tide.util.openUrl(`https://github.com/${repo.owner}/${repo.repo}/blob/${repo.branch}/${repo.path}`);
        return;
      }
      if (e.target.closest("[data-gh-todo]") && repo) {
        const c = repo.commit || {};
        tide.tasks.create({
          title: `看 ${repoTitle(repo)} 的 README 更新：${c.title || "（无说明）"}`.slice(0, 120),
          quad: 1,
          tags: ["GitHub 文档"],
          note: [`仓库：${repoKey(repo)}`, `分支：${repo.branch}`, `改动：${c.title || ""}`, `作者：${c.author || ""}`, `时间：${fmtTime(c.time)}`, c.url || ""].filter(Boolean).join("\n"),
        });
        tide.notify("已存成待办");
        markSeen(repoKey(repo), repo.sha);
        paint();
      }
    });
    // 右键仓库卡片 → 改名 / 备注 / 图标。只对卡片 preventDefault：
    // 别处保留浏览器原生菜单（右键往输入框里粘仓库链接还用得上）。
    el.addEventListener("contextmenu", (e) => {
      const card = e.target.closest?.("[data-gh-card]");
      if (!card) return;
      e.preventDefault();
      openRepoMenu(card.dataset.ghCard, e.clientX, e.clientY);
    });
    // Android WebView 长按普通节点不一定触发 contextmenu，只能自己数时间（同 dorm-duty 的标签页）。
    // 按下后挪开 10px 以上算滑动，不该弹菜单。
    let pressTimer = null;
    let pressAt = null;
    const clearPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
    el.addEventListener("pointerdown", (e) => {
      const card = e.target.closest?.("[data-gh-card]");
      clearPress();
      // 新的一次按下就是新意图：不清掉上次残留的标志，它会白吞掉一次正常点击
      longPressed = false;
      if (!card || e.button === 2 || e.target.closest("[data-gh-edit],[data-gh-del]")) return;
      pressAt = { x: e.clientX, y: e.clientY };
      pressTimer = setTimeout(() => {
        pressTimer = null;
        if (rootEl !== el || !el.isConnected) return;
        longPressed = true;
        openRepoMenu(card.dataset.ghCard, pressAt.x, pressAt.y);
      }, LONG_PRESS_MS);
    });
    el.addEventListener("pointermove", (e) => {
      if (pressTimer && pressAt && Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y) > 10) clearPress();
    });
    el.addEventListener("pointerup", clearPress);
    el.addEventListener("pointercancel", clearPress);
    el.addEventListener("input", (e) => {
      if (e.target.matches("[data-gh-input]")) inputDraft = e.target.value;
      if (!editor || editor.saving) return;
      if (e.target.dataset.ghField === "name") editor.alias = e.target.value;
      if (e.target.dataset.ghField === "note") editor.note = e.target.value;
    });
    el.addEventListener("keydown", async (e) => {
      if (e.isComposing) return;
      if (repoMenu && ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        const items = [...el.querySelectorAll("[data-gh-menu-act]")];
        const at = items.indexOf(document.activeElement);
        const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        e.preventDefault(); items[next]?.focus(); return;
      }
      if (editor && e.key === "Escape") { e.preventDefault(); closeEditor(); return; }
      if (editor && e.key === "Enter" && (e.target.dataset.ghField === "name" || ((e.ctrlKey || e.metaKey) && e.target.dataset.ghField === "note"))) { e.preventDefault(); await saveEditor(); return; }
      if (e.key === "Enter" && e.target.matches("[data-gh-input]")) { e.preventDefault(); await doAdd(el); }
      // 阅读入口是原生 button，Enter / Space 统一走 click，包括已读逻辑。
    });
    // 菜单的收起：点别处 / 滚动 / 改窗口尺寸。挂在 document 上且只绑一次 ——
    // 宿主元素每次 render 可能重建，绑在 el 上会随重建丢失。
    if (!repoMenuBound) {
      repoMenuBound = true;
      document.addEventListener("pointerdown", (e) => {
        const t = e.target;
        // 点菜单自身留给 click；点卡片由上面的长按分支负责重新定位
        if (t instanceof Element && (t.closest("[data-gh-menu]") || t.closest("[data-gh-open]"))) return;
        if (e.button === 2) return;
        closeRepoMenu();
      }, true);
      document.addEventListener("scroll", () => closeRepoMenu(), true);
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeRepoMenu(); });
      window.addEventListener("resize", () => closeRepoMenu());
    }
    el.addEventListener("change", (e) => {
      if (!e.target.matches("[data-gh-auto]")) return;
      state.auto = e.target.checked;
      tide.storage.set("auto", state.auto);
      startTimer();
    });
  }

  function render(el) {
    ensureStyle();
    editor = null; repoMenu = null;
    const epoch = ++renderEpoch;
    rootEl = el;
    el.innerHTML = '<div class="gh-wrap"><div class="gh-empty">正在读取已追踪的仓库…</div></div>';
    (async () => {
      try {
        await restore();
        state.auto = (await tide.storage.get("auto", true)) !== false;
      } catch { state.error = "读取本地仓库失败，请重新进入页面重试。"; }
      if (epoch !== renderEpoch || rootEl !== el) return;
      paint();
      // 首次进入即同步；刚同步过 60 秒内不重复打（切标签页回来不该白挨一轮）
      if (state.repos.length && Date.now() - state.lastAt > 60_000) await doSync();
      if (epoch === renderEpoch && rootEl === el) startTimer();
    })();
    bind(el);
    return () => { if (epoch !== renderEpoch) return; renderEpoch++; stopTimer(); editor = null; repoMenu = null; rootEl = null; };
  }

  tide.ui.registerView({ id: "github-readme", title: "GitHub 文档", icon: "code-branch", render });
})();
