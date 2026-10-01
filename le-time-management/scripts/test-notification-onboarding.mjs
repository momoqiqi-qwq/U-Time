import assert from "node:assert/strict";
import fs from "node:fs";

const read = (name) => fs.readFileSync(new URL(name, import.meta.url), "utf8");
const bridge = read("../src/androidNotify.js").replace(/^import .*;\r?\n/gm, "").replace(/export /g, "");
function notificationFixture(initial, { android = true, error = false, allow = true } = {}) {
  let status = { ...initial };
  const calls = [], messages = [];
  const api = { isTauri: true, async notification(action) {
    calls.push(action);
    if (error) throw new Error("bridge missing");
    if (action === "askPermission") status = { ...status, granted: allow, permissionAsked: true };
    return status;
  } };
  const module = new Function("api", "toast", "navigator", `${bridge}\nreturn {initAndroidNotifications,notifyStatus};`)(api, (...args) => messages.push(args), { userAgent: android ? "Android" : "Windows" });
  return { ...module, calls, messages };
}
let f = notificationFixture({ granted: false, exact: true, canRequest: true, permissionAsked: false });
await Promise.all([f.initAndroidNotifications(), f.initAndroidNotifications()]);
assert.equal(f.calls.filter((x) => x === "askPermission").length, 1, "concurrent startup requests must coalesce");
assert.equal(f.messages.length, 0);
f = notificationFixture({ granted: false, exact: false, canRequest: true, permissionAsked: false }, { allow: false });
await f.initAndroidNotifications();
assert.equal(f.messages[0][1].actionLabel, "通知设置");
await f.messages[0][1].action();
assert.ok(f.calls.includes("openSettings"));
assert.equal(f.messages[1][1].actionLabel, "去开启");
f = notificationFixture({ granted: false, exact: true, canRequest: true, permissionAsked: true });
await f.initAndroidNotifications();
assert.ok(!f.calls.includes("askPermission"), "previous refusal must not auto-prompt again");
for (const initial of [{ granted: true, exact: true }, { granted: false, exact: true, canRequest: false }]) {
  f = notificationFixture(initial); await f.initAndroidNotifications();
  assert.ok(!f.calls.includes("askPermission"));
}
f = notificationFixture({}, { error: true });
assert.equal((await f.notifyStatus()).supported, false);
f = notificationFixture({}, { android: false });
await f.initAndroidNotifications(); assert.equal(f.calls.length, 0);

const disclaimer = read("../src/disclaimer.js").replace(/^import .*;\r?\n/gm, "").replace(/export /g, "");
let readVersion = null, dialogs = 0, accepted = false;
const onboarding = new Function("api", "appConfirm", "el", "localStorage", `${disclaimer}\nreturn {showStartupDisclaimer};`)(
  { isTauri: true }, async () => { dialogs++; return accepted; }, () => {},
  { getItem: () => readVersion, setItem: (_, value) => { readVersion = value; } });
await onboarding.showStartupDisclaimer(); assert.equal(readVersion, null, "later must not mark read");
accepted = true;
await onboarding.showStartupDisclaimer(); assert.equal(readVersion, "2");
await onboarding.showStartupDisclaimer(); assert.equal(dialogs, 2, "read disclaimer should not reappear");

const host = read("../src/pluginHost.js");
const collect = host.slice(host.indexOf("export function collectNotice"), host.indexOf("/** 最近的消息" )).replace("export ", "");
const posted = [], feed = [];
const collectNotice = new Function("MESSAGE_FEED", "MESSAGE_SEEN", "MESSAGE_MAX", "isAndroidRuntime", "postNativeReminder", `${collect}\nreturn collectNotice;`)(feed, new Set(), 120, () => true, (row) => posted.push(row));
const payload = { source: "school", sourceName: "学校通知", items: [{ title: "消息 A", time: "10:00" }, { title: "消息 B", time: "10:01" }, { title: "" }] };
collectNotice(payload, "school"); collectNotice(payload, "school");
assert.equal(posted.length, 1, "duplicate notices must not be pushed twice");
assert.equal(posted[0].taskActions, false);
assert.equal(posted[0].body, "消息 A\n消息 B");
assert.equal(feed.length, 2);
console.log("PASS: automatic notification permission, denial/settings, desktop bypass, local disclaimer read state and deduplicated plugin notifications");
