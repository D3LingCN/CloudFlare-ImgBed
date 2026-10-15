-- Independent additive schema. Never modifies upstream tables or the cost guard.
CREATE TABLE IF NOT EXISTS usage_meta (
 id INTEGER PRIMARY KEY CHECK(id=1), metering_since INTEGER NOT NULL,
 sync_until INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO usage_meta(id,metering_since) VALUES(1,0);
CREATE TABLE IF NOT EXISTS usage_local (
 day TEXT NOT NULL, bucket TEXT NOT NULL, action TEXT NOT NULL,
 class TEXT NOT NULL CHECK(class IN ('A','B','free','unknown')),
 attempts INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0,
 failed INTEGER NOT NULL DEFAULT 0, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
 PRIMARY KEY(day,bucket,action)
);
CREATE TABLE IF NOT EXISTS usage_tokens (
 hash TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK(scope IN ('read','sync')),
 label TEXT NOT NULL, created_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS usage_sync_runs (
 id TEXT PRIMARY KEY, source TEXT NOT NULL, started_at INTEGER NOT NULL,
 completed_at INTEGER, cutoff INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('running','success','failed')),
 error TEXT, month TEXT NOT NULL, account_json TEXT, bucket_json TEXT
);
CREATE INDEX IF NOT EXISTS usage_runs_time ON usage_sync_runs(started_at DESC);
CREATE TABLE IF NOT EXISTS usage_reconciliation (
 run_id TEXT NOT NULL REFERENCES usage_sync_runs(id), day TEXT NOT NULL,
 bucket TEXT NOT NULL, action TEXT NOT NULL, class TEXT NOT NULL,
 local_attempts INTEGER NOT NULL, local_completed INTEGER NOT NULL, local_failed INTEGER NOT NULL,
 official_requests INTEGER NOT NULL, delta INTEGER NOT NULL,
 coverage TEXT NOT NULL, statuses_json TEXT NOT NULL,
 PRIMARY KEY(run_id,day,bucket,action)
);
CREATE INDEX IF NOT EXISTS usage_reconciliation_day ON usage_reconciliation(day DESC,run_id);
