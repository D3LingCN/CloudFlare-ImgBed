# 宝塔部署教程：服务器运行图床，图片保留在私有 R2

适用版本：本 Fork 的 Node.js + systemd 部署；最后核对于 2026-10-16。请先读完迁移与切换部分，再操作已有生产站点。

## 1. 部署结果与前提

- 图床程序由服务器运行，Nginx 只为图床域名反向代理。
- 图片继续放在 **R2 Standard 私有桶**，不开放 `r2.dev` 或直接读桶的公开域名。
- 主库 `database.sqlite` 保存原文件记录、设置和新增保护账本；`usage.sqlite` 保存新增统计表。
- 上传页 `/`、`/upload` 和管理页 `/dashboard` 增加右侧可收缩用量侧栏。
- 达到保护阈值或统计异常时，R2 操作停止；读图的保护异常返回程序内置的小型 SVG。

需要域名、已授权的 R2 账户、Linux 服务器、Nginx，以及兼容的 Node.js 和原生模块编译环境。本次实例使用 Ubuntu 24、宝塔已有 Node.js 24.22.0；仓库 Docker/CI 使用 Node.js 22。安装后必须实际检查 `better-sqlite3` 和 `sharp`，不能只看 npm 的退出状态。

下文的目录名、服务名沿用本 Fork 模板；域名、账户 ID、桶名和 Node.js 路径需换成自己的。命令以 Linux shell 为例。**新建独立目录和虚拟主机，不覆盖其他网站目录，不修改服务器全局 Node.js 或 Docker 镜像源。**

## 2. 费用保护到底保护什么

按核对日期的 [R2 官方计费说明](https://developers.cloudflare.com/r2/pricing/)，Standard 免费额度与代码阈值如下；Infrequent Access 不适用该免费额度。

| 项目 | 官方免费额度 | 本 Fork 拦截阈值 |
| --- | --- | --- |
| 存储 | 每月 10 GB-month | 8,500,000,000 字节 |
| A 类操作 | 每月 1,000,000 次 | 850,000 次 |
| B 类操作 | 每月 10,000,000 次 | 8,500,000 次 |

存储的 GB-month 是计费周期内的容量指标，不等于某一时刻的占用；本程序用容量高水位和写入预留作保守限制。R2 出站流量免费也不代表读对象操作不计次数。上传通常涉及 A 类；图片回源通常涉及 B 类；分片、移动和重命名可能涉及多次操作。

拦截由 `functions/utils/r2CostGuard.js` 执行：先刷新必要的账户统计，再用一次条件 SQL 原子预留，最后才调用 R2。比较使用严格 `<`，预留后等于阈值也不放行。任一项到限会停止所有受保护的 R2 操作，包括删除。

保护账本 **不会月初自动清零、失败退款、删除退款或降低官方高水位**。本月统计报表按 UTC 自然月展示，但保护统计查询最近 31 天操作、最近 24 小时容量，且累计高水位单调不减；这两者不是同一个计数器。官方统计和本地预留可能重叠，因此会提前锁定。恢复应先核对账单周期、账户其他桶与待完成分片，备份账本，再人工审计；不要为了让页面变绿直接改计数。

## 3. 准备 R2 的两类凭据

### 对象访问凭据

在 R2 管理界面创建专用对象读写密钥，范围只选图床桶；能够设置来源 IP 时，仅允许服务器出口 IP。保存 Access Key ID 和 Secret Access Key 到服务器私密配置。有效期按自己的维护计划设置，并记录到期日。

不要使用全部桶管理员密钥。保持原桶、对象 key、元数据和存储类别；不要为了服务器部署重建桶或批量复制图片。

### 只读统计 Token

使用当前账户的 `Account Analytics Read` Token，配置为 `CF_R2_ANALYTICS_TOKEN`。它用于 GraphQL 核对，不是 S3 对象密钥。详见 [R2 分析接口](https://developers.cloudflare.com/r2/platform/metrics-analytics/) 和 [R2 认证说明](https://developers.cloudflare.com/r2/api/tokens/)。

**本 Fork 尚有实例专用常量**：`functions/utils/r2CostGuard.js` 的 `ACCOUNT`。其他账户部署前，必须将其改为自己的账户 ID，并与 `R2_ACCOUNT_ID`、`R2_USAGE_ACCOUNT_ID` 保持一致。只改环境变量不会改变这个保护查询常量。

阈值也有两处：保护模块的 `LIMITS` 与 `extensions/r2-usage/core.js` 的 `LIMITS`。改变政策时两处一起审查，保留测试；`FREE_TIER` 是报表分母，不是拦截阈值。

## 4. 准备独立目录和依赖

建议布局：

```text
/www/wwwroot/d3ling-imgbed/
├── releases/<版本>/       源码与 node_modules
├── current -> releases/<版本>
├── data/                 database.sqlite、usage.sqlite 及 WAL 文件
├── backups/              私密导出、在线备份和变更前配置
├── public/               仅存 HTTPS 验证文件，不放源码或配置
└── server.env            真实密钥，root 可读
```

获取源码后，在版本目录安装服务器工作区依赖：

```sh
umask 022
install -d -m 755 /www/wwwroot/d3ling-imgbed/releases /www/wwwroot/d3ling-imgbed/public
install -d -m 700 /www/wwwroot/d3ling-imgbed/data /www/wwwroot/d3ling-imgbed/backups
git clone https://github.com/D3LingCN/CloudFlare-ImgBed.git /www/wwwroot/d3ling-imgbed/releases/initial
cd /www/wwwroot/d3ling-imgbed/releases/initial
export PATH=/www/server/nodejs/v24.22.0/bin:$PATH
npm ci --workspace=@cloudflare-imgbed/common --workspace=@cloudflare-imgbed/server --omit=dev
node -e "const D=require('better-sqlite3');const d=new D(':memory:');console.log(d.prepare('select 1 as ok').get());d.close();console.log(require('sharp').versions.sharp)"
```

若原生模块需编译，使用系统已安装或系统软件仓库提供的 Python、make、g++。不要把 `build_from_source` 全局强制到所有依赖；本次部署遇到过 sharp 被连带强制编译的问题。

依赖安装只在新版本目录进行。`current`、`data` 和 `server.env` 的权限与创建顺序见下面步骤。

## 5. 迁移已有数据，或初始化新站点

### 已有 D1 图床

1. 先让旧图床停止写入和读桶，确保迁移期间只有一个写入方。本 Fork 的根中间件会让非服务器部署返回维护 503；不要给旧 Pages 配置 `IMGBED_HOSTING_MODE=server`。
2. 导出 **整个业务 D1**，包含原表和 `r2_cost_guard`；另行导出 **整个统计 D1**，包含五张 `usage_*` 表。仅导出 `files` 会丢失设置、账号会话及费用账本。
3. 两份导出放在私密目录；原云端数据库先保留。R2 对象不迁移、不改 key。

若使用 Wrangler 标准 SQL 导出，在已配置相应账户和 D1 的私密操作环境执行：

```sh
umask 077
npx wrangler d1 export YOUR_BUSINESS_D1_NAME --remote --output=meta.sql
npx wrangler d1 export YOUR_USAGE_D1_NAME --remote --output=usage.sql
```

将 SQL 文件安全传到服务器的 `backups/`。安装 SQLite CLI 后，确认目标文件不存在，再导入；不要导入到正在运行的库：

```sh
test ! -e /www/wwwroot/d3ling-imgbed/data/database.sqlite && sqlite3 /www/wwwroot/d3ling-imgbed/data/database.sqlite < /www/wwwroot/d3ling-imgbed/backups/meta.sql
test ! -e /www/wwwroot/d3ling-imgbed/data/usage.sqlite && sqlite3 /www/wwwroot/d3ling-imgbed/data/usage.sqlite < /www/wwwroot/d3ling-imgbed/backups/usage.sql
sqlite3 /www/wwwroot/d3ling-imgbed/data/database.sqlite 'PRAGMA integrity_check; SELECT count(*) FROM files; SELECT count(*) FROM settings;'
sqlite3 /www/wwwroot/d3ling-imgbed/data/usage.sqlite 'PRAGMA integrity_check; SELECT count(*) FROM usage_tokens;'
```

还要逐字段比对原文件记录、设置、令牌哈希与六个保护计数。表行数相同不足以证明内容完整。导入失败时保留原导出，换一个新目标文件排查，不直接上线半成品库。

本次实例采用了完整 JSON 快照导入。仓库也提供 [importSnapshot.mjs](../deploy/server/importSnapshot.mjs)：输入必须是 `{schema:[{type,name,sql},...],rows:{表名:[完整行,...]}}`，不能传 Wrangler 的 `.sql` 文件。它拒绝覆盖目标库、事务导入、核对行数和完整性；字段级比对仍需额外完成。JSON 行必须只包含真实列名；不要使用手工按逗号切分 SQL 的解析器。

### 全新站点

启动时 `index.js` 会执行业务初始化 SQL、迁移和独立统计 schema。首次使用仍需在管理界面配置管理员、上传认证及 R2 渠道。保护库默认“未核对”，不能跳过统计 Token。

新桶若还没有可核对的官方容量统计，保护会停止首次操作；等待统计可用并检查配置，不把缺失数据当成容量为零。

`r2_cost_guard.sql` 中的 1 MB / A 1000 / B 1000 是本实例早期少量测试的保守基线，不是官方免费额度，也不能用来代表任意旧桶。已有站点必须迁移原账本；已有桶的新接入必须另行核对实际历史用量。

## 6. 私密配置与服务账户

```sh
getent passwd imgbed || useradd --system --user-group --home-dir /www/wwwroot/d3ling-imgbed --shell /usr/sbin/nologin imgbed
install -d -m 700 /www/wwwroot/d3ling-imgbed/backups
install -d -o imgbed -g imgbed -m 700 /www/wwwroot/d3ling-imgbed/data
install -d /www/wwwroot/d3ling-imgbed/public
cp deploy/server/server.env.example /www/wwwroot/d3ling-imgbed/server.env
chmod 600 /www/wwwroot/d3ling-imgbed/server.env
```

在私密编辑器中填写 `server.env`。不要在命令行参数、截图、日志或仓库中放入真实密钥。systemd 由 root 读取配置后注入服务环境，`imgbed` 用户只需读写 `data/`。

| 配置 | 作用 |
| --- | --- |
| `R2_STORAGE_MODE=cloudflare` | 必填；否则程序会使用本地文件存储适配器 |
| `R2_ACCOUNT_ID` / `R2_BUCKET` | S3 连接使用的账户与原私有桶 |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | 仅服务器使用的对象读写密钥 |
| `CF_R2_ANALYTICS_TOKEN` | 只读统计凭据；缺失会停止 R2 操作 |
| `R2_USAGE_ENABLED=1` | 启用实际 SDK 调用统计；不要删除此项规避统计异常 |
| `R2_USAGE_ACCOUNT_ID` / `R2_USAGE_BUCKET` | 月度报告的账户与桶 |
| `PUBLIC_ORIGIN` | 固定公网 HTTPS origin，不带路径；决定上传链接与同源校验 |
| `BIND_HOST=127.0.0.1` / `PORT=7658` | 内部监听；不把应用端口直接开放到公网 |
| `DATA_DIR` | 指向迁移后的持久化数据目录 |
| `IMGBED_RESTORE_AT` | 可选：经确认的未来恢复时间；不会自动解锁保护 |

导入后的数据库文件应归 `imgbed` 所有，权限 600；源码由部署账户持有，服务无需写源码。真实配置和数据库均不放在 `public/`。

```sh
chown -R imgbed:imgbed /www/wwwroot/d3ling-imgbed/data
find /www/wwwroot/d3ling-imgbed/data -type f -name '*.sqlite*' -exec chmod 600 {} +
```

## 7. 安装 systemd 服务

编辑三份 [systemd 模板](../deploy/server/d3ling-imgbed.service)，核对其中的 Node.js 路径、工作目录、配置文件路径和可写目录。主服务限制内存 768 MiB、CPU 为单核的 75%；同步服务另有更小的限制。

```sh
ln -s /www/wwwroot/d3ling-imgbed/releases/initial /www/wwwroot/d3ling-imgbed/current
install -m 644 deploy/server/d3ling-imgbed.service deploy/server/d3ling-imgbed-sync.service deploy/server/d3ling-imgbed-sync.timer /etc/systemd/system/
systemd-analyze verify /etc/systemd/system/d3ling-imgbed.service /etc/systemd/system/d3ling-imgbed-sync.service /etc/systemd/system/d3ling-imgbed-sync.timer
systemctl daemon-reload
systemctl enable --now d3ling-imgbed
systemctl enable --now d3ling-imgbed-sync.timer
systemctl start d3ling-imgbed-sync.service
systemctl show d3ling-imgbed -p ActiveState -p MemoryCurrent
systemctl show d3ling-imgbed-sync.service -p Result -p ExecMainStatus
systemctl list-timers d3ling-imgbed-sync.timer
```

定时校对每天北京时间 23:30 执行，允许最多 30 秒随机延迟，关机错过时会补执行。它写统计快照，不清空保护账本。Cloudflare 旧调度器的 `wrangler.toml` 已配置 `crons=[]`；不要同时恢复旧 Cron。

## 8. 宝塔站点、HTTPS 与域名切换

1. 新建只绑定图床域名的 HTML 站点，根目录设为上述 `public/`；不要使用整个程序目录。
2. 将 [nginx-rewrite.conf](../deploy/server/nginx-rewrite.conf) 加入该站点的伪静态/专用 include。它代理到 `127.0.0.1:7658`，保留 Host 和来源 IP，同时单独放行 ACME 验证路径。该文件是 server 块内片段，不是完整 Nginx 主配置。
3. 用 `nginx -t` 检查后平滑 reload；核对其他站点配置未变。
4. 旧域名还指向 Pages 时，可用 DNS TXT 验证先签发免费证书。部署证书后，用下列方式直连新服务器验证，**不要加 `-k` 跳过证书检查**：

```sh
curl --resolve img.example.com:443:YOUR_SERVER_IP -I https://img.example.com/
curl --resolve img.example.com:443:YOUR_SERVER_IP -I https://img.example.com/file/EXISTING_IMAGE_KEY
```

5. 测试通过后，只把图床域名的记录切为服务器 A 记录；保留其他域名。DNS 缓存传播期间有些客户端可能仍见旧维护页。
6. 开启图床站点 HTTPS 跳转。切换后可重新使用文件验证签发/配置免费证书，避免手动 DNS 模式需要人工续期；确认 `/.well-known/acme-challenge/` 由 `public/` 提供，不进入图床处理链。
7. 核验公网上传、原图片、管理页、侧栏，以及普通 HTTP 跳转和新的证书链。记录证书有效期及续期方式。

## 9. 验收与维护

部署前在开发环境执行：

```sh
npm ci
npm test
npm run test:server
node extensions/r2-usage/check-integration.mjs
node --test extensions/r2-usage/usage.test.mjs
```

上线验收至少包括：原账号登录；原图完整性；一个小型测试图片上传和下载哈希；HEAD/Range；匿名用量接口 401；登录后侧栏显示与收缩；隔离环境中容量/A/B 到限和统计异常不调用 R2；保护异常读图返回本地占位图。真正锁定生产库会让博客图片进入维护状态，故障注入应在切域名前或隔离环境执行。

日常查看 `journalctl -u d3ling-imgbed` 和 `journalctl -u d3ling-imgbed-sync.service`。修改程序后只重启图床服务；不要重启其他网站的进程。对启用 WAL 的 SQLite 做在线 backup，或停图床后完整备份数据目录；不要在运行中只复制主 `.sqlite` 而漏掉未落盘的 WAL。

每次更新应保留旧版本目录、两份数据库备份和该站点的 Nginx 配置。回退程序时继续使用最新保护账本；**旧备份中较低的计数不能直接恢复到生产**。DNS 回到旧 Pages 只会回到维护页，恢复旧程序是另一个需要验证的步骤。

## 10. 常见故障

| 现象 | 排查方向 |
| --- | --- |
| 首页 503 维护页 | 请求到了旧 Pages，或服务器模式没有生效 |
| 图片是维护占位图 | 检查保护是否锁定、统计 Token/账户、官方统计有效性与阈值；不是看到 HTTP 200 就算原图成功 |
| 用量暂时无法获取 | 检查管理员/上传会话、两份数据库、统计核对租约和服务日志；不要伪装成 0 |
| 容量删除后不减少、月初仍锁定 | 当前账本设计如此，删除和月份变化不退款、不自动清零 |
| 上传 URL 是 HTTP 或同步接口 403 | 核对 `PUBLIC_ORIGIN` 与公网域名/HTTPS、Origin 和代理配置 |
| 文件还在 R2，管理页却为空 | 业务元数据库未迁移或 `DATA_DIR` 错误；不要先重传图片 |
| 原生模块加载失败 | 核对安装依赖和运行服务使用同一个 Node.js 版本及架构 |
| 出现未知 R2 操作 | 保护默认停止，先查官方操作含义并增加验证；不要直接加入免费白名单 |

Docker 配置仅作为备选，见 `Dockerfile` 和 `deploy/server/compose.production.yml`；当前实例实际使用 systemd。Compose 不会自动运行本教程的主机定时同步任务，切换部署方式时需重新配置调度与持久化，不能只启动容器就算迁移完成。
