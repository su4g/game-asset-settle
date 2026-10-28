# 自托管云端与 iOS 查询 API

云服务接收 Mac 上传的订单快照，复用桌面纯计算模块生成手机视图。它不登录交易平台，不保存平台 Cookie，不操作资金或物品。只在 Mac 使用时可跳过本篇。

以下为**新环境部署示例**，不是作者的服务器信息。需自行准备 Linux / systemd、Node.js 24、Docker、Nginx、域名及可信 HTTPS 证书。先在自己的测试主机验证；已有服务或同名容器时不要直接执行首次安装步骤。

## 1. 在 Mac 生成独立凭据

在仓库中安装依赖后，将示例域名换成你拥有的域名：

```bash
mkdir -p "$HOME/.config"
npm run cloud:configure -- \
  --base-url https://ledger.example.com/buff-helper-api \
  --output "$HOME/.config/game-asset-settle"
npm run cloud:package
```

输出目录必须是**仓库外、尚不存在的新目录**；父目录需存在。脚本拒绝覆盖原目录，失败后保留已生成文件，不会静默轮换现有凭据。代码打包和凭据生成完全分离，`cloud:package` 不读取真实连接或服务器配置。

| 私有文件 | 去向 / 权限 |
| --- | --- |
| `cloud-server.json` | 服务器 `/etc/game-asset-settle/cloud.json`，含数据库密码、只读码、两组写入码 |
| `postgres.env` | 仅服务器 root，初始化专用 PostgreSQL 管理角色 |
| `account-1.buffdesktop` | 账户一的采集终端，含该组写入码与查询码 |
| `account-2.buffdesktop` | 账户二的采集终端，含该组写入码与查询码 |
| `mobile.buffconnection` | 可信手机，只含查询码；可读取两组数据 |

文件为 0600、目录为 0700。每次新部署生成全新随机凭据；请私下保存并传输，禁止放进 Git、安装包、日志、网页或 Issue。`ledger.example.com` 是保留示例域名，无法作为现成云服务使用。

## 2. 准备专用服务和数据库

将 `cloud:package` 输出的 `release.tar.gz`，以及 **仅** `cloud-server.json` / `postgres.env`，通过自己的 SSH / SFTP 传到新服务器 root 私有目录，例如 `/root/game-asset-settle-stage/`（0700）。连接文件给对应终端即可，服务器不需要手机文件。

下面在服务器 root 执行。首先确认 `3327`、`15439` 未被占用，`game-asset-settle` 用户、`game-asset-settle-db` 容器、下述目录尚不存在；有冲突就停止并调整自己的部署规划，不能覆盖其他服务。

```bash
ss -lnt
command -v node
node --version
docker ps -a

umask 077
settle_stage=/root/game-asset-settle-stage
settle_stamp=$(date -u +%Y%m%dT%H%M%SZ)
useradd --system --no-create-home --shell /usr/sbin/nologin game-asset-settle
install -d -m 755 /opt/game-asset-settle/releases
install -d -o root -g game-asset-settle -m 750 /etc/game-asset-settle
install -o game-asset-settle -g game-asset-settle -m 600 "$settle_stage/cloud-server.json" /etc/game-asset-settle/cloud.json
install -o root -g root -m 600 "$settle_stage/postgres.env" /etc/game-asset-settle/postgres.env

tar -xzf "$settle_stage/release.tar.gz" -C "$settle_stage"
mv "$settle_stage/release" "/opt/game-asset-settle/releases/$settle_stamp"
chmod -R a+rX "/opt/game-asset-settle/releases/$settle_stamp"
ln -s "releases/$settle_stamp" /opt/game-asset-settle/current

docker volume create game-asset-settle-postgres
docker run -d --name game-asset-settle-db --restart unless-stopped \
  --publish 127.0.0.1:15439:5432 \
  --env-file /etc/game-asset-settle/postgres.env \
  --mount type=volume,source=game-asset-settle-postgres,target=/var/lib/postgresql/data \
  --memory 512m --cpus 0.5 --pids-limit 128 \
  --log-opt max-size=10m --log-opt max-file=3 \
  postgres:17 -c shared_buffers=64MB -c max_connections=20
```

正式部署请记录并固定你拉取镜像的 digest，避免升级时不知情地更换数据库版本。这个容器只服务本项目，数据库端口不开放公网。首次启动等待 `pg_isready` 成功后再继续：

```bash
docker exec -u postgres game-asset-settle-db pg_isready -U buff_cloud_admin -d postgres
node /opt/game-asset-settle/current/cloud/provision-db.cjs
```

`provision-db.cjs` 只针对命名的专用容器创建 `buff_goods_cloud` / `buff_cloud_app`，并限制默认连接权限；遇到已有角色或数据库即失败。**仅首次执行**，不得用于升级，也不得将容器名改成其他业务的数据库。应用启动时只迁移自己的 `buff_cloud` schema。

## 3. 启动服务

```bash
cp /opt/game-asset-settle/current/cloud/deploy/game-asset-settle.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now game-asset-settle.service
curl --fail http://127.0.0.1:3327/v1/health
```

模板 `ExecStart` 使用 `/usr/bin/node`；如果 `command -v node` 的结果不同，先修改这一行，再启动。服务以无登录权限的专用用户运行，只监听 `127.0.0.1:3327`，数据库连接使用低权限应用角色。不要在浏览器渲染页面中放入配置。

## 4. 接入 HTTPS

在自己域名的 **HTTPS `server {}`** 中加入 [nginx-location.conf](deploy/nginx-location.conf) 的内容或 include 该片段。保留原 TLS 证书、其他 location 和已有端口，只为 `/buff-helper-api/` 增加反向代理。

操作顺序：备份你要修改的那个 vhost 文件 → 添加片段 → `nginx -t` → 检查通过才 `systemctl reload nginx`。检查失败先还原备份，不 reload 错误配置。本仓库不提供针对个人服务器 vhost 的自动修改脚本。

```bash
nginx -t
systemctl reload nginx
curl --fail https://ledger.example.com/buff-helper-api/v1/health
```

请求体限制为 70 MiB，服务解压后的 JSON 上限为 64 MiB。代理必须保留 `Authorization`，不要记录认证头或响应内容。手机和桌面连接均要求 HTTPS；桌面固定路径 `/buff-helper-api`、443 端口，拒绝 URL 内嵌凭据、参数、片段及重定向。自建地址从连接文件读取，不会回退到作者服务器。

## 5. 终端上传和手机验证

Mac 先选择对应账户组并完成平台登录，在“账户与同步”导入该组 `.buffdesktop`，点击“立即上传云端”。第一次成功上传将该组锁定到该设备；另一终端不能用新设备身份覆盖已有组。另一组使用它自己的连接文件。

iOS 导入 `.buffconnection` 后查询。也可以在可信本机运行只读检查（不输出返回数据和凭据）：

```bash
node cloud/verify-deployment.cjs "$HOME/.config/game-asset-settle/mobile.buffconnection"
```

检查健康、两账户和六类视图，不要求账户为空，不创建测试订单。正常更新读取码后要重新分发手机连接文件；更换账户写入码时导入对应新文件，不能丢弃待传批次和设备序号。读取码和写入码必须互不相同。

## API 与约束

| 方法 / 路径（均相对 `/buff-helper-api`） | 权限 |
| --- | --- |
| `GET /v1/health` | 匿名健康检查 |
| `GET /v1/profiles` | 只读码 |
| `GET /v1/profiles/:id/overview` | 只读码 |
| `GET /v1/profiles/:id/orders` | 只读码，支持分页与筛选 |
| `GET /v1/profiles/:id/holdings` | 只读码 |
| `GET /v1/profiles/:id/report` | 只读码 |
| `GET /v1/profiles/:id/alchemy` | 只读码，每页 20 条 |
| `GET /v1/profiles/:id/sync-status` | 只读码 |
| `POST /v1/sync` | 对应账户组写入码 |

正常响应 `{ok:true,result:...}`，错误 `{ok:false,code,error}`。私有接口用 `Authorization: Bearer …`，不支持浏览器跨站访问，不缓存敏感响应。查询码可看两组，写入码每个只能写一组；这是个人两组账户服务，不是多租户 SaaS。

上传 envelope 为 `{schemaVersion:1,deviceId,sequence,profiles:[profile],collectedAt}`。同设备 / 同序号 / 同内容可幂等重试；账户交叉、设备变化、旧序号、同序号不同内容、丢失原历史都会拒绝。断网保留原批，不以新设备覆盖。客户端不会把平台认证字段放入快照，服务端也会拒绝此类字段。

## 备份、升级与回退

```bash
cp /opt/game-asset-settle/current/cloud/deploy/game-asset-settle-backup.service /etc/systemd/system/
cp /opt/game-asset-settle/current/cloud/deploy/game-asset-settle-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now game-asset-settle-backup.timer
systemctl start game-asset-settle-backup.service
```

每日 UTC 03:30（北京时间 11:30）加最多 15 分钟随机延迟，只备份本项目数据库到 `/var/backups/game-asset-settle/`，保存 SHA-256。目录 / 文件权限为 0700 / 0600。应另做加密异地备份，不能只依赖同服务器副本。

```bash
bash /opt/game-asset-settle/current/cloud/restore-check.sh /var/backups/game-asset-settle/buff_goods_cloud-实际时间.dump
```

恢复检查只创建 `buff_goods_test_cloud_restore_` 临时库，完成后删除，不覆盖生产库。真正恢复应先停止本服务、保留新备份、恢复至新命名的专用数据库，验证后才修改私有配置中的 database 字段；同时核对终端序号，不能清零身份绕过冲突。

升级先备份，在新时间戳目录解压新代码、检查 `release-manifest.json` 的文件哈希，再原子替换 `current` 链接，**仅重启 `game-asset-settle.service`**。保留旧目录可回退；数据库迁移需单独评估与旧代码兼容性。升级不运行 `provision-db.cjs`，不重建 Docker 数据卷、不重写已有连接文件。

排查可查看 `systemctl status game-asset-settle.service` 与 `journalctl -u game-asset-settle.service`。公开反馈时只提供错误代码、版本和已检查的步骤，不公开服务器配置或日志中的个人数据。
