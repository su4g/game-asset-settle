# 饰品交易账本官网

中文静态首页，介绍 BUFF / 悠悠有品 / Steam 个人交易账本、macOS 本机归档与 iOS 云端快照查询。真实软件截图尚未采集，页面中的两处展示位明确标为预留。GitHub 链接统一指向 <https://github.com/su4g/game-asset-settle>。

## 本地预览

需要 Node.js 20 或更新版本，不需要安装依赖，也不打包 Mac / iOS 程序。

```bash
node website/build.mjs
python3 -m http.server 4173 --bind 127.0.0.1 --directory website/dist
```

访问 `http://127.0.0.1:4173/`。构建采用文件允许列表，只发布首页、CSS、少量交互脚本、图标与搜索引擎元数据。无分析脚本、第三方字体、客户端 API 请求、账号登录或业务数据库连接。

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
5. 在 Cloudflare 将 `www` 记录改为 CNAME → `su4g.github.io`，代理状态设为 **DNS only**。不要改动其他子域名记录。
6. 等待 GitHub 的 DNS 检查和证书签发完成后启用 **Enforce HTTPS**。证书由 GitHub Pages 托管和续期。

自定义域名必须先在 GitHub 绑定再调整 DNS。GitHub Actions 构建无需 `CNAME` 文件；正式域名以 Pages 设置为准。官网是项目介绍页，应用订单数据与云接口继续由应用自己的服务管理。

## 补充软件截图

在 `src/index.html` 查找 `data-screenshot="macos"` 和 `data-screenshot="ios"`。用本地 `<img>` 替换相应 `.screenshot-slot` 内的占位结构，设置描述性的中文 `alt`、真实宽高，保留设备框外观。桌面位约 16:10，手机位约 9:18.8；CSS 使用 `object-fit: contain`，不会裁去界面内容。

将脱敏截图放到 `src/assets/` 并加入 `build.mjs` 的 `assets` 允许列表；同时修改展示说明，不再显示“截图预留”。截图不得包含平台账号、连接文件、Cookie、令牌或真实个人交易金额。不要从生产数据库生成模拟交易。

## 维护

- 页面内容：`src/index.html`；样式：`src/assets/styles.css`；移动导航：`src/assets/app.js`。
- 项目目前处于开源筹备，网页不承诺不存在的下载包、开源许可证或用户数量。正式发布后再同步更新状态和下载入口。
- 品牌图标来自本项目的桌面端图标。平台标识来自本项目已归档的官方 favicon，原始来源见 `asset-sources.json`。
- 发布前在手机与桌面宽度检查导航、锚点、FAQ、截图说明、GitHub 链接、无横向溢出和资源加载。

官方参考：[GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)、[自定义工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)、[自定义域名](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)。
