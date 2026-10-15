# R2 用量扩展

这是本 Fork 的独立增量功能，业务代码放在 `extensions/r2-usage/`；不改上游上传、目录或后台业务流程。唯一计数接缝在本 Fork 已有的 `functions/utils/r2CostGuard.js`：额度检查放行后，用 `getMeteredR2` 包装 R2 SDK。新增 Pages 路由 `functions/api/r2-usage/[[path]].js` 复用上游管理员会话验证；页面从 `dashboard.html` 复制为 `frontend-dist/r2-usage.html`。

## 统计口径

- 本地逐次记录 SDK 调用，按开始时间划入 UTC 日；成功、失败、未确认结果分别展示。预扣额度、网页访问、缓存命中、被保护拒绝的请求不算 R2 调用。SDK 内部重试及控制台/S3 等外部入口可能只体现在官方统计中。
- 官方来源是 Cloudflare GraphQL `r2OperationsAdaptiveGroups`，按桶、操作类型、HTTP 状态分组。保留所有响应状态；401 单列为 unauthorized。A/B 是操作类型分类，并非最终可计费次数；官方分析具有延迟/采样可能，最终费用以账单为准。
- 免费删除与取消分片单独分类；未知操作保留为 unknown，不猜测分类。
- 月统计按 UTC 自然月。每晚北京时间 23:30（Cron `30 15 * * *`）同步本月至执行前 15 分钟，并回查最近三个完整 UTC 日。
- 每次同步追加日志及对应每日操作差异，差异为官方数减本地发起数。重复同步是不同版本，不把官方快照重复相加。
- 计数开始前标记 `before-metering`，开始当天标记 `partial`，之后标记 `full`。首日不完整及统计延迟不能直接当成漏计。
- 同步失败保留上一次成功快照并返回 503；查询返回过期标记及最后失败记录，不伪装成 0 用量。并发同步用 D1 租约串行执行。
- 原费用保护的保守累计额度完全独立，报告不会清零、退款、降低或放行保护账本。报告限额为 A 50 万、B 500 万；保护容量 8 GB。

## 部署与权限

1. 独立 D1 数据库 `d3ling-r2-usage`（本部署 ID `b821a0b4-d317-44c9-8f43-5f2d72259b7c`），初始化 `schema.sql`，生产 Pages 绑定 `R2_USAGE_DB`。
2. Pages 变量：`R2_USAGE_ENABLED=1`、`R2_USAGE_BUCKET=d3ling-imgbed-files`、`R2_USAGE_ACCOUNT_ID`；复用 Pages 已有 `CF_R2_ANALYTICS_TOKEN`，不扩大其只读统计权限。
3. 对随机 256-bit Token 做 SHA-256，把 hash、scope（read 或 sync）和 label 写入 `usage_tokens`；数据库不存明文。scope=read 只能读取统计，scope=sync 只能 POST 同步。吊销时将对应记录 `revoked` 改为 1。不可在 URL 中传 Token。
4. 部署 `scheduler.js` 为独立 Worker `d3ling-r2-usage-sync`，变量 `R2_USAGE_SYNC_URL=https://img.d3ling.cn/api/r2-usage/sync`，机密 `R2_USAGE_SYNC_TOKEN` 使用 scope=sync 的 Token。Worker 不绑定 R2/D1、不持有管理员密码或官方统计 Token；只调用同步接口。配置唯一 Cron `30 15 * * *`。本部署使用 Cloudflare Workers Builds 连接同一个已授权 GitHub 仓库，main 分支，部署命令为 `npx wrangler deploy --config extensions/r2-usage/wrangler.toml`，预览构建关闭。
5. `node extensions/r2-usage/install.mjs`、`node extensions/r2-usage/check-integration.mjs`、`node --test extensions/r2-usage/usage.test.mjs`；然后正常部署 Pages。

统计明细不记录文件名、图片内容、URL、IP 或认证信息。每个 R2 SDK 调用增加一条发起计数写入及一条结果写入；数据库使用仍受账户 D1 免费额度限制。计数前数据库写入失败则不调用 R2；调用后结果写入失败保留发起数（显示未确认）。

## 接口

基础路径 `https://img.d3ling.cn/api/r2-usage`。其他服务使用 `Authorization: Bearer <只读Token>`；网页使用已有管理员会话。所有响应 `no-store`。只读查询不会调用官方统计或 R2。

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

使用 git merge 合并上游，保留 `extensions/`、新增 API 路由、统计页面、已有保护模块和独立检查 workflow；不要用上游目录覆盖本 Fork。若前端构建重建 `frontend-dist`，重新运行 install 脚本。

安装脚本幂等恢复已有七个 R2 入口的保护适配，不修改其他业务逻辑。检查脚本对新的 `img_r2` 引用或明显绕过保护的调用报错；它不是完整的静态证明，升级时仍需审查新增存储实现及动态调用。GitHub Actions 自动运行检查和扩展测试；Cloudflare Pages 构建命令也应在 npm install 后运行集成检查，防止跳过适配的版本上线。

未来可把此目录搬到独立仓库或 package；真正的隔离边界是调用包装器、独立数据库和 HTTP API，而不是复制整套三月图床源码。

参考：[R2 分析接口](https://developers.cloudflare.com/r2/platform/metrics-analytics/)、[R2 操作分类](https://developers.cloudflare.com/r2/pricing/)、[Worker Cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/)。
