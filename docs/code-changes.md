# 代码改动地图

本文标注本 Fork 的新增功能和修改位置。路径均相对仓库根目录；用函数名和 `R2保护扩展` 注释定位，比固定行号更适合后续合并上游。部署流程见 [服务器教程](server-deployment.md)，所有新增表见 [数据库说明](database-schema.md)。

## 1. 请求链与修改边界

```text
上传 / 读图 / 删除 / 移动 / 重命名
  → 原有鉴权与业务处理
  → getGuardedR2(env)
      → reserve(): 核对统计 + 原子预留 database.sqlite
      → getMeteredR2(): 先记录 usage.sqlite 的 attempts
      → CloudflareR2: S3 SDK，仅一次尝试
      → 写入 completed 或 failed
  → 原业务返回

上传页、管理页
  → storage-summary.js 可收缩侧栏
  → GET /api/storage-summary（必须有 admin 或 user 会话）
  → 必要时刷新只读 Analytics + 读取两个本地数据库

每天北京时间 23:30
  → systemd timer → syncUsage.mjs → analytics.syncUsage()
  → 官方月快照、三个完整 UTC 日差异 → usage.sqlite
```

只有进入实际 R2 SDK 的调用才增加本地调用统计。预留已经成功、但后续计数库失败时，R2 不会发起，预留仍保留。两份数据库之间没有跨库事务，所以宁可多预留，不尝试跨库退款。

## 2. 新增模块与关键函数

| 文件 | 类型与定位 | 内容及维护要点 |
| --- | --- | --- |
| [r2CostGuard.js](../functions/utils/r2CostGuard.js) | 新增保护模块；`LIMITS`、`ACCOUNT`、`parseAnalytics`、`refreshAnalytics`、`reserve`、`getGuardedR2`、`guardStatus` | 集中拦截；不要在业务入口复制另一套额度判断。账户常量目前仍需按部署实例修改 |
| [r2_cost_guard.sql](../database/migrations/r2_cost_guard.sql) | 新增业务库迁移 | 只增加保护单例表；初始化保守基线，不清除旧计数 |
| [servicePlaceholder.js](../functions/utils/servicePlaceholder.js) | 新增读图占位模块；`servicePlaceholder` | 程序内置 SVG，200 便于 img 渲染，`no-store` 防止恢复后仍显示旧占位图；HEAD 不带 body |
| [storage-summary.js](../frontend-dist/entry/storage-summary.js) | 新增前端独立入口；`mount`、`refresh`、`toggle`、`close` | A 方案白色右侧抽屉；页面挂载、会话可见性、5 分钟刷新、Esc/按钮关闭和窄屏样式 |
| [storage-summary API](../functions/api/storage-summary.js) | 新增 `onRequest` | 先验证会话；过期样本先核对，失败返回 503 + blocked；只返回界面所需字段，不返回密钥或保护错误详情 |
| [meter.js](../extensions/r2-usage/meter.js) | 新增统计包装器；`getMeteredR2`、`call` | 在保护之后执行；每次调用先记 attempts，再记结果，不持久化图片 key、URL 或 IP |
| [core.js](../extensions/r2-usage/core.js) | 新增统计工具 | 报表 `LIMITS`、`FREE_TIER`、UTC 日期、操作分类、Token SHA-256；报告分类与保护判定不同 |
| [analytics.js](../extensions/r2-usage/analytics.js) | 新增官方统计核对；`parseOperations`、`reconcile`、`syncUsage` | 月快照滞后 15 分钟，回查三个完整 UTC 日；独立于保护的 5 分钟核对 |
| [schema.sql](../extensions/r2-usage/schema.sql) | 新增独立统计 schema | 五张表、两个辅助索引；不会改变上游业务表 |
| [api.js](../extensions/r2-usage/api.js) | 新增统计 HTTP 处理；`handleApi`、`scopeOf` | status/history/sync-runs/reconciliation/sync；管理员会话和 read/sync Token 权限分离 |
| [API 接缝](../functions/api/r2-usage/%5B%5Bpath%5D%5D.js) | 新增动态路由 | 复用管理员会话，调用扩展 API 与保护状态，不重做上传鉴权 |
| [dashboard.html](../extensions/r2-usage/dashboard.html) | 新增详细统计页面的维护源 | 发布副本为 `frontend-dist/r2-usage.html`；由 install 脚本复制，不是白色侧栏源码 |
| [install.mjs](../extensions/r2-usage/install.mjs) / [check-integration.mjs](../extensions/r2-usage/check-integration.mjs) | 新增安装与检查脚本 | 恢复七处已知 R2 接缝、复制统计页面；发现新直接引用时要求审查。检查不是完整静态安全证明 |
| [scheduler.js](../extensions/r2-usage/scheduler.js) / [wrangler.toml](../extensions/r2-usage/wrangler.toml) | 历史 Cloudflare 调度器 | 为旧部署保留；服务器部署的 `crons=[]`，不与 systemd 重复调度 |

## 3. 上游业务代码修改接缝

| 文件 | 修改位置 | 为什么修改 |
| --- | --- | --- |
| `functions/upload/index.js` | 顶部保护导入、`onRequest`、`uploadFileToCloudflareR2` | 普通上传统一调用保护包装器；保护异常返回 503 且 no-store |
| `functions/upload/chunkUpload.js` | 初始化分片与上传 part 的 R2 获取处 | 保护 CreateMultipartUpload、UploadPart 及恢复句柄后的调用 |
| `functions/upload/chunkMerge.js` | R2 合并/complete 处 | 完成分片也必须预留，不能只限制第一次上传 |
| `functions/file/[[path]].js` | `getGuardedR2` 获取处、R2 读图 catch | GET/HEAD/Range 复用原业务；保护异常转本地占位图，其他错误保留原错误处理 |
| `functions/api/manage/delete/[[path]].js` | R2 获取处 | 删除经过同一保护。即使官方删除免费，本账本仍保守预留 A 类，不退款 |
| `functions/api/manage/move/[[path]].js` | R2 获取处 | 移动中的读取、复制写入、删除都受保护，多个步骤不是一次免费操作 |
| `functions/api/manage/rename/[[path]].js` | R2 获取处 | 重命名与移动一样，不允许绕过包装器直接操作桶 |
| `functions/_middleware.js` | 根 `onRequest` | 旧 Cloudflare 部署进入维护 503；服务器适配器明确设置 server 模式后才放行 |
| `frontend-dist/index.html` | body 末尾加载 `/entry/storage-summary.js` | 在原界面上挂载侧栏，不直接编辑压缩后的 Vue bundle |
| `Dockerfile` | 运行层 `COPY extensions` | 服务器函数依赖扩展模块，镜像中缺目录会在运行时导入失败 |
| `deploy/server/index.js` | 文件头、DATA_DIR、R2/统计库初始化、`createEnv`、请求 origin 和监听参数 | 扩展既有服务器适配器，支持私有 R2、第二数据库和 HTTPS 代理 |
| `deploy/server/sqliteD1.js` | 构造函数、`batch` | WAL/外键/忙等待；D1 batch 用同库事务执行，供差异核对原子提交 |

保留原文件 ID、`R2_env` 渠道元数据和账号设置，没有批量重写历史图片记录。标签列的 `v2.2.1_add_tags_column.sql` 属于上游迁移，不是本次新增的费用表。

## 4. 服务器部署新增文件

| 文件 | 关键内容 |
| --- | --- |
| [cloudflareR2.js](../deploy/server/cloudflareR2.js) | `CloudflareR2` 模拟原桶接口；AWS SDK `maxAttempts:1`；Standard 写入；Range、流、元数据与分片适配。自身不判断额度，只能从保护包装器调用 |
| [importSnapshot.mjs](../deploy/server/importSnapshot.mjs) | 导入完整 JSON 快照到新 SQLite；拒绝覆盖、事务、行数和 integrity_check |
| [syncUsage.mjs](../deploy/server/syncUsage.mjs) | systemd 一次性同步入口，打开独立统计库并在结束时关闭 |
| [主服务](../deploy/server/d3ling-imgbed.service) | 独立无登录用户、资源上限、只写 data、配置保存在仓库外 |
| [同步服务](../deploy/server/d3ling-imgbed-sync.service) / [timer](../deploy/server/d3ling-imgbed-sync.timer) | 独立低资源任务，Asia/Shanghai 23:30，不写保护计数 |
| [nginx-rewrite.conf](../deploy/server/nginx-rewrite.conf) | 仅图床虚拟主机使用的代理片段，ACME 静态验证与业务代理分开 |
| [server.env.example](../deploy/server/server.env.example) | 无真实凭据的可复制配置模板 |
| [compose.production.yml](../deploy/server/compose.production.yml) | Docker 备选：本地端口、数据卷、资源限制；实例实际未采用此运行方式 |

## 5. 哪些值可以改、改后检查什么

| 需求 | 位置 | 检查事项 |
| --- | --- | --- |
| 更换账户 | `r2CostGuard.js: ACCOUNT` + 三个账户环境配置 | 保护和报表查询同一账户；不要只改 S3 连接 |
| 更换桶 | `R2_BUCKET` + `R2_USAGE_BUCKET` | 历史元数据对应对象仍存在；旧账本不能当新空桶直接清零 |
| 调整阈值 | 保护 `LIMITS` + 统计 `core.js: LIMITS` | 容量单位是字节；测试等于边界、并发预留与三类全停策略 |
| 修改侧栏 | `frontend-dist/entry/storage-summary.js` | 上传/管理页、登录可见性、Esc、窄屏和服务器异常 |
| 修改恢复说明 | `servicePlaceholder.js` + `IMGBED_RESTORE_AT` | 不暴露内部额度、桶名和 Token；未来时间只改文案，不自动放行 |
| 修改统计同步时间 | `d3ling-imgbed-sync.timer` | 校验时区并 daemon-reload；勿同时启用旧 Worker Cron |
| 调整部署域名 | `PUBLIC_ORIGIN`、专用 Nginx、DNS、证书 | HTTPS 上传链接与同源 POST，先测试再切换 |

`ACCOUNT`、服务路径和 Nginx 的实例目录不是通用自动发现功能，教程已明确列为其他账户复用时的修改项。本次文档与注释提交不改变线上行为。

## 6. 上游更新时的注意事项

合并上游后先检查以上接缝，不要整目录覆盖本 Fork。运行 `install.mjs` 只会恢复已知包装器引用和独立统计页：**不会恢复白色侧栏文件，也不会重新给 index.html 插入侧栏 script**。重建 `frontend-dist` 时，需要保留/恢复 `entry/storage-summary.js`，并确认 index.html 的引入仍在。

`check-integration.mjs` 会检查部分直接 R2 引用，但不能识别所有动态别名或新存储实现。新增 GET/PUT、分片、复制、删除入口都应调用 `getGuardedR2`，不能在生产业务中直接实例化 S3 客户端来操作这个桶。

测试入口：`costGuard.test.js`（原子预留与异常）、`serverR2.test.js`（S3 适配）、`storageSummary.test.js`（过期刷新与认证）、`servicePlaceholder.test.js`（占位图）、`hostingMaintenance.test.js`（旧部署停用），以及独立 `extensions/r2-usage/usage.test.mjs`（统计与权限）。自动测试使用隔离数据，不是对平台账单的证明。
