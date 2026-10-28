# macOS 安装与本机部署

## 环境

- macOS 13 或更新版本。当前 Electron 44 已移除 macOS 12 支持，参见 [Electron 44](https://www.electronjs.org/blog/electron-44-0)。支持按本机架构构建 arm64 或 x64；本次发布验证环境为 Apple Silicon。
- Node.js 22.12+，推荐 24 LTS；Electron 打包工具也要求此版本。仓库 `.nvmrc` 为 24。
- PostgreSQL 17 或更新版本及 `psql` / `pg_dump`。本机数据库只通过回环访问。
- Git、Xcode Command Line Tools；构建 iOS 还需要完整 Xcode，见 [iOS](../ios/README.md)。

如使用 Homebrew，并且电脑尚未安装这些依赖：

```bash
brew install node@24 postgresql@17
export PATH="$(brew --prefix node@24)/bin:$(brew --prefix postgresql@17)/bin:$PATH"
brew services start postgresql@17
node --version
psql -d postgres -c 'SELECT version();'
```

已有 PostgreSQL 时使用现有实例即可，不要为此启动第二个争用同一端口的服务。Homebrew 安装说明见[官方 formula](https://formulae.brew.sh/formula/postgresql@17)。

## 初始化

```bash
git clone https://github.com/su4g/game-asset-settle.git
cd game-asset-settle
npm ci
npm run setup
npm run desktop
```

默认管理连接为 `127.0.0.1:5432`、当前系统用户名、`postgres` 数据库。若你的环境不同，在本机设置 `PGHOST`、`PGPORT`、`PGUSER` 和必要的 `PGPASSWORD` 后运行 `setup`；不要把真实密码写进 README、命令截图或提交文件。用于初始化的角色需有建角色 / 建数据库权限，日常运行使用新建的低权限应用角色。

初始化创建 `game_asset_settle` 数据库、`game_asset_settle_app` 角色和独立订单归档表，生成随机应用密码与回环配对码。配置位于当前克隆目录的 `.ledger/config.json`，目录权限 0700、文件权限 0600。配置丢失时先找回私有备份；脚本不会接管同名数据库。

开发模式会尝试加载当前仓库的配置。若界面提示未连接，打开“运行状态 → 选择现有账本配置”，选择 `.ledger/config.json`。原生对话框可显示隐藏文件，也可按 `⌘⇧G` 输入配置所在目录。打包版首次启动也这样选择。数据库服务应先运行；App 可自动拉起回环账本 HTTP 服务，默认端口 3217，仅绑定 `127.0.0.1`。

## 打包与固定入口

```bash
npm run desktop:package
```

构建结果放在 `.desktop-output/apps/build-*/`，固定链接 `.desktop-output/饰品交易账本.app` 指向当前版本。打包脚本在签名检查后维护 `/Applications/饰品交易账本.app`，正常退出旧实例并从该入口打开新版；旧名称“BUFF 本机助手”作为兼容入口。保留克隆目录、固定链接与当前构建目录，避免入口失效。

- `-- --no-relaunch`：安装 / 更新入口，但不自动重开，适合验收。
- `-- --no-install`：只生成应用，不改“应用程序”入口，也不启动 App，适合第二份 checkout 或 CI。
- `-- --relaunch-only`：正常退出旧版并打开已经构建的最新入口。

如果 `/Applications` 已存在来自另一项目路径的同名入口，脚本会停止，不覆盖它。先确认原应用和数据的归属；不要删除正在使用的目录。隔离测试可直接使用 `--no-install`。

生成的是 ad-hoc 本机签名，没有内置开发者证书或 Apple 公证。对外分发应由发布者另行完成 Developer ID 签名与公证；不要全局关闭 Gatekeeper。源码构建不提供跨架构通用包承诺。

## 后台与备份

App 内“启动及每 6 小时自动同步”只在 App 运行时生效。关闭主窗口后菜单栏仍保留；退出 App 或休眠会停止采集，唤醒后补一次到期任务。登录失效只通知并暂停，用户需主动重新登录。

通常由 App 管理回环服务即可；如果需要独立启动或排查：

```bash
npm run service:start
npm run service:status
npm run service:stop
npm run backup
```

`backup` 生成 `.ledger/backup-*.dump`，需要 `pg_dump` 在 PATH 中。`npm run service:install` 可选安装当前 macOS 用户的账本服务 LaunchAgent；这不等于自动启动 App 或平台采集。停止前先停止 App 中同步，App 后续可能重新启动其需要的回环服务。

恢复 / 换机要同时保管数据库备份、`.ledger/config.json`、App 偏好与云同步设备状态。App 私有状态在 `~/Library/Application Support/buff-goods-desktop/`，含平台会话，不能打包公开。不要删除 `cloud-sync-state.json` / `cloud-pending.json` 以绕过云端归属冲突。

## 排查

| 现象 | 检查方法 |
| --- | --- |
| `EBADENGINE` | 更新 Node 至 22.12+，推荐 24，重新 `npm ci` |
| `ECONNREFUSED` / 本机账本未连接 | 确认 PostgreSQL 已启动、配置有效、3217 未被其他应用占用 |
| 数据库已存在但缺配置 | 恢复原配置，不清库或新建随机身份接管原数据 |
| 平台页未登录 | 在 App 内重新登录；Safari / Chrome 会话不自动共享 |
| 刚登录就被提示重新认证 | 返回 App 点“检查登录”；该操作会先关闭官方登录窗口 |
| Steam 429 / 503 | 等待持久冷却结束，不连续点击重试 |
| 窗口关闭后仍在运行 | 这是菜单栏后台行为；需要停止时从菜单中退出 |

接下来查看[三平台登录与日常使用](login-and-use.md)。
