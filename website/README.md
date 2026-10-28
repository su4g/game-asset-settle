# 饰品交易账本官网

中文静态首页，介绍 BUFF / 悠悠有品 / Steam 个人交易账本、macOS 本机归档与 iOS 云端快照查询。页面包含真实 macOS 与 iPhone 应用截图，可切换界面和放大查看。GitHub 链接统一指向 <https://github.com/su4g/game-asset-settle>。

## 本地预览

需要 Node.js 20 或更新版本，不需要安装依赖，也不打包 Mac / iOS 程序。

```bash
node website/build.mjs
python3 -m http.server 4173 --bind 127.0.0.1 --directory website/dist
```

访问 `http://127.0.0.1:4173/`。构建采用文件允许列表，只发布首页、CSS、少量交互脚本、图标、授权公开的应用截图与搜索引擎元数据。无分析脚本、第三方字体、客户端 API 请求、账号登录或业务数据库连接。

默认正式地址为 `https://www.suag.top/`。构建 GitHub Pages 项目地址时：

```bash
SITE_URL=https://su4g.github.io/game-asset-settle/ node website/build.mjs
```

`SITE_URL` 同时设置资源基础路径、canonical、Open Graph 与 sitemap，因此项目子路径和自定义域名都可使用。

## GitHub Pages 发布

1. 将 `website/` 的源码放入公开仓库，将 `website/deploy/pages.yml` 复制为 `.github/workflows/pages.yml`。
2. 在仓库 Settings → Pages → Source 选择 **GitHub Actions**。
3. 推送 `main` 中的官网变更，或在 Actions 手动运行“发布项目官网”。流程只生成静态文件，不运行桌面或 iOS 构建，不需要长期访问密钥。
4. 先验证 GitHub 默认地址，再在 Pages 的 Custom domain 设置 `www.suag.top`。
5. 在 Cloudflare 将 `www` 记录改为 CNAME → `su4g.github.io`，代理状态设为 **DNS only**。根域 `suag.top` 添加 GitHub Pages 官方的四条 A 记录：`185.199.108.153`、`185.199.109.153`、`185.199.110.153`、`185.199.111.153`，均为 DNS only，供根域跳转至 www。
6. 等待 GitHub 的 DNS 检查和证书签发完成后启用 **Enforce HTTPS**。证书由 GitHub Pages 托管和续期。

自定义域名必须先在 GitHub 绑定再调整 DNS。GitHub Actions 构建无需 `CNAME` 文件；正式域名以 Pages 设置为准。官网是项目介绍页，应用订单数据与云接口继续由应用自己的服务管理。

## 软件截图

五张截图于 2026-10-28 从实际运行的 macOS 客户端和 iPhone 镜像采集：

- `macos-report.webp`：桌面收益报告。
- `macos-trends.webp`：桌面累计收益与现金收支趋势。
- `ios-overview.webp`：iPhone 账本总览。
- `ios-holdings.webp`：iPhone 持仓列表。
- `ios-report.webp`：iPhone 收益报告。

均为原始界面截图的无损 WebP 编码，未生成、重绘或修改财务数字。所有者已授权官网公开截图中的真实个人收支；平台身份不展示，画面仅有通用名称“账户一”。不得加入 Cookie、登录凭据、连接文件或访问令牌。原始采集文件保存在忽略目录 `qa/`，不随站点发布。

iPhone 展示框仅通过 CSS 隐去镜像窗口外侧留白，原始图保留完整窗口。新增图片需加入 `build.mjs` 的资源允许列表，并在 `asset-sources.json` 记录来源。无需 JavaScript 时，截图和切换链接可直接查看原图。

## 维护

- 页面内容：`src/index.html`；样式：`src/assets/styles.css`；移动导航与截图交互：`src/assets/app.js`。
- 官网使用正式产品文案。项目文档与版本入口统一链接到 GitHub，不捏造下载包、许可证或使用人数。
- 品牌图标来自本项目的桌面端图标。平台标识来自本项目已归档的官方 favicon，原始来源见 `asset-sources.json`。
- 发布前在手机与桌面宽度检查导航、锚点、FAQ、截图说明、GitHub 链接、无横向溢出和资源加载。

官方参考：[GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)、[自定义工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)、[自定义域名](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)。
