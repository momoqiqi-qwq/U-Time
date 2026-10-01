import { api } from "./api.js";
import { appConfirm, el } from "./ui.js";

export const DISCLAIMER_VERSION = "2";
export const DISCLAIMER_UPDATED = "2026-10-01";
export const DISCLAIMER_SECTIONS = [
  { title: "独立工具与官方信息", text: "U-Time 是独立开发的时间管理工具，并非学校或第三方服务的官方客户端，也不代表其认可或担保。课程、考试、成绩、学分、选课、请假、账单等信息与办理结果，请以对应官方系统为准；涉及截止时间、缴费或提交的操作，请到官方渠道再次核对。" },
  { title: "提醒与信息准确性", text: "课程、考试和通知可能因数据源更新、网络或解析问题而延迟、遗漏或出错。通知权限、静音、省电策略、应用退出和设备状态都可能影响提醒送达。请先在设置中测试提醒，并为考试、报名等重要事项设置独立的备用提醒，不要把本软件作为唯一保障。" },
  { title: "AI 与自动处理", text: "AI 生成内容、图片识别和自动时间解析可能误读日期、时区、地点或任务含义，不构成专业意见或官方结论。请在采纳、导入或执行前核对原文与结果；不确定时保留原始材料并手动修正。" },
  { title: "本地数据与备份", text: "核心数据以本地保存为主，不等于已有异地备份。卸载、清除应用或浏览器数据、设备故障，以及导入覆盖、同步冲突等操作可能造成数据丢失。请定期导出备份并妥善保存在另一位置；升级、恢复或覆盖数据前先备份，并检查备份能否读取。" },
  { title: "联网、隐私与第三方费用", text: "启用或使用学校登录、插件、AI、推送、更新检查或同步等功能时，相关请求和必要内容会发送至对应服务，部分功能可能按配置自动联网。请核对服务地址、发送内容及对方隐私规则，避免提交无权提供的个人信息或敏感材料。第三方服务可能收费、限流、变更或停止，费用与条款以服务方为准；不需要时可关闭相关功能。" },
  { title: "账号、插件与合法使用", text: "请仅使用有权访问的账号和数据，遵守适用法律、学校及服务方规则，尊重他人隐私与知识产权。妥善保管密码、API Key、配对码和备份文件，不要公开分享；仅安装可信来源的插件。遇到异常登录或可疑行为时，请停用相关功能，并到官方渠道修改密码或撤销凭据。" },
  { title: "责任边界与问题反馈", text: "本软件用于辅助管理，不保证第三方信息、服务或提醒持续可用、完全准确。发生异常时，请暂停可能扩大影响的操作，保留原始数据和必要错误信息，通过关于页的项目仓库反馈；反馈前请移除密码、密钥和个人敏感信息。责任承担依适用法律及具体事实确定；本说明不免除依法不得免除的责任，也不限制用户依法享有的权利。" },
];
// 纯文本出口与界面共用一份内容，避免启动提示和关于页的条款漂移。
export const DISCLAIMER_ITEMS = DISCLAIMER_SECTIONS.map(({ title, text }) => `${title}：${text}`);
const READ_KEY = "letime-disclaimer-read";
let startupDialog = null;
let readThisSession = false;

export function createDisclaimerContent({ scrollable = false } = {}) {
  return el("div", {
    class: `disclaimer-content${scrollable ? " disclaimer-scroll" : ""}`,
    ...(scrollable ? { tabindex: "0", role: "region", "aria-label": "使用说明与免责声明正文，可滚动阅读" } : {}),
  },
  el("p", { class: "disclaimer-summary" }, "重要事项请核对官方信息、设置备用提醒，并定期备份；使用联网功能前请确认数据去向。"),
  el("p", { class: "disclaimer-meta" }, `说明版本 ${DISCLAIMER_VERSION} · 更新于 ${DISCLAIMER_UPDATED}`),
  DISCLAIMER_SECTIONS.map(({ title, text }, i) => el("section", { class: "disclaimer-section" },
    el("h4", {}, `${i + 1}. ${title}`), el("p", {}, text))),
  el("p", { class: "disclaimer-note" }, "“我已阅读”仅记录本机已查看此版本，不代表授权所有联网功能或放弃法定权利。可选择稍后阅读，并随时在「设置 → 关于 U-Time」查阅，或在全局搜索中搜索“免责声明”。"));
}

/** APK 与桌面首次显示；阅读记录仅留本机，不随账户或数据同步。 */
export async function showStartupDisclaimer() {
  if (!api.isTauri) return false;
  if (readThisSession) return true;
  try { if (localStorage.getItem(READ_KEY) === DISCLAIMER_VERSION) return true; } catch {}
  if (startupDialog) return startupDialog;
  startupDialog = appConfirm("使用说明与免责声明", createDisclaimerContent({ scrollable: true }), {
    confirmText: "我已阅读", cancelText: "稍后阅读", dialogClass: "disclaimer-dialog", focusMessage: true,
  }).then((read) => {
    if (read) {
      readThisSession = true;
      try { localStorage.setItem(READ_KEY, DISCLAIMER_VERSION); } catch {}
    }
    return read;
  }).finally(() => { startupDialog = null; });
  return startupDialog;
}
