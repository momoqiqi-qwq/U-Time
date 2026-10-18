// 粘贴内容的「碎片 / 名单」判定：这类文本不该进待办。
//
// 真实踩过的脏数据（用户 10-10 粘贴三次，三条待办全进池）：
//   note = "1\r\n刘2\r\n梁3\r\n冯" → title = "1 刘2 梁3 冯"
//   note = "3\r\n冯\r\n\r\n4\r\n张" → title = "3 冯 4 张"
// 都是从聊天窗里复制的名单接龙：数字单独一行、每个姓一个字，
// 拼起来只剩单个汉字与数字。任何一件事哪怕再短（「开会」「A4纸」
// 「交论文」），也总有连续两个汉字或连续两个字母数字。
//
// 只判「有没有像词的连续段」，不判语义 —— 宁可让个别超短输入被挡
// （会弹一句说明），也不许名单碎片再堆进任务池。

const HAS_TEXT = /[\u4e00-\u9fa5A-Za-z]/;          // 至少有一个汉字或字母
const HAS_WORD = /[\u4e00-\u9fa5]{2,}|[A-Za-z0-9]{2,}/; // 连续两个及以上

/**
 * @param {string} text 原始粘贴文本（可含换行、制表、全角空格）
 * @returns {boolean} true = 碎片/名单，不该建任务
 */
export function looksLikeNoise(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return true;            // 空白
  if (!HAS_TEXT.test(t)) return true; // 纯数字、纯符号（"1 2 3"、"—"）
  return !HAS_WORD.test(t);       // 只剩单字碎片
}
