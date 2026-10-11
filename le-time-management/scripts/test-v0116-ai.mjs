import { readProductSource } from "./lib/read-product-source.mjs";
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as S from '../src/store.js';

const memory = new Map();
globalThis.localStorage = { getItem: k => memory.get(k), setItem: (k, v) => memory.set(k, v) };
await S.initStore({ tasks: [], blocks: [], inbox: [], settings: {}, plugins: {}, automation: {} });

const AI = await import('../src/aiAutomation.js');
const a = AI.saveAiAutomationRule({ name: '晚间整理', instruction: '整理未完成任务', schedule: { type: 'daily', time: '22:30' } });
const b = AI.saveAiAutomationRule({ name: '工作日晨报', instruction: '总结今天任务', schedule: { type: 'weekdays', time: '08:00', weekdays: [1,2,3,4,5] } });
assert.equal(AI.getAiAutomationRules().length, 2, '支持多个 AI 自动任务');
assert.match(AI.aiScheduleLabel(a), /每天 22:30/);
assert.match(AI.aiScheduleLabel(b), /周一、二、三、四、五 08:00/);
AI.setAiAutomationEnabled(a.id, false);
assert.equal(AI.getAiAutomationRules().find(x => x.id === a.id).enabled, false);
AI.deleteAiAutomationRule(a.id);
assert.equal(AI.getAiAutomationRules().length, 1);

const read = rel => readProductSource(new URL(rel, import.meta.url), 'utf8');
const rust = read('../src-tauri/src/lib.rs');
const styles = read('../src/styles.css');
const theme = read('../src/theme.js');
const shell = read('../src/shell.js');
const aiAutomation = read('../src/aiAutomation.js');

assert.match(rust, /AES_256_GCM/);
assert.match(rust, /ai_vault_save/);
assert.match(rust, /ai_vault_clear/);
assert.match(rust, /ai_chat/);
assert.doesNotMatch(theme, /id:\s*["']elder["']/);
assert.doesNotMatch(styles, /\.elder-root|\.care-home/);
/* v0.37.7「弹 2 下」修复：切视图去掉旧页出场动画（view.animate 已删），
   平滑动效由入场 page-l/page-r + 标题卡 animate 承担，守卫跟着改 */
assert.match(shell, /titleCard\.animate/);
assert.match(aiAutomation, /禁止.*本地文件|不能读取、写入、删除本地文件/);
assert.match(aiAutomation, /create_task/);
assert.match(aiAutomation, /create_timeblock/);
assert.doesNotMatch(aiAutomation, /readPluginFile|deletePlugin|importPluginZip/);

/* ── v0.188.0 · AI 配置的框体照 Nephele 的 NepheleTextField ──
   用户口径：「这种框好雷霆，太小太窄，学习 nephele 的框」。实测改前：Base URL 被排在 0.75fr
   的窄列（1280 窗口 373px、1085 窗口只剩 180px 的 minmax 下限），且这些 input 走「设置页裸值」
   形态只有 26px 高 —— 125% 字号下 16.25px 的字几乎顶满行框。下面三条把「宽」「高」「框体」钉住。 */
const aiSettings = read('../src/views/settings/ai.js');
// ① 长值字段独占整行：字段顺序必须是 供应商 → 模型 → Base URL → API Key
const fieldOrder = ['供应商', '模型', 'Base URL', 'API Key']
  .map((label) => aiSettings.indexOf(`el("span", {}, "${label}")`));
assert.ok(fieldOrder.every((index) => index > -1), 'AI 卡片四个字段都还在');
assert.deepEqual([...fieldOrder].sort((a2, b2) => a2 - b2), fieldOrder,
  '字段顺序：供应商 / 模型 成对占一行，Base URL 与 API Key 各占整行');
assert.match(aiSettings, /class: "ai-field ai-base-field"/, 'Base URL 必须带 ai-base-field（整行）');

// ② 栅格不再把长 URL 塞进窄列
const gridRule = styles.match(/\.ai-settings-grid \{[\s\S]*?\}/)?.[0] ?? '';
assert.ok(gridRule, '.ai-settings-grid 规则必须存在');
assert.match(gridRule, /grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/,
  'AI 配置栅格是等宽两列（短控件成对）');
assert.doesNotMatch(gridRule, /1\.25fr|\.75fr/,
  '回归：长 URL 不许再回到 1.25fr / 0.75fr 的窄列');
assert.match(styles, /\.ai-base-field,[\s\S]{0,40}\.ai-key-field \{ grid-column: 1 \/ -1; \}/,
  'Base URL 与 API Key 必须整行满宽（照 Nephele 的 Layout.fillWidth）');

// ③ 框体：常驻底色 + radius 12 + 高度随字号放大（改前是透明的 26px 裸输入框）
const aiInputRule = styles.match(
  /\.ai-settings-card \.ai-field input:not\(\[type="checkbox"\]\)[\s\S]*?\n\}/)?.[0] ?? '';
assert.ok(aiInputRule, 'AI 卡片输入框规则必须存在');
assert.match(aiInputRule, /min-height: calc\(36px \* var\(--ui-text-scale, 1\)\)/,
  '框体高度必须随 --ui-text-scale 放大（125% 字号下 16px 的字不该顶满 26px 的行框）');
assert.match(aiInputRule, /border-radius: 12px !important/, '圆角取 Nephele 的 Theme.radiusInput = 12');
assert.match(aiInputRule, /background: var\(--control-bg\) !important/,
  '框体常驻（压过「设置页裸值」的透明 !important）');
assert.match(styles,
  /\.ai-settings-card \.ai-field \.ai-model-toggle \{[\s\S]{0,120}?min-height: calc\(36px \* var\(--ui-text-scale, 1\)\)/,
  '模型箭钮与同排输入框等高');

console.log('PASS: v0.11.6 AI encrypted vault wiring, multiple schedules, no-local-file boundary, and jump animation');
