# 参与贡献

欢迎通过 Issue 讨论兼容性问题、核算边界和使用体验，再提交范围清晰的 Pull Request。所有界面文字使用中文，金额使用整数分；未知金额 / 成本来源保持未知，不能为显示好看补零。

提交自己的修改时，表示你有权按本项目 MIT 许可证提供该贡献。引入第三方代码或素材时说明来源、版本和许可，不能删除原有版权信息。不要复制不兼容许可的代码，也不要上传平台登录响应、原始 Cookie、生产配置或私人订单。

## 本地检查

推荐 Node.js 24、macOS、Xcode 26+；`npm ci` 安装锁定依赖。

```bash
npm test
npm run test:pg
npm run cloud:test:pg
swift test --package-path ios
npm run desktop:verify -- --development
npm run audit:public
```

前三类 Node 测试包含纯计算、模拟平台响应和隔离 PostgreSQL 集成。默认 `npm test` 跳过需数据库的用例；设置 `PG_INTEGRATION=1 CLOUD_PG_INTEGRATION=1` 可以一次运行全部。数据库管理员连接通过 `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` 配置，测试库必须带 `buff_goods_test_` 前缀，并在结束后清理。禁止把真实数据库配置传入 smoke。

Mac smoke 新建隔离数据库和独立 App 偏好，使用合成记录，关闭平台访问；它不等同于三平台实站认证通过。iOS 测试使用模拟网络与内存凭据；真实签名、安装和平台行为要分别验证。

纯文档更新检查链接和表述即可；修改平台适配器、账户隔离、成本计算或持久状态时，增加能覆盖行为边界的测试。PR 说明实际问题、最终行为、验证结果和未验证范围。

## 安全发布

```bash
npm run audit:public
gitleaks dir . --redact
gitleaks git . --redact
git diff --check
git diff --cached --stat
```

进一步审查历史、截图、二进制元数据及依赖许可。公开提交建议使用 GitHub noreply 邮箱，避免将私人邮箱写入提交元信息。切勿将凭据放进命令输出、CI artifact 或日志。
