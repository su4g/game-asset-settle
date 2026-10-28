# 第三方依赖、素材与来源

## 许可证范围

本项目原创程序代码和文档按根目录 [MIT License](LICENSE) 提供。MIT 原文参见 [Open Source Initiative](https://opensource.org/license/mit)。依赖、平台商标、游戏内容及可能包含第三方视觉元素的图标 / 截图不因本项目许可而改变各自权利，不能将整份安装包中的全部内容视作作者独占的 MIT 素材。

## 直接依赖

版本由 `package-lock.json` 锁定，以安装包内各组件的 LICENSE 为准。分发应用和依赖时须保留其版权、许可证及第三方声明。

| 依赖 | 用途 | 上游许可 / 来源 |
| --- | --- | --- |
| Electron | macOS 应用容器 | MIT；包含 Chromium、Node.js 等额外许可，[electron/electron](https://github.com/electron/electron) |
| @electron/packager | 本机打包工具 | BSD-2-Clause，[electron/packager](https://github.com/electron/packager) |
| pg / node-postgres | 本机及云端 PostgreSQL 驱动 | MIT，[brianc/node-postgres](https://github.com/brianc/node-postgres) |
| parse5 | 解析 Steam 历史 HTML | MIT，[inikulin/parse5](https://github.com/inikulin/parse5) |
| jsdom | 离线界面测试 | MIT，[jsdom/jsdom](https://github.com/jsdom/jsdom) |

Xcode、Swift、SwiftUI、PostgreSQL、Docker、Nginx、Homebrew、Sideloadly 为开发 / 运行 / 安装工具或平台，遵循其各自协议；没有将其完整源码重新许可为 MIT。Swift 客户端没有额外 Swift 包依赖。云发布包复制生产依赖及其原有许可证；Electron 自带的 `LICENSE` / 第三方声明应随 macOS 包保留。

## 接口调研来源

桌面 BUFF / 悠悠适配器的文件头保留了接口调研来源：

- [Steamauto / Steamauto](https://github.com/Steamauto/Steamauto)，AGPL-3.0；参考提交 `c759311b452b575dd4d1d827377a384762218a73`。
- [BUFF 查询接口参考](https://github.com/Steamauto/Steamauto/blob/c759311b452b575dd4d1d827377a384762218a73/BuffApi/__init__.py)。
- [悠悠查询接口参考](https://github.com/Steamauto/Steamauto/blob/c759311b452b575dd4d1d827377a384762218a73/uuyoupinapi/__init__.py)。

这些是接口行为与社区实践的参考，适配器为现有项目的独立 JS 实现。本次源码提取没有复制上述仓库的 Python 模块，也没有分发其自动收发货实现；引用不改变上游许可证。后续贡献若引入上游代码，必须先核对许可兼容性、保留来源并遵守相应义务，不能以本仓库 MIT 声明替代上游要求。

## 平台标识、游戏形象与截图

- BUFF、悠悠有品、Steam 平台图形来自各平台公开 favicon，只用于标识交易来源，非官方背书。
- 原始来源、取得日期和哈希记录在 [`desktop/assets/platforms/sources.json`](desktop/assets/platforms/sources.json)；iOS 与官网复用相同图形。
- 品牌图形使用生成式工具制作，视觉参考 AWP 永恒之枪与 Dota 2 破碎大剑，记录在 [`desktop/assets/brand/sources.json`](desktop/assets/brand/sources.json)。它们涉及的游戏名称、饰品形象及相关权利仍归各权利人；本项目不保证授予第三方商业品牌使用权。
- 文档截图为现有应用的真实运行画面，当前采用隔离验收 / 合成数据；完整来源说明见 [`docs/screenshots/README.md`](docs/screenshots/README.md)。交易平台登录二维码、访问码和服务器配置不作为展示素材。

如权利人认为项目中的代码或素材侵犯权益，请通过 [Issues](https://github.com/su4g/game-asset-settle/issues) 或 [suag725@163.com](mailto:suag725@163.com) 提供具体位置与权属说明，作者核实后会及时删除或调整。请勿在公开反馈中附带私人凭据。
