// 局域网联动服务：Win 作为控制端，手机浏览器/小程序通过本服务查看与操作
// 安全：所有 /m、/api、/qr.svg 请求都需要配对令牌（token）
//
// 本服务默认对数据**只读**：/api/state 与 /api/info 供手机端「局域网直连」拉快照用，
// 唯一的常规写入口是 /api/command 那两条动作（勾选任务 / 快速添加），且一律经前端
// 统一数据层落盘。想隔着一根网线覆盖整台设备的数据，默认没有对应的路由 ——
// 这是刻意的：手机 → 电脑的推送一旦开出来，同网段里任何拿到配对码的人都能抹掉电脑数据。
//
// ## 回传通道（/api/push）：默认关闭，开了也要电脑端点头
//
// 上面那条理由只在「偷偷就能改」的时候成立，所以 /api/push 把三道门全部叠上：
//   ① 桌面端设置里「允许手机推回本机」默认关 —— 关着直接 403，网络上看不到这条路；
//   ② 即使开着，本服务**一个字节都不往数据文件里写**：收到的快照只放进内存里的一次性
//      暂存槽，同时广播 lan-push-incoming 让桌面端弹窗；用户在弹窗里点「接收」才算数，
//      没点、点了拒、或者人根本不在电脑前，手机侧轮询到的就是 pending/rejected/超时；
//      ③ 真正落盘的只有前端，且覆盖前先存一个恢复点。
// Rust 侧不碰 data.json 是硬规矩：前端内存里有一份在用，服务端直接写盘会被它下一次
// 防抖写盘整份盖掉（这条与 /api/command 同源）。
//
// 还有个小前提：tiny_http 是**单线程顺序**处理请求的，所以确认绝不能写成「HTTP 线程
// 阻塞等人点按钮」—— 那会在等待期间把手机遥控页、/api/info 一起卡死。因此回传是
// 「POST 立即拿 202 pending → GET /api/push-status 轮询结果」两段式，谁都不占着线程。
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

const MOBILE_HTML: &str = include_str!("mobile.html");

/// 回传快照的大小上限。正常一份 data.json 几百 KB，8 MB 已经足够宽松，
/// 又挡掉了「拿配对码发个巨型 body 把电脑内存吃掉」这条路。
const PUSH_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// 一次待确认的回传。整个服务同时只留一条：新的顶掉旧的 ——
/// 电脑端一次只弹一个框，留着上一条会把「该点哪个」变成谜。
pub struct PendingPush {
    pub id: String,
    /// 快照原文。确认后前端取走；终端态（accepted/rejected）一律清空，只留状态给手机轮询。
    pub body: String,
    /// pending | accepted | rejected
    pub status: String,
    /// 为什么拒。人不在电脑前被自动取消，与电脑端真点了「拒绝」是两件事，
    /// 手机上看到的话必须分得清（不然用户会以为家里有人在动他数据）。
    pub note: String,
}

/// 回传暂存槽。克隆的是 Arc，所以服务线程、Tauri 命令、桌面端前端看到的是同一份。
#[derive(Clone, Default)]
pub struct PushSlot {
    seq: Arc<AtomicU64>,
    current: Arc<Mutex<Option<PendingPush>>>,
}

impl PushSlot {
    fn next_id(&self) -> String {
        format!("p{}", self.seq.fetch_add(1, Ordering::Relaxed) + 1)
    }

    fn store(&self, push: PendingPush) {
        if let Ok(mut slot) = self.current.lock() {
            *slot = Some(push);
        }
    }

    /// 手机轮询自己的那次推送是什么结果。id 对不上说明已被更新的推送顶掉，按拒绝回。
    fn poll(&self, id: &str) -> serde_json::Value {
        let Ok(mut slot) = self.current.lock() else {
            return serde_json::json!({ "status": "rejected", "note": "电脑端读不到这次推送" });
        };
        match slot.as_mut() {
            Some(p) if p.id == id => {
                let status = p.status.clone();
                let note = p.note.clone();
                if status != "pending" {
                    p.body.clear();
                }
                serde_json::json!({ "status": status, "note": note })
            }
            Some(p) => serde_json::json!({
                "status": "rejected",
                "note": format!("电脑端已经在处理更新的一次推送（{}）", p.id),
            }),
            None => serde_json::json!({ "status": "rejected", "note": "电脑端没有这次推送的记录" }),
        }
    }

    /// 桌面端取快照原文。只有还没被处理过的 pending 才给，且校验 id。
    pub fn take(&self, id: &str) -> Option<String> {
        let slot = self.current.lock().ok()?;
        let push = slot.as_ref()?;
        (push.id == id && push.status == "pending").then(|| push.body.clone())
    }

    /// 桌面端点「接收」或「拒绝」：落成终端态。返回 false = 这次已经不作数了
    /// （被更新的推送顶掉，或者重复回执）。
    pub fn resolve(&self, id: &str, approve: bool, note: &str) -> bool {
        let Ok(mut slot) = self.current.lock() else {
            return false;
        };
        let Some(push) = slot.as_mut() else {
            return false;
        };
        if push.id != id || push.status != "pending" {
            return false;
        }
        push.status = if approve { "accepted" } else { "rejected" }.to_string();
        push.note = note.to_string();
        push.body.clear();
        true
    }
}

pub struct LanInstance {
    pub quit: Arc<AtomicBool>,
    pub url: String,
    pub port: u16,
    pub token: String,
    pub push: PushSlot,
}

fn lan_ip() -> String {
    std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| {
            s.connect("223.5.5.5:80")?; // 只为取出口 IP，不发包
            Ok(s.local_addr()?)
        })
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|_| "127.0.0.1".into())
}

fn query_param(url: &str, key: &str) -> Option<String> {
    let q = url.split_once('?')?.1;
    q.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == key).then(|| v.to_string())
    })
}

fn qr_svg(content: &str) -> String {
    use qrcode::render::svg;
    use qrcode::QrCode;
    // 内容超出二维码容量时返回占位图，而不是 panic —— 服务线程一崩，整个局域网联动就停了。
    let Ok(code) = QrCode::with_error_correction_level(content.as_bytes(), qrcode::EcLevel::M) else {
        return r#"<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><text x="10" y="95" font-size="14">二维码生成失败</text></svg>"#.to_string();
    };
    code.render()
        .min_dimensions(180, 180)
        .dark_color(svg::Color("#143844"))
        .light_color(svg::Color("#ffffff"))
        .build()
}

fn json_headers() -> Vec<tiny_http::Header> {
    vec![
        tiny_http::Header::from_bytes("Content-Type", "application/json; charset=utf-8").unwrap(),
        tiny_http::Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap(),
    ]
}

fn html_headers() -> Vec<tiny_http::Header> {
    vec![tiny_http::Header::from_bytes("Content-Type", "text/html; charset=utf-8").unwrap()]
}

fn svg_headers() -> Vec<tiny_http::Header> {
    vec![
        tiny_http::Header::from_bytes("Content-Type", "image/svg+xml").unwrap(),
        tiny_http::Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap(),
    ]
}

/// 读请求体，超过 limit 直接报错。原来那句 `read_to_string` 没有上限，
/// 拿得到配对码的人发一条几百 MB 的 body 就能把电脑内存吃穿。
fn read_body(request: &mut tiny_http::Request, limit: u64) -> Result<String, String> {
    let mut buf = Vec::new();
    request
        .as_reader()
        .take(limit + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("读取请求体失败: {e}"))?;
    if buf.len() as u64 > limit {
        return Err(format!("请求体超过 {} MB 上限", limit / 1024 / 1024));
    }
    String::from_utf8(buf).map_err(|_| "请求体不是合法 UTF-8".to_string())
}

/// 从回传快照里数出条数。接受两种形态：同步快照 `{data:{tasks,blocks}}`，
/// 以及老版裸 data.json（顶层就是 tasks/blocks）—— 与前端 parseSnapshot 的宽容度对齐。
fn push_meta(body: &str) -> Option<serde_json::Value> {
    let parsed: serde_json::Value = serde_json::from_str(body).ok()?;
    let count =
        |v: &serde_json::Value, key: &str| v.get(key).and_then(|x| x.as_array()).map(|a| a.len());
    let root = parsed.get("data").unwrap_or(&parsed);
    let tasks = count(root, "tasks")?;
    let blocks = count(root, "blocks")?;
    Some(serde_json::json!({
        "tasks": tasks,
        "blocks": blocks,
        "appVersion": parsed.get("appVersion").and_then(|v| v.as_str()).unwrap_or(""),
        "exportedAt": parsed.get("exportedAt").and_then(|v| v.as_str()).unwrap_or(""),
        "schema": parsed.get("schema").and_then(|v| v.as_i64()).unwrap_or(0),
    }))
}

pub fn spawn_server(
    app: AppHandle,
    port: u16,
    token: String,
    data_path: PathBuf,
    quit: Arc<AtomicBool>,
    allow_push: bool,
) -> Result<(String, PushSlot), String> {
    let addr = format!("0.0.0.0:{port}");
    let server =
        tiny_http::Server::http(&addr).map_err(|e| format!("端口 {port} 启动失败: {e}"))?;
    let base = format!("http://{}:{port}", lan_ip());
    let url = format!("{base}/m?token={token}");
    let push_slot = PushSlot::default();
    // 克隆一份进服务线程；外面那份要还给调用方存进 LanHandle，命令侧靠它取快照。
    let slot = push_slot.clone();

    std::thread::spawn(move || {
        for mut request in server.incoming_requests() {
            if quit.load(Ordering::Relaxed) {
                break;
            }
            let url = request.url().to_string();
            let path = url.split('?').next().unwrap_or("").to_string();
            let token_in = query_param(&url, "token").unwrap_or_default();
            let mut body = String::new();
            if request.method() == &tiny_http::Method::Post {
                // 读失败不单独分流：空 body 会在下面的结构校验里被判掉。
                body = read_body(&mut request, PUSH_MAX_BYTES).unwrap_or_default();
            }

            if token_in != token {
                let resp = tiny_http::Response::from_string("{\"error\":\"token 无效\"}")
                    .with_status_code(403)
                    .with_header(
                        tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap(),
                    );
                let _ = request.respond(resp);
                continue;
            }

            let (status, headers, payload) = match (request.method(), path.as_str()) {
                (_, "/quit") => (200, json_headers(), "{\"ok\":true}".to_string()),
                (&tiny_http::Method::Get, "/m") => (200, html_headers(), MOBILE_HTML.to_string()),
                (&tiny_http::Method::Get, "/qr.svg") => (
                    200,
                    svg_headers(),
                    qr_svg(&format!("{base}/m?token={token_in}")),
                ),
                (&tiny_http::Method::Get, "/api/state") => {
                    // 错误信息里可能带引号 / 反斜杠，手拼字符串会产出非法 JSON；交给 serde_json 转义。
                    let data = std::fs::read_to_string(&data_path).unwrap_or_else(|e| {
                        serde_json::json!({ "error": format!("读取数据失败: {}", e.kind()) }).to_string()
                    });
                    (200, json_headers(), data)
                }
                // 拉之前的「电脑上是什么货」：条数 + 落盘时间 + 肯不肯收回传。只读，不落任何盘。
                (&tiny_http::Method::Get, "/api/info") => {
                    let saved_at = std::fs::metadata(&data_path)
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs());
                    let parsed: Option<serde_json::Value> = std::fs::read_to_string(&data_path)
                        .ok()
                        .and_then(|s| serde_json::from_str(&s).ok());
                    let count = |key: &str| {
                        parsed
                            .as_ref()
                            .and_then(|v| v.get(key))
                            .and_then(|v| v.as_array())
                            .map(|a| a.len())
                            .unwrap_or(0)
                    };
                    let body = serde_json::json!({
                        "ok": true,
                        "appVersion": env!("CARGO_PKG_VERSION"),
                        "savedAtEpoch": saved_at,
                        "dataOk": parsed.is_some(),
                        "allowPush": allow_push,
                        "tasks": count("tasks"),
                        "blocks": count("blocks"),
                    });
                    (200, json_headers(), body.to_string())
                }
                /* ── 回传第一段：收下快照、只进暂存槽、立刻回 202 ──
                这里绝不等用户点确认：HTTP 线程一等，等期间的其它请求全排死。 */
                (&tiny_http::Method::Post, "/api/push") => {
                    if !allow_push {
                        (403, json_headers(), serde_json::json!({
                            "ok": false,
                            "error": "电脑端没开「允许手机推回本机」。到电脑上 设置 → 可选同步 → 跟电脑直接传 那一栏里打开开关",
                        }).to_string())
                    } else {
                        match push_meta(&body) {
                            None => (400, json_headers(), serde_json::json!({
                                "ok": false, "error": "收到的内容不像 U-Time 的数据（缺 tasks/blocks）",
                            }).to_string()),
                            Some(mut meta) => {
                                let id = slot.next_id();
                                meta["id"] = serde_json::Value::String(id.clone());
                                slot.store(PendingPush {
                                    id: id.clone(),
                                    body,
                                    status: "pending".to_string(),
                                    note: String::new(),
                                });
                                // 弹哪个窗由前端决定：Rust 只管把概况推过去。
                                let _ = app.emit("lan-push-incoming", meta);
                                (202, json_headers(),
                                    serde_json::json!({ "ok": true, "status": "pending", "id": id }).to_string())
                            }
                        }
                    }
                }
                // 回传第二段：手机问「刚才那条电脑上点了没」。
                (&tiny_http::Method::Get, "/api/push-status") => {
                    let id = query_param(&url, "id").unwrap_or_default();
                    (200, json_headers(), slot.poll(&id).to_string())
                }
                (&tiny_http::Method::Post, "/api/command") => {
                    // 转发给前端，由前端经统一的数据层落盘
                    if let Ok(cmd) = serde_json::from_str::<serde_json::Value>(&body) {
                        let _ = app.emit("lan-command", cmd);
                    }
                    (200, json_headers(), "{\"ok\":true}".to_string())
                }
                _ => (404, json_headers(), "{\"error\":\"not found\"}".to_string()),
            };
            let mut resp = tiny_http::Response::from_string(payload).with_status_code(status);
            for h in headers {
                resp = resp.with_header(h);
            }
            let _ = request.respond(resp);
        }
    });

    Ok((url, push_slot))
}
