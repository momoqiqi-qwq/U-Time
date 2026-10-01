(function () {
  const sites = {
    webvpn: { title: "WebVPN · 校外访问", host: "webvpn.cppu.edu.cn", action: "打开官方登录与资源页", intro: "从校外访问校内资源，在学校自己的页面完成统一身份认证。", steps: ["打开应用内网页窗口", "在官方认证页面登录", "从 WebVPN 资源目录进入教务、图书馆等学校提供的站点"], note: "资源范围以学校授权目录为准。请在该窗口内继续访问，不要复制带票据的地址，也不要将 WebVPN 登录等同于门户插件已登录。" },
    website: { title: "警大官网", host: "www.cppu.edu.cn", action: "在应用内查看警大官网", intro: "查看学校新闻、公开通知与官方信息。无需将官网内容抓取到插件，也不会缓存登录信息。", steps: ["打开中国人民警察大学官网", "在原始页面浏览新闻与通知", "需要校内资源时返回 WebVPN 页面登录"], note: "公网官网和 WebVPN 是不同入口。校内受限站点请从 WebVPN 授权资源目录进入。" }
  };
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function styles() {
    if (document.getElementById("cppu-webvpn-style")) return;
    const style = document.createElement("style"); style.id = "cppu-webvpn-style";
    style.textContent = `.cv-wrap{max-width:1020px;margin:auto;padding:24px 12px;color:var(--ink,#22303a)}.cv-eyebrow{letter-spacing:.14em;font-size:11px;color:var(--accent,#0f4c5c);font-weight:700}.cv-wrap h2{margin:8px 0;font-size:28px}.cv-wrap p{color:var(--muted,#687780);line-height:1.8}.cv-tabs{display:flex;gap:8px;margin:24px 0 16px}.cv-wrap button{border-radius:10px;border:1px solid var(--border,#ddd);padding:11px 16px;background:var(--card,#fff);color:inherit;cursor:pointer;min-height:44px}.cv-tabs [aria-selected=true],.cv-wrap .cv-open{background:var(--accent,#0f4c5c);color:#fff;border-color:transparent}.cv-card{border:1px solid var(--border,#ddd);background:var(--card,#fff);padding:28px;border-radius:20px}.cv-address{font-family:monospace;overflow-wrap:anywhere;color:var(--accent,#0f4c5c);font-size:14px}.cv-card ol{display:grid;gap:16px;line-height:1.6;margin:24px 0;padding-left:24px}.cv-foot{font-size:12px;border-top:1px solid var(--border,#ddd);margin-top:24px;padding-top:14px}.cv-status{min-height:26px}.cv-wrap button:disabled{opacity:.6;cursor:wait}.cv-wrap button:focus-visible{outline:2px solid var(--accent,#0f4c5c);outline-offset:3px}@media(max-width:600px){.cv-wrap{padding:14px 8px}.cv-card{padding:18px}.cv-wrap h2{font-size:23px}.cv-tabs button{flex:1}.cv-open{width:100%}}`;
    document.head.append(style);
  }
  function render(root) {
    styles(); let selected = "webvpn", busy = false, status = "", alive = true;
    function paint() {
      if (!alive) return;
      const site = sites[selected];
      root.innerHTML = `<section class="cv-wrap"><div class="cv-eyebrow">CPPU · CAMPUS ACCESS</div><h2>警大 WebVPN / 网站</h2><p>独立校园网站工作区 · 登录及资源访问交由官方页面处理</p><nav class="cv-tabs" role="tablist" aria-label="校园网站">${Object.entries(sites).map(([id,s]) => `<button type="button" role="tab" id="cv-tab-${id}" aria-controls="cv-panel" aria-selected="${selected===id}" data-site="${id}" ${busy ? "disabled" : ""}>${s.title}</button>`).join("")}</nav><section class="cv-card" id="cv-panel" role="tabpanel" aria-labelledby="cv-tab-${selected}"><div class="cv-address">https://${site.host}/</div><h3>${site.title}</h3><p>${site.intro}</p><ol>${site.steps.map(step => `<li>${step}</li>`).join("")}</ol><button type="button" class="cv-open" data-open ${busy ? "disabled" : ""}>${busy ? "正在打开…" : site.action}</button><p class="cv-status" role="status">${esc(status)}</p><p>${site.note}</p><p class="cv-foot">客户端使用独立的应用内网页窗口展示完整站点，不使用 iframe，也不绕过网站安全限制。浏览器调试版会打开浏览器窗口。登录是否成功以官方页面为准；插件不收集密码、不读取会话，也不会自行重试官方登录。</p></section></section>`;
      root.querySelectorAll("[data-site]").forEach(button => {
        button.onclick = () => { selected = button.dataset.site; status = ""; paint(); root.querySelector(`[data-site="${selected}"]`)?.focus(); };
        button.onkeydown = event => { if (!["ArrowLeft","ArrowRight","Home","End"].includes(event.key)) return; event.preventDefault(); selected = event.key === "Home" ? "webvpn" : event.key === "End" ? "website" : selected === "webvpn" ? "website" : "webvpn"; status="";paint();root.querySelector(`[data-site="${selected}"]`)?.focus(); };
      });
      root.querySelector("[data-open]").onclick = async () => {
        if (busy) return; busy=true; status="";
        // 在真实用户点击的同步栈里调用，避免 Web 调试版遭遇异步弹窗拦截。
        try { const opening = tide.util.openCampusSite(selected); paint(); const result = await opening; status = result?.mode === "native" ? "已打开应用内网页窗口，请在窗口内完成登录并继续访问。" : "浏览器环境：已打开官方站点窗口。"; }
        catch (error) { status = `打开失败：${error?.message || "请检查客户端及网络后重试"}`; }
        finally { busy=false;paint();if(alive)root.querySelector("[data-open]")?.focus(); }
      };
    }
    paint();return () => {alive=false;};
  }
  tide.ui.registerView({ id: "cppu-webvpn", title: "警大 WebVPN / 网站", icon: "shield-halved", render });
})();
