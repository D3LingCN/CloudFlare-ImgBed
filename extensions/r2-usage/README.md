# R2 用量扩展

这是本 Fork 的独立增量功能，统计业务放在 `extensions/r2-usage/`。七处原有 R2 入口先经过费用保护，放行后才由 `getMeteredR2` 记录 SDK 调用。动态路由 `functions/api/r2-usage/[[path]].js` 复用管理员会话；详细统计页面从 `dashboard.html` 复制为 `frontend-dist/r2-usage.html`。

**当前实例使用宝塔 Node.js + systemd + 私有 R2**，统计数据位于服务器的 `usage.sqlite`。完整说明见 [部署教程](../../docs/server-deployment.md)、[代码改动地图](../../docs/code-changes.md) 和 [新增表与字段](../../docs/database-schema.md)。

## 统计口径

- 本地逐次记录 SDK 调用，按开始时间划入 UTC 日；成功、失败、未确认结果分别展示。预扣额度、网页访问、缓存命中、被保护拒绝的请求不算 R2 调用。服务器 S3 SDK 已关闭隐式重试；控制台、其他密钥等外部入口只可能体现在官方统计中。
- 官方来源是 Cloudflare GraphQL `r2OperationsAdaptiveGroups`，按桶、操作类型、HTTP 状态分组。保留所有响应状态；401 单列为 unauthorized。A/B 是操作类型分类，并非最终可计费次数；官方分析具有延迟/采样可能，最终费用以账单为准。
- 免费删除与取消分片单独分类；未知操作保留为 unknown，不猜测分类。
- 月统计按 UTC 自然月。systemd timer 每晚北京时间 23:30 同步本月至执行前 15 分钟，并回查最近三个完整 UTC 日，允许 30 秒随机延迟。旧 Worker 的 Cron 已移除，`wrangler.toml` 为 `crons=[]`。
- 每次同步追加日志及对应每日操作差异，差异为官方数减本地发起数。重复同步是不同版本，不把官方快照重复相加。
- 计数开始前标记 `before-metering`，开始当天标记 `partial`，之后标记 `full`。首日不完整及统计延迟不能直接当成漏计。
- 同步失败保留上一次成功快照并返回 503；查询返回过期标记及最后失败记录，不伪装成 0 用量。并发同步用 D1 租约串行执行。
- 原费用保护的保守累计额度完全独立，报告不会清零、退款、降低或放行保护账本。当前阈值为 A 850,000、B 8,500,000、容量 8,500,000,000 字节。报表分母为 A 1,000,000、B 10,000,000；侧栏容量分母为 10,000,000,000 字节。

## 部署与权限

1. 服务器 `index.js` 打开 `DATA_DIR/usage.sqlite` 并执行 `schema.sql`，通过 `R2_USAGE_DB` 注入函数环境。已有部署必须导入旧统计库，不能用空库代替。
2. 私密配置设定 `R2_USAGE_ENABLED=1`、`R2_USAGE_BUCKET`、`R2_USAGE_ACCOUNT_ID`、`CF_R2_ANALYTICS_TOKEN`。官方统计 Token 使用 Account Analytics Read 权限，与对象读写密钥分开。
3. 需要其他服务查询时，对随机 256-bit Token 做 SHA-256，将 hash、scope（read 或 sync）、label 等写入 `usage_tokens`。吊销设置 `revoked=1`，不在 URL 中传 Token。该表没有到期时间列，不能把它与 Cloudflare 五年凭据混淆。
4. 服务器定时链为 `d3ling-imgbed-sync.timer` → `syncUsage.mjs`，直接调用模块，不需要 HTTP sync Token。历史 `scheduler.js` 只作参考：它曾通过 sync Token 调用同步 API，不绑定 R2/D1、不持有管理员密码。不要再启用旧 Cron。
5. 运行集成检查、扩展测试和服务器导入检查，再按部署教程上线。旧 Pages 根中间件默认返回维护页；原云端 D1 仅保留作迁移来源与备份，不能照旧步骤直接恢复生产托管。

统计明细不记录文件名、图片内容、URL、IP 或认证信息。每个 R2 SDK 调用增加一次发起数写入及一次结果写入，按日/桶/操作聚合。当前使用本地 SQLite，不消耗云端 D1 查询额度。发起数写入失败则不调用 R2；结果写入失败保留发起数（显示未确认）。若改回 D1，需要重新考虑对应账户额度。

## 接口

基础路径 `https://img.d3ling.cn/api/r2-usage`。其他服务使用 `Authorization: Bearer <只读Token>`；网页使用已有管理员会话。所有响应 `no-store`。只读查询不会调用官方统计或 R2。

白色侧栏另用 `GET /api/storage-summary`，允许管理员或上传用户会话。它会在保护样本过期时查询只读 Analytics，失败仍保持停止；不调用 R2 对象接口，匿名请求先返回 401。侧栏源码为 `frontend-dist/entry/storage-summary.js`，不是独立统计 HTML。

| 方法与路径 | 内容 |
|---|---|
| `GET /status` | UTC 月、本地发起/成功/失败/未确认、官方桶及账户月统计、限额、保护剩余额度、同步时间、过期标记 |
| `GET /history?days=30` | 本地每日操作计数，days 为 1–90 |
| `GET /sync-runs?before=<毫秒时间戳>` | 50 条同步记录，返回下一页 nextBefore |
| `GET /reconciliation?run=<UUID>` | 指定同步的逐日差异；省略 run 为最近成功同步 |
| `POST /sync` | 仅管理员同源请求或 sync Token；同步进行中返回 409 |

```
curl https://img.d3ling.cn/api/r2-usage/status \
  -H "Authorization: Bearer YOUR_READ_ONLY_TOKEN"
```

`official` 是最近成功快照（含 cutoff 和 month）；必须同时检查 `officialStale` 和 `lastSync.status`。`local` 是当前月计数；官方截至时间不同，不能直接用两个总数推断漏计。分析遗漏请使用 `reconciliation` 的相同完整日窗口，并筛选 coverage=full。

## 上游更新

使用 git merge 合并上游，保留扩展、API 路由、保护模块、服务器适配及检查 workflow。重建 `frontend-dist` 后，install 脚本只恢复独立统计 HTML；白色侧栏文件和 index.html 中的 script 引入需另外保留/恢复。

安装脚本幂等恢复已有七个 R2 入口的保护适配，不修改其他业务逻辑。检查脚本对新的 `img_r2` 引用或明显绕过保护的调用报错；它不是完整的静态证明，升级时仍需审查新增存储实现及动态调用。GitHub Actions 自动运行检查和扩展测试；Cloudflare Pages 构建命令也应在 npm install 后运行集成检查，防止跳过适配的版本上线。

未来可把此目录搬到独立仓库或 package；真正的隔离边界是调用包装器、独立数据库和 HTTP API，而不是复制整套三月图床源码。

参考：[R2 分析接口](https://developers.cloudflare.com/r2/platform/metrics-analytics/)、[R2 操作分类](https://developers.cloudflare.com/r2/pricing/)、[Worker Cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/)。
