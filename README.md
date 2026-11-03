# 心有灵犀 / WordTune

双人同频猜词微信小游戏。设计已于 2026-11-03 确认，当前正在完成第三阶段后端；已有本地云函数源码和自动化测试，尚未部署，尚无可玩的游戏界面。

## 打开项目

使用微信开发者工具导入 D:\WordTune，选择小游戏项目，使用 AppID `wx31782b9e04ef9186`。

云环境 ID 为 `wordtune-d4gl8hb7gf0d380b7`，已写入 game.js。无需在前端配置 AppSecret 或云平台密钥。

## 当前验证结果

已从小游戏实际调用云函数 checkEnvironment；其默认示例返回的 userInfo 包含 OpenID，AppID 校验一致。详见 [环境检查报告](docs/环境检查报告.md)。

game.js 当前仅初始化云开发，未绘制界面，因此模拟器黑屏不代表已实现游戏。

## 后续配置与测试

- 云函数：checkEnvironment 已在云端；新业务源码位于 cloudfunctions/gameApi，使用固定版本 wx-server-sdk 4.0.2。部署步骤见 [云函数部署](docs/云函数部署.md)。
- 数据库：本次实际查看仍无可用集合，须按 [数据库设计](docs/数据库设计.md) 和 [配置清单](docs/数据库配置.json) 创建集合、保存权限并建立索引。
- 双人测试：须使用两个不同微信身份；目前尚未执行。
- 常见问题：云函数调用失败时查看开发者工具调试器中的 Console，记录 errCode、errMsg；不要分享密码、验证码、AppSecret 或完整 OpenID。

## 协作约定

已获用户确认复用现有小游戏项目；核心规则保持原要求。完整设计经用户确认后再正式开发。提交审核、正式发布、付费资源和破坏性操作须经用户明确许可。

Git 用于本地版本恢复，不要求上传远程仓库。project.private.config.json、依赖目录和环境变量文件不纳入版本管理。

## 本地验证

在项目根目录运行 `npm test` 验证隔离的业务状态机、并发重试和恢复行为，运行 `npm run check` 检查 JavaScript 语法与 JSON 配置。测试无需云端凭证，也不会读写真实房间。

部署前如需重新安装函数依赖，在 cloudfunctions/gameApi 中运行 `npm ci --ignore-scripts`；开发者工具上传时可选择云端安装依赖。根目录测试仅使用 Node.js 内置工具。

详见 [测试报告](docs/测试报告.md)。本地测试不替代真实云端事务和双人测试。云端验证通过后再开发浅蓝色、可爱、无动态背景的 Canvas 游戏界面。
