# 数据库说明：新增六张表，分在两份 SQLite 中

服务器中的数据库由 `deploy/server/index.js` 初始化；业务通过 `SqliteD1` 继续使用原 D1 接口。**文件名不同不代表数据可丢弃**：业务库负责账号、元数据和额度保护；统计库负责逐次计量、报告与报告访问权限。

| 数据文件 | 环境绑定 | 初始化源 | 本次新增表 |
| --- | --- | --- | --- |
| `DATA_DIR/database.sqlite` | `img_d1` | `database/init.sql` + `database/migrations/*.sql` | `r2_cost_guard` |
| `DATA_DIR/usage.sqlite` | `R2_USAGE_DB` | `extensions/r2-usage/schema.sql` | `usage_meta`、`usage_local`、`usage_tokens`、`usage_sync_runs`、`usage_reconciliation` |

原 Pages 部署分别使用业务 D1 与独立统计 D1。迁移时复制其完整 schema 和行内容到上述两份库，不是把 R2 图片写进 SQLite。

## 1. 原有业务表不属于本次新增

`files` 保存文件 ID、元数据及查询字段；`settings` 保存设置和由上游适配器归入 `manage@` 的管理数据（包括会话等）；`index_operations`、`index_metadata` 用于原索引流程；`other_data` 保存其余上游键值数据。具体键分流规则见 `functions/utils/d1Database.js`。

这些原表、索引和更新时间触发器继续保留。本次没有新增另一张用户表或密码表，也没有用统计 Token 表代替上游管理员认证。`files.tags` 对应的是上游标签迁移。

## 2. r2_cost_guard：保守保护账本

来源：[r2_cost_guard.sql](../database/migrations/r2_cost_guard.sql)。仅 `id=1` 一行，字段如下。

| 字段 | 含义与写入方 |
| --- | --- |
| `id` | 单例主键，CHECK 限制为 1 |
| `enabled` | 必须为 1 才能调用 R2；0 表示锁定，不表示绕过保护 |
| `reserved_bytes` | 保护已预留的累计容量，字节；写入与分片按保守规则增加 |
| `reserved_a` / `reserved_b` | 已预留的累计 A/B 预算；SQL 原子增加 |
| `observed_bytes` | 账户各桶容量样本高水位之和的历史最大值 |
| `observed_a` / `observed_b` | 账户最近 31 天操作数的历史高水位 |
| `checked_at` | 最近一次成功保护核对时间，Unix 毫秒；默认 0 |
| `refresh_until` | 统计刷新租约或失败后的冷却截止，Unix 毫秒 |
| `error` | 空串才是有效状态；失败保存通用错误，不保存官方响应中的潜在机密 |

容量和计数有非负 CHECK。`refreshAnalytics` 使用 30 秒租约及 15 秒网络超时；失败把 `checked_at` 置 0，设置约 5 分钟冷却并停止操作。成功以 `MAX(旧值,新统计)` 更新官方高水位。

每次保护都同时检查三项：`reserved + observed + 本次增量 < LIMIT`。这是一个 UPDATE ... RETURNING，不是先 SELECT 剩余量再无条件写入，避免并发上传挤穿上限。

### 预留量与实际计量的区别

| 受保护方法 | 账本预留 | 本地实际调用统计 |
| --- | --- | --- |
| `get` / `head` | B +1 | GetObject / HeadObject |
| `put` | A +1，内容大小 +8192 字节 | PutObject |
| `list` | A +1 | ListObjects |
| `delete` | 保守 A +1，无退款 | DeleteObject，报告分类为 free |
| 创建分片上传 | A +1，8192 字节 | CreateMultipartUpload |
| 上传 part | A +1，part 大小 ×2 +8192 字节 | UploadPart，每次重试仍是新的尝试 |
| complete / abort | 各保守 A +1 | CompleteMultipartUpload / AbortMultipartUpload |
| 恢复分片句柄 | 本身无预留、无远端请求 | 后续方法分别保护和计量 |

预留容量不是磁盘占用的精确测量；覆盖、删除、失败均不退款。通过本包装器读出的已知大小流可以用于受保护复制，其他未知长度流直接拒绝。SDK 隐藏重试已关闭。

保护对不认识的官方操作默认锁定；`GetBucketSippyConfiguration` 是显式例外，因没有确认计费分类而同时占用 A、B 预算。报表仍可把它显示为 unknown，这不等于保护忽略它。

## 3. usage_meta：统计单例与同步租约

| 字段 | 含义 |
| --- | --- |
| `id` | 单例主键，只允许 1 |
| `metering_since` | 实际计量开始时间，Unix 毫秒；0 表示未设置/未知 |
| `sync_until` | 官方报告同步租约截止；防止同时生成快照 |

建表只插入 `(1,0)`。迁移时要保留旧开始时间，不要用服务器迁移时间覆盖计量历史。同步会根据它标记 `before-metering`、`partial`、`full`。

## 4. usage_local：按日、桶、操作聚合的 SDK 尝试

复合主键 `(day,bucket,action)`，不是每个请求保存一整行，因此不含文件名、图片内容、URL 或来源 IP。

| 字段 | 含义 |
| --- | --- |
| `day` | UTC 日期，YYYY-MM-DD，按调用发起时刻划分 |
| `bucket` / `action` | 桶名、SDK 操作名 |
| `class` | CHECK 限定 A、B、free、unknown |
| `attempts` | 调用前已成功持久化的尝试数 |
| `completed` / `failed` | 已写回的完成/失败结果数 |
| `first_at` / `last_at` | 该组首次/最近发起时间，Unix 毫秒 |

未确认结果为 `attempts-completed-failed`。如果发起数无法写入，则不调用 R2；如果结果无法写入，已发生的尝试仍保留，不能把它当作从未发生，也不要由客户端盲目重试写操作。

## 5. usage_tokens：报告 API 的访问令牌哈希

| 字段 | 含义 |
| --- | --- |
| `hash` | SHA-256 主键；只存摘要，不存随机 Token 明文 |
| `scope` | read 或 sync；read 只能查询，sync 只能同步 |
| `label` | 运营者给出的标签 |
| `created_at` | 创建时间，Unix 毫秒 |
| `revoked` | 0 可用，1 吊销 |

这不是 R2 S3 密钥表，也不是 `CF_R2_ANALYTICS_TOKEN` 的存储位置。没有 expiry 列；报告 Token 的吊销依靠 revoked。对象密钥和官方统计 Token 只在服务器私密配置中，其有效期由 Cloudflare 管理。

当前服务器定时脚本直接调用 `syncUsage`，不依赖 HTTP sync Token；迁移仍保留原令牌记录，供已有只读 API 客户端使用。

## 6. usage_sync_runs：官方核对历史

| 字段 | 含义 |
| --- | --- |
| `id` | 每次同步的新 UUID 主键 |
| `source` | 来源，例如 server-scheduled、scheduled、manual |
| `started_at` / `completed_at` | 启动/完成时间，Unix 毫秒 |
| `cutoff` | 官方查询截止时间，通常执行前 15 分钟 |
| `status` | CHECK 限定 running、success、failed |
| `error` | 通用失败说明；成功时可为空 |
| `month` | 对应 UTC 自然月 YYYY-MM |
| `account_json` / `bucket_json` | 账户/本桶月度分类快照，不是逐次累加值 |

索引 `usage_runs_time(started_at DESC)` 用于取最新成功/失败同步。失败不会覆盖上一份成功快照，接口会同时显示过期标记与最后同步结果。

## 7. usage_reconciliation：同窗口日差异

复合主键 `(run_id,day,bucket,action)`；`run_id` 外键关联 `usage_sync_runs.id`。

| 字段 | 含义 |
| --- | --- |
| `run_id` | 所属同步版本，重复同步不会混成一个版本 |
| `day` / `bucket` / `action` / `class` | 相同完整 UTC 日的操作分组 |
| `local_attempts` / `local_completed` / `local_failed` | 同窗口本地计数快照 |
| `official_requests` | 官方同窗口请求数 |
| `delta` | 官方数减本地尝试数；不是账单金额 |
| `coverage` | before-metering、partial、full |
| `statuses_json` | 按 HTTP 状态码汇总的官方次数 |

索引 `usage_reconciliation_day(day DESC,run_id)` 支持日差异查询。同步回查最近三个完整 UTC 日，使用 D1 batch / 同库 SQLite 事务一并提交差异行和成功状态。删除旧同步日志前需处理外键，当前版本没有自动历史清理任务。

## 8. 初始化、备份和恢复规则

- 两份库都使用 WAL；`SqliteD1` 开启外键和 5 秒 busy_timeout。业务保护与统计分别写入，不能声称它们构成同一个跨库事务。
- `database/init.sql` 中示例 DROP 语句是注释，正常启动使用 IF NOT EXISTS。迁移中的保护基线只提高既有值，不清空预留。
- SQLite 启动迁移遇到已存在的标签列会记录提示；保留原 schema 并不等于全部错误可忽略，应查看具体日志和完整性检查。
- 备份两份库、私密配置和程序版本；用在线 backup 或停服务后完整备份 WAL 相关文件。配置备份也应私密保存。
- 恢复业务数据时特别审计 `r2_cost_guard`：恢复旧的较低计数可能漏掉备份后发生的操作。不能为恢复可用性直接执行“全部计数设 0”。
- 官方账单周期、UTC 月报和保护账本不同。新月份只改变报表查询窗口，不意味着历史预留被释放。

表结构的权威来源是两份 SQL 文件；修改 schema 时必须同时更新本文、迁移兼容策略和相关测试。
