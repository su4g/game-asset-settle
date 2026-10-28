# iOS · 饰品交易账本

SwiftUI 原生只读客户端，当前 1.2.0（构建 4），支持 iOS 17+。概览、持仓、订单、炼金和收益共五个入口，连接与设置在左上角。手机只读取你自己的云服务，平台登录与同步在 Mac 完成。

源码默认地址 `https://ledger.example.com/buff-helper-api` 仅为示例，必须导入自己的连接；没有内置公共服务、访问码、Apple 团队信息或签名证书。

## 构建

Mac 需完整 Xcode（建议 26+，源码包含 iOS 26 可用性判断的 Liquid Glass API）以及 XcodeGen。iOS 17–18 使用材质回退；SDK 需支持编译新 API。Swift 包无第三方依赖。

```bash
brew install xcodegen
swift test --package-path ios
node ios/scripts/generate_contract_fixtures.cjs
bash ios/scripts/build_sideload_ipa.sh
```

构建脚本生成 Xcode 工程、构建 Release arm64、验证包结构及 HTTPS 边界。输出 `ios/build/sideload/饰品交易账本-1.2.0-4-unsigned.ipa` 与 SHA-256。这是**未签名 IPA，不能直接安装**；签名在自己的设备 / 账号环境完成。安装包不应包含连接文件、平台会话、开发者证书或 Debug 预览入口。

## 安装方式一：Xcode 真机运行

1. `open ios/BuffReader.xcodeproj`，选择 `BuffReader` target。
2. 在 Signing & Capabilities 选择你自己的 Team，按需要设置唯一 Bundle Identifier。开源工程默认 `com.buffhelper.reader`，`DEVELOPMENT_TEAM` 为空。
3. 连接 iPhone，按系统要求信任电脑、开启开发者模式，选择真机 Run。
4. 后续更新沿用自己的 Team / Bundle Identifier，保留 Keychain 连接和应用容器。

不要将 `xcuserdata`、签名配置中的个人资料或 provisioning profile 提交到仓库。若修改 `project.yml`，下次生成工程才会保留你的标识；验证脚本默认检查原始 bundle ID，自定义时需同步调整该断言。

## 安装方式二：Sideloadly

从 [Sideloadly 官方网站](https://sideloadly.io/) 获取工具，选择上一步构建的 unsigned IPA、自己的设备和 Apple 账号，按界面完成签名安装。仅在 Sideloadly / Apple 官方认证界面输入认证信息，不把 Apple 密码或令牌写进本项目。

普通免费账号侧载应用通常需要每 7 天刷新；可在 Sideloadly 中启用此应用的自动刷新，要求以[官方 FAQ](https://sideloadly.io/faq)和你的账号限制为准。更新保持相同签名身份 / Bundle ID。不要覆盖其他 App 的续签条目，构建脚本本身不会修改 Sideloadly 数据库。

## 一次性连接

先按[云端文档](../cloud/README.md)完成自托管，并让 Mac 上传自己的账户快照。由 Mac“账户与同步 → 导出手机连接文件”生成 `.buffconnection`，或使用部署时生成的手机文件。通过可信方式传到手机，打开 App 左上角设置，导入文件；亦可从“文件”App 打开对应文件。

格式示意（访问码为文字占位，不可直接使用）：

```json
{
  "version": 1,
  "baseURL": "https://ledger.example.com/buff-helper-api",
  "accessToken": "REPLACE_WITH_YOUR_GENERATED_READ_TOKEN"
}
```

验证成功后读取码保存到 Keychain；应用不要求输入 BUFF / 悠悠 / Steam 密码。查询码能读取同一部署的两组数据，没有同步写入权限。更换读取码后重新导入；失败不会覆盖已有连接。地址只允许 HTTPS，拒绝 URL 内嵌密码、查询与片段，不跟随 API 重定向。

## 使用与刷新

- 切换账户立即清空旧视图，迟到的旧账户 / 旧连接请求不会显示。
- 前台按需检查云端变化，手动下拉刷新可重读第一页；分页中检测到新快照时提示更新。
- 金额以整数分处理，未知显示“待补全”；不把持仓估值算成利润。
- 炼金只展示真实已完成事件，按合成日期筛选，现金收益与 Steam 余额盈亏独立于原收益报告。
- 手机刷新不会开启 Mac、触发平台登录或实时买卖。请同时查看平台采集时间和云端上传时间。

## 开发验证与截图

`swift test --package-path ios` 包含 DTO / API / 连接文件以及 Store 状态测试；使用隔离 UserDefaults、内存凭据与模拟 URLProtocol。`generate_contract_fixtures.cjs` 只从合成输入生成样例，不访问真实数据库。

Debug 可用 `python3 ios/scripts/make_preview_fixtures.py /tmp/settle-reader-preview` 生成离线数据，再传入 `--preview-fixtures /tmp/settle-reader-preview`；支持 `--preview-tab 0...4`、`--preview-dark` 和 `--preview-large-text`。Release 移除该入口。

[查看现有 iOS 界面截图](../docs/screenshots/ios-overview-catalyst.png)：这是 SwiftUI 的 Mac Catalyst 预览窗口，使用合成数据，**不是 iPhone 真机截图**。编译或本机预览通过也不等于你的设备已安装 / 签名成功。

## Apple 免费账号与付费会员

个人使用可先选择普通 Apple 账号：在 Xcode 登录后显示为 Personal Team，无须先购买开发者会员。按 [Apple 官方账户说明](https://developer.apple.com/help/account/basics/about-your-developer-account)，免费配置描述文件通常在签发 7 天后到期，个人设备测试还存在 App ID、设备和同时安装 App 数量限制，需要按期重新签名 / 安装。

Apple Developer Program 是付费开发者计划，提供证书、分发及 App Store Connect 等能力；会员费用、地区要求与权益以[官方加入说明](https://developer.apple.com/programs/enroll/)为准。付费会员不等于这个 unsigned IPA 已获签名或可以随意分发，仍需按自己的签名与分发方式处理。本项目目前没有 App Store / TestFlight 下载入口。

首次真机运行按提示信任电脑，并依 [Apple 开发者模式文档](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device)完成设置。不要向项目作者提供 Apple 密码、双重认证验证码、证书私钥或设备授权文件。

现成 IPA 和 SHA-256 位于 [v0.16.0 Release](https://github.com/su4g/game-asset-settle/releases/tag/v0.16.0)，手机版本为 1.2.0（构建 4）。
