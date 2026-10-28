# 维护约束

本仓库包含 Electron macOS 工作台、SwiftUI iOS 查询端、本机账本、可选云服务与独立官网。平台操作仅限当前用户已授权账户的查询，不实现购买、卖出、发货或交易确认。

- UI 使用中文；金额按整数分计算。未知金额、成本与来源保持未知，不以零计盈利。
- 保持两账户隔离、真实平台身份核对、异步响应取消及旧响应拒绝。来源不按昵称、物品同名或 CSV 标签猜测。
- 平台会话只在本机独立分区，登录窗口无 Node / preload / 本机 IPC；工作台保持 contextIsolation 和 sandbox。
- 不把 Token、Cookie、数据库配置、私钥、真实服务器信息、私有连接文件或个人绝对路径写入源码、安装包、截图或日志。
- 源码示例只用 example.com / .invalid 等保留域名；连接配置写到仓库外，不能内置维护者服务器。
- 测试 / smoke 仅用合成记录和 `buff_goods_test_` 隔离数据库，不访问真实平台，不写生产交易。
- 三处交易收益共用 `desktop/profit-report.cjs`；炼金单独核算，不与原报告相加。持仓、净卖出和未提现余额不计报告利润。
- 云同步保留设备、序号、待传批次与回执；不得清空状态后另造设备覆盖已有账户。
- 修改导出的代码时只更新本仓库，不修改外部个人工作目录、服务配置或已有安装。
- `npm test`、需要时的 PostgreSQL 集成检查、`swift test --package-path ios` 及 `npm run audit:public` 为主要验证入口。
- 打包用于隔离验证时使用 `npm run desktop:package -- --no-install`，避免更改已有应用入口；安装更新行为应根据当前用户的明确任务执行。
- 分发依赖保留许可证，第三方参考与素材权利见 `THIRD_PARTY_NOTICES.md`。
