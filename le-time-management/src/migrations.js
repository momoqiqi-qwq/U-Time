export const CURRENT_SCHEMA_VERSION = 1;

const cloneSnapshot = (value) => {
  if (!value || typeof value !== "object") return {};
  if (typeof structuredClone === "function") return structuredClone(value);
  // structuredClone（v0.109.0）：迁移数据全是 store 的纯 JSON 结构，直接结构化克隆，
  // 不再走「序列化成字符串再解析回来」——更快，也不丢类型。
  return structuredClone(value);
};

const MIGRATIONS = new Map([
  [0, (state) => ({ ...state, dataSchemaVersion: 1 })],
]);

/** Upgrade persisted application data without discarding fields from plugins or newer modules. */
export function migrateState(raw = {}) {
  let state = cloneSnapshot(raw);
  let version = Number.isInteger(state.dataSchemaVersion) ? state.dataSchemaVersion : 0;
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error("数据来自更新版本，请升级 U-Time 后再打开");
  }
  while (version < CURRENT_SCHEMA_VERSION) {
    const migrate = MIGRATIONS.get(version);
    if (!migrate) throw new Error(`缺少数据迁移步骤：${version} → ${version + 1}`);
    state = migrate(state);
    version = state.dataSchemaVersion;
  }
  return state;
}
