# aimarket-signin

元筑AI集市（aimarket.hncig.cn）每日自动签到工具。

- 每天定时自动签到领积分（默认 2000 分/天）
- 登录令牌是集团统一认证（企业微信扫码）签发的 8 小时 JWT，本工具会**静默自动续期**，无需每天扫码
- 签到完成后弹 Windows 通知：获得多少积分、当前余额
- 纯本地运行：PowerShell + Node.js + Chrome/Edge，无第三方 npm 依赖

> 仅适用于湖南建设投资集团统一认证登录的元筑AI集市平台。请自行确认平台规则是否允许自动化签到。

## 工作原理

```
计划任务 08:10
   │
   ▼
signin.ps1 ── 令牌还有效？──── 是 ──► 查询 /api/task-award/sign-status
   │                                     │
   │ 否                                  ├─ 未签到 → POST /api/task-award/sign
   ▼                                     └─ 已签到 → 跳过
renew-token.js（无头 Chrome）
   │  用 chrome-profile 里的企业微信 SSO 会话
   │  走 /api/auth/unified/start → IdP → 回跳拿新令牌
   ▼
新令牌写回 config.json → 签到 → Windows Toast 通知
```

- 令牌（JWT）有效期 8 小时，每次运行都会自动续
- 企业微信 SSO 会话（Cookie）有效期很长（约一年），期间无需扫码
- SSO 会话彻底失效时，计划任务会自动弹窗让你扫一次码
- **签到验证码兜底**：平台 2026-11-01 起在签到接口启用了 Cap.js 反机器人验证，
  直接调用 API 会被拒（HTTP 400 `请完成安全验证后重试`）。遇到这种情况，脚本会
  自动降级为 `sign-via-browser.js`：在专用 Chrome（无头后台）里打开真实签到页面、
  点击真实签到按钮，让网站自己的验证码跑完。**成功与否以 `/api/task-award/sign-status`
  为准**（验证码解算可能比页面上的提示文字更久，只看网页容易误判成失败）。
  无头模式给验证码 60 秒解算上限（一签成立刻结束并关掉浏览器）；只有无头确实没签成时，才会再弹一个可见 Chrome 窗口
  重试一次（与 SSO 扫码类似，跑完自动关闭）。触发兜底时会先弹一条通知告知你正在后台处理。

## 关于平台访问地址（重要）

平台正式地址已改为 **https://aimarket.hncig.cn**（无端口），但集团统一门户的认证回调地址目前仍指向 **https://aimarket.hncig.cn:4090**，管理员说后续会切换过来。官方说法是两个地址"登录态不互通"，实测更准确的描述是：

- 服务端 token **两边通用**（同一个后端，任一地址调 API 都返回 200）
- 浏览器里的 `localStorage` 按 origin 隔离，所以正式网址看起来"未登录"
- 会话 Cookie 作用域是 `.hncig.cn`，**两个地址共享**

本工具默认走 `:4090`（`config.json` 里的 `baseUrl`），并且：

- `renew-token.js` 判断"SSO 是否已回跳回本站"**只比主机名，不比端口**，所以回调地址切到无端口网址后仍能正常续期，不会误判成需要重新扫码
- 若将来平台彻底停掉 `:4090`，只需把 `config.json` 的 `baseUrl` 改成 `https://aimarket.hncig.cn` 即可，无需改代码
## 环境要求

- Windows 10 / 11
- Node.js 18+（https://nodejs.org/ ，只用内置模块，不需要 npm install）
- Chrome 或 Edge 浏览器（任意一个即可，自动探测）
- Windows PowerShell 5.1（系统自带）

## 部署步骤（新电脑）

1. 安装 Node.js 18+，确认 `node -v` 可用
2. 把本仓库 clone 或下载解压到任意固定目录，例如 `D:\tools\aimarket-signin`（**目录路径确定后不要再移动**，计划任务和浏览器配置目录都基于它）
3. 双击 `login-once.cmd`：
   - 弹出一个 Chrome 窗口，跳到企业微信扫码页
   - 用手机企业微信扫码确认
   - 窗口自动关闭，`config.json`（令牌）和 `sso-cookies.json`（SSO 会话）自动生成
4. 注册每天自动执行：
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File register-task.ps1
   ```
   - 默认每天 08:10；改时间加 `-At 09:30`
   - 若提示“拒绝访问”，改用管理员 PowerShell 再运行，或用免管理员方案 `-StartupFolder`（每次登录跑一次）
5. 验证：
   ```powershell
   Start-ScheduledTask -TaskName AimarketDailySignIn   # 立即跑一次
   Get-ScheduledTaskInfo -TaskName AimarketDailySignIn # LastTaskResult = 0 即正常
   ```

之后每天 08:10 自动签到，右下角弹通知“今日签到成功，获得 2000 积分，当前余额 …”。

## 日常使用 / 管理

| 操作 | 命令 |
|---|---|
| 手动跑一次（含通知） | 双击 `run-signin.cmd` |
| 只查状态，不签到不通知 | `powershell -NoProfile -ExecutionPolicy Bypass -File signin.ps1 -Status` |
| 不弹通知跑一次 | `... signin.ps1 -NoToast` |
| 重新扫码登录（换会话） | 双击 `login-once.cmd` |
| 删除计划任务 | `powershell -NoProfile -ExecutionPolicy Bypass -File register-task.ps1 -Remove` |

通知规则：

- 签到成功：`今日签到成功，获得 2000 积分，当前余额 … 积分`
- 当天已签：`今日已签到，已获 2000 积分，当前余额 … 积分`
- 失败：`自动签到失败…`（令牌失效时会提示重新扫码）
- `-Status` 模式不弹通知；`-NoToast` 全局关闭通知

## 迁移到新电脑

把整个目录复制过去（含 `sso-cookies.json` 和 `chrome-profile\` 可以直接复用登录态），然后：

1. 更新 `config.json` 里的 `chromePath`（如 Chrome 安装路径不同；不填则自动探测 Chrome/Edge）
2. 重新执行第 4 步注册计划任务即可

如果只复制了代码没带 `sso-cookies.json`，重新跑一次 `login-once.cmd` 扫码即可。

## 故障排查

日志在 `signin.log`：

| 日志 | 含义 | 处理 |
|---|---|---|
| `signed OK, awarded N points.` | 签到成功 | 无 |
| `already signed today` | 当天已签 | 无 |
| `token renewed, valid until …` | 令牌续期成功 | 无 |
| `session expired: … must be confirmed once` | SSO 会话失效 | 双击 `login-once.cmd` 重新扫码 |
| `renewal failed (exit 3): cdp-unreachable` | 专用 Chrome 被占用 | 关掉残留的专用 Chrome 窗口后重试 |
| `sign-status request failed: …` | 网络/服务异常 | 稍后自动重试（计划任务只跑一次，可手动 `run-signin.cmd` 补签） |
| `sign request blocked by captcha (code 40000)` | 平台验证码兜底已启动 | 正常，后台最多 60 秒；会先弹通知 |
| `browser sign: already signed today.` | 兜底时当天已被签到 | 无 |
| `sign-button-not-found` | 页面改版或登录态失效 | 双击 `login-once.cmd` 重新扫码后再跑 |
| 通知不弹 | 系统通知权限被关 | Windows 设置 → 系统 → 通知，允许 PowerShell |

## 文件结构

```
signin.ps1          签到主脚本（续期调度 + 签到 + Windows 通知）
renew-token.js      令牌静默续期（无头 Chrome + 企业微信 SSO，纯 Node 内置模块）
sign-via-browser.js 验证码兜底：在 Chrome 里点击真实签到按钮（CDP，纯 Node 内置模块）
register-task.ps1   注册/删除 Windows 计划任务（或启动文件夹方案）
login-once.cmd      一次性扫码登录入口
run-signin.cmd      手动跑一次入口
set-token.ps1       应急：手动粘贴令牌（跳过扫码，令牌 8 小时有效）
.gitignore          防止把 config.json / sso-cookies.json / 日志 / 浏览器配置提交到 git
```

运行后生成（均已被 `.gitignore` 排除，**不要分享**）：

```
config.json         当前令牌等配置（含敏感信息）
sso-cookies.json    企业微信 SSO 会话 Cookie（含敏感信息）
chrome-profile\     专用浏览器配置目录（含登录态）
signin.log          运行日志
```

## License

MIT