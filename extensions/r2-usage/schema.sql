-- R2保护扩展：独立统计库 usage.sqlite；完整字段说明见 docs/database-schema.md。
-- Independent additive schema. Never modifies upstream tables or the cost guard.
-- 单例：统计起始时间及官方报告同步租约，不是保护额度。
CREATE TABLE IF NOT EXISTS usage_meta (
 id INTEGER PRIMARY KEY CHECK(id=1), metering_since INTEGER NOT NULL,
 sync_until INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO usage_meta(id,metering_since) VALUES(1,0);
-- 按 UTC 日、桶、操作聚合实际 SDK 尝试；attempts - completed - failed 为未确认。
CREATE TABLE IF NOT EXISTS usage_local (
 day TEXT NOT NULL, bucket TEXT NOT NULL, action TEXT NOT NULL,
 class TEXT NOT NULL CHECK(class IN ('A','B','free','unknown')),
 attempts INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0,
 failed INTEGER NOT NULL DEFAULT 0, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
 PRIMARY KEY(day,bucket,action)
);
-- 报表 read/sync Token 的 SHA-256 摘要；不保存 S3 密钥或统计 Token 明文。
CREATE TABLE IF NOT EXISTS usage_tokens (
 hash TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK(scope IN ('read','sync')),
 label TEXT NOT NULL, created_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
);
-- 每次官方核对的独立快照；失败不覆盖旧成功版本，不重复累计快照总数。
CREATE TABLE IF NOT EXISTS usage_sync_runs (
 id TEXT PRIMARY KEY, source TEXT NOT NULL, started_at INTEGER NOT NULL,
 completed_at INTEGER, cutoff INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('running','success','failed')),
 error TEXT, month TEXT NOT NULL, account_json TEXT, bucket_json TEXT
);
CREATE INDEX IF NOT EXISTS usage_runs_time ON usage_sync_runs(started_at DESC);
-- 完整 UTC 日的官方与本地差异，按 run_id 保留版本；不自动清理外键历史。
CREATE TABLE IF NOT EXISTS usage_reconciliation (
 run_id TEXT NOT NULL REFERENCES usage_sync_runs(id), day TEXT NOT NULL,
 bucket TEXT NOT NULL, action TEXT NOT NULL, class TEXT NOT NULL,
 local_attempts INTEGER NOT NULL, local_completed INTEGER NOT NULL, local_failed INTEGER NOT NULL,
 official_requests INTEGER NOT NULL, delta INTEGER NOT NULL,
 coverage TEXT NOT NULL, statuses_json TEXT NOT NULL,
 PRIMARY KEY(run_id,day,bucket,action)
);
CREATE INDEX IF NOT EXISTS usage_reconciliation_day ON usage_reconciliation(day DESC,run_id);
