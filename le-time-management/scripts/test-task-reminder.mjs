import assert from 'node:assert/strict';
// Minimal browser globals before importing module dependency tree.
globalThis.window = { AudioContext: class {} };
globalThis.document = { createElement(){return {classList:{add(){},remove(){},toggle(){}},append(){},addEventListener(){}};} };
const R = await import('../src/taskReminder.js');
assert.equal(R.dueAt({due:'2026-09-11',dueTime:'12:30'}), new Date('2026-09-11T12:30:00').getTime());
assert.deepEqual(R.normalizeOffsets([10,60,10,-1,0,'5']), [60,10,5,0]);
assert.equal(R.reminderLabel(0), '已到截止时间');
assert.equal(R.reminderLabel(120), '还有 2 小时截止');
assert.equal(typeof R.testTaskReminder, 'function', '设置页必须能触发一条端到端测试提醒');
console.log('task reminder tests passed');
