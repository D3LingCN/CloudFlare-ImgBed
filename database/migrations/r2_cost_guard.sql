-- R2保护扩展：业务库新增单例账本，字段说明见 docs/database-schema.md。
-- enabled=0 是锁定全部 R2 操作，不是禁用保护；reserved/observed 不能按月自动清零。
-- Deliberately no automatic reset: failures/deletions do not refund reservations.
CREATE TABLE IF NOT EXISTS r2_cost_guard (
 id INTEGER PRIMARY KEY CHECK(id=1),
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0),
 reserved_a INTEGER NOT NULL DEFAULT 0 CHECK(reserved_a>=0),
 reserved_b INTEGER NOT NULL DEFAULT 0 CHECK(reserved_b>=0),
 observed_bytes INTEGER NOT NULL DEFAULT 0 CHECK(observed_bytes>=0),
 observed_a INTEGER NOT NULL DEFAULT 0 CHECK(observed_a>=0),
 observed_b INTEGER NOT NULL DEFAULT 0 CHECK(observed_b>=0),
 checked_at INTEGER NOT NULL DEFAULT 0,
 refresh_until INTEGER NOT NULL DEFAULT 0,
 error TEXT NOT NULL DEFAULT 'Not reconciled'
);
INSERT OR IGNORE INTO r2_cost_guard(id) VALUES(1);
-- Cover the tiny pre-installation test files/operations while analytics lags.
-- This installation was a new bucket containing only synthetic test images.
-- Never lower an existing baseline or clear existing reservations.
UPDATE r2_cost_guard SET observed_bytes=MAX(observed_bytes,1000000),
 observed_a=MAX(observed_a,1000),observed_b=MAX(observed_b,1000) WHERE id=1;
