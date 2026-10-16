import { api } from "./api.js";
import { appConfirm, el } from "./ui.js";

export const DISCLAIMER_VERSION = "3";
const DISCLAIMER_UPDATED = "2026-10-01";
const READ_KEY = "letime-disclaimer-read";

/** 启动弹窗的勾选项：必须由用户手动勾选，勾上之前「确认」一直是禁用的。 */
export const DISCLAIMER_ACK = {
  id: "ack",
  label: "我已逐条阅读并理解上述账号、隐私与数据去向说明。",
  required: true,
};

export const DISCLAIMER_SECTIONS = [
  { title: "独立工具与官方信息", text: "U-Time 是独立开发的时间管理工具，并非学校或第三方服务的官方客户端，也不代表其认可或担保。课程、考试、成绩、学分、选课、请假、账单等信息与办理结果，请以对应官方系统为准；涉及截止时间、缴费或提交的操作，请到官方渠道再次核对。" },
  { title: "提醒与信息准确性", text: "课程、考试和通知可能因数据源更新、网络或解析问题而延迟、遗漏或出错。通知权限、静音、省电策略、应用退出和设备状态都可能影响提醒送达。请先在设置中测试提醒，并为考试、报名等重要事项设置独立的备用提醒，不要把本软件作为唯一保障。" },
  { title: "AI 与自动处理", text: "AI 生成内容、图片识别和自动时间解析可能误读日期、时区、地点或任务含义，不构成专业意见或官方结论。请在采纳、导入或执行前核对原文与结果；不确定时保留原始材料并手动修正。" },
  { title: "本地数据与系统权限", text: "任务、时间块、设置和插件数据默认只保存在本机，不上传到开发者服务器，也不等于已有异地备份；卸载、清除应用或浏览器数据、设备故障，以及导入覆盖、同步冲突等操作都可能造成数据丢失，请定期导出备份并妥善保存在另一位置，升级、恢复或覆盖数据前先备份并确认备份能读取。通知、网络、文件读写等系统权限由系统授权、随时可在系统设置里撤回；拒绝授权时相关功能会不可用，但本地记录不受影响。存储在本机的内容仍可能被能物理接触设备的人、具备 root 权限的软件或其他读取本机数据的应用看到，请为锁屏与磁盘加密设置密码。" },
  { title: "联网、隐私与第三方服务", text: "核心功能不需要账号，也不会自动注册或登录任何账号。只有在你主动启用或使用学校登录、插件、AI、推送、更新检查或同步等功能时，相关请求和必要内容才会发送到对应服务，部分功能可能按你的配置自动联网。发送内容通常包括任务标题、时间、你输入或粘贴的文本、所选课程或考试等业务数据，以及完成请求所需的令牌；请避免在联网功能里提交与使用目的无关的姓名、学号、证件号、住址、联系方式、成绩单或他人信息。第三方服务可能收费、限流、变更或停止，费用与条款以服务方为准；不需要时可在设置里关闭相关功能。" },
  { title: "账号、凭据与账号安全", text: "仅使用你有权访问的账号和数据，不要借用、代管或共用他人账号。密码、验证码、API Key、配对码、令牌和备份文件等同于钥匙：请自行输入、自行保管、不要发到群聊、截图、公开仓库或反馈信息里。软件不会向你索要密码，也不会代为保管你的第三方账号密码；需要保存时请先确认本机可信，并尽量改用应用专用密码或可随时撤销的令牌。多设备联动、WebDAV 同步等通道由你自己配置地址与凭据，请确认对端可信、连接加密，并定期更换或撤销凭据。发现异常登录、令牌泄漏或设备丢失，请立即到对应官方渠道改密码、撤销会话与令牌，并停用本机相关功能。" },
  { title: "插件与第三方服务边界", text: "插件与第三方服务由第三方提供，不是本软件的组成部分；其可用性、内容准确性、收费与隐私处理均由提供方负责。插件可读取你授予它的数据，也可能自行联网，软件无法替它保证数据去向，也无法审查其全部行为。请只安装可信来源的插件，安装前确认它需要哪些数据与网络权限；需要时可停用或卸载，并到官方渠道撤销曾授予它的凭据。" },
  { title: "合法使用与责任边界", text: "请遵守适用法律、学校规定和第三方服务条款，尊重他人隐私与知识产权；本软件用于辅助管理，不用于绕过任何系统的访问控制、验证流程或付费限制，也不提供此类能力。发生异常时，请暂停可能扩大影响的操作，保留原始数据和必要错误信息，通过关于页的项目仓库反馈，并在反馈前移除密码、密钥、令牌和个人敏感信息。本软件不保证第三方信息、服务或提醒持续可用、完全准确；责任承担依适用法律及具体事实确定，本说明不免除依法不得免除的责任，也不限制你依法享有的权利。" },
];

// 纯文本出口与界面共用一份内容，避免启动提示和关于页的条款漂移。
export const DISCLAIMER_ITEMS = DISCLAIMER_SECTIONS.map(({ title, text }) => `${title}：${text}`);

let startupDialog = null;
let readThisSession = false;

/** 本机已确认的说明版本；未读或旧版本返回 ""，用于关于页的阅读状态。 */
export function readDisclaimerVersion() {
  try { return localStorage.getItem(READ_KEY) || ""; } catch { return ""; }
}

export function isDisclaimerAcknowledged() {
  return readDisclaimerVersion() === DISCLAIMER_VERSION;
}

export function createDisclaimerContent({ scrollable = false } = {}) {
  return el("div", {
    class: `disclaimer-content${scrollable ? " disclaimer-scroll" : ""}`,
    ...(scrollable ? { tabindex: "0", role: "region", "aria-label": "使用说明与免责声明正文，可滚动阅读" } : {}),
  },
  el("p", { class: "disclaimer-summary" }, "重要事项请核对官方信息、设置备用提醒，并定期备份；使用联网功能前请确认数据去向与凭据保管方式。"),
  el("p", { class: "disclaimer-meta" }, `说明版本 ${DISCLAIMER_VERSION} · 更新于 ${DISCLAIMER_UPDATED}`),
  DISCLAIMER_SECTIONS.map(({ title, text }, i) => el("section", { class: "disclaimer-section" },
    el("h4", {}, `${i + 1}. ${title}`), el("p", {}, text))),
  el("p", { class: "disclaimer-note" }, "勾选并确认仅记录本机已查看此版本，不代表授权所有联网功能、同意任何第三方条款或放弃法定权利。可选择稍后阅读，并随时在「设置 → 关于 U-Time」展开查阅，或在全局搜索中搜索“免责声明”。"));
}

/**
 * 阅读确认门（首次使用 + 关于页「重新阅读确认」共用同一个对话框）。
 * 只在原生端弹（浏览器预览会挡住录屏），且只在「本机没有当前版本阅读记录」时弹：
 * 记录仅在本机保存、不随账户或数据同步，所以换设备、清数据、说明升版都会重新弹。
 * 确认按钮在勾选「我已逐条阅读…」之前保持禁用 —— 必须手动勾选，不能被误点跳过。
 * 关于页复核时传 force：跳过「已读过」的短路照常弹窗，取消也不会抹掉已有的阅读记录。
 */
export async function showStartupDisclaimer({ force = false } = {}) {
  if (!api.isTauri) return false;
  if (startupDialog) return startupDialog;
  // force 必须绕过全部「已读过」短路：关于页的「重新阅读确认」是给人再看一遍用的，
  // 若被本会话标记拦住，按钮点了没反应 —— 那是假按钮。
  if (!force) {
    if (readThisSession) return true;
    try { if (localStorage.getItem(READ_KEY) === DISCLAIMER_VERSION) return true; } catch {}
  }
  startupDialog = appConfirm("使用说明与免责声明", createDisclaimerContent({ scrollable: true }), {
    confirmText: "我已阅读并同意",
    cancelText: "稍后阅读",
    dialogClass: "disclaimer-dialog",
    focusMessage: true,
    options: [DISCLAIMER_ACK],
  }).then((result) => {
    // 带勾选项的对话框返回 { confirmed, checks }；兼容只回布尔的调用方（测试替身 / 旧实现）。
    const read = Boolean(result && typeof result === "object" ? result.confirmed : result);
    if (read) {
      readThisSession = true;
      try { localStorage.setItem(READ_KEY, DISCLAIMER_VERSION); } catch {}
    }
    return read;
  }).finally(() => { startupDialog = null; });
  return startupDialog;
}
