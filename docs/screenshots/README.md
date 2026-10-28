# 截图说明

README 首屏和 iPhone 展示使用 `website/src/assets/` 中的真实运行截图，金额经作者授权公开，画面仅显示通用账户组名。见[官网截图说明](../../website/README.md#软件截图)与[来源清单](../../website/asset-sources.json)。这些图片也逐张检查了平台身份、凭据和服务器信息。

## 隔离验收与预览截图

这些 PNG 来自 2026-10-28 新版应用已有的界面验收，不是 Figma 概念图，也没有重新生成 / 修改业务金额。当前选用的画面本身使用隔离数据库或合成数据，因此无需对真实交易金额打码。

| 文件 | 内容与来源 |
| --- | --- |
| [macos-overview.png](macos-overview.png) | macOS 0.16.0 总览，Electron 隔离 smoke |
| [macos-accounts.png](macos-accounts.png) | 账户与同步，显示合成 Steam 账号 |
| [macos-report.png](macos-report.png) | 收益报告，验收订单与金额 |
| [macos-alchemy.png](macos-alchemy.png) | 已完成炼金，合成库存事件 |
| [ios-overview-catalyst.png](ios-overview-catalyst.png) | iOS 1.2.0 的 SwiftUI Mac Catalyst 预览，离线样例 |

iOS 画面来自 Mac Catalyst 预览窗口，保留原始截图，不作为 iPhone 真机验收证据。截图没有包含登录二维码、密码、Token、API Key、云端地址、连接文件内容或服务器后台。

每张文件的 SHA-256 见 [manifest.json](manifest.json)，用于追踪本次选定素材。发布时检查了可见内容及 PNG 元数据；后续替换截图需要重新检查。
