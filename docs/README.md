# 本 Fork 的部署与改动说明

这份文档对应 **D3LingCN/CloudFlare-ImgBed** 的服务器部署版本。原项目的文件管理、账号与上传界面继续使用；新增私有 R2 服务器适配、费用保护、用量统计和可收缩侧栏。

| 想了解什么 | 阅读位置 |
| --- | --- |
| 从准备服务器到 HTTPS 上线、迁移与备份 | [宝塔部署教程](server-deployment.md) |
| 哪些文件新增或修改、关键函数在哪里 | [代码改动地图](code-changes.md) |
| 新增哪些表、字段含义、哪些计数不能清零 | [数据库说明](database-schema.md) |
| 统计扩展的接口、计数口径和上游合并 | [用量扩展说明](../extensions/r2-usage/README.md) |
| 可复制的服务器配置模板 | [server.env.example](../deploy/server/server.env.example) |
| 自动化测试的覆盖范围 | [测试说明](../test/README.md) |

当前架构：浏览器 → 专用 Nginx 站点 → Node.js 图床 → 费用保护 → 调用统计 → 私有 R2。文件元数据、账号设置和保护账本保存在服务器的 `database.sqlite`；统计记录保存在独立的 `usage.sqlite`。

图片没有迁入服务器磁盘。服务器部署时，D1 接口由本地 SQLite 适配器实现，正常上传和读图不再通过 Cloudflare Pages Functions 或云端 D1。

本文档不包含密码、访问密钥、数据库导出文件或生产配置。代码中的注释统一使用 `R2保护扩展` 标记，可用 `rg -n 'R2保护扩展' functions deploy/server extensions frontend-dist/entry` 定位。

费用保护是应用内的保守拦截措施，不能替代平台账单限制，也不能控制绕过本图床的其他密钥、公开桶地址或第三方程序操作。不要将“85% 阈值”理解为平台承诺不收费。
