# Codex Switcher — Windows Codex 额度查询与 Credits 余额悬浮窗

**在桌面直接查看 Codex 剩余额度、Credits 余额和额度重置时间。** 支持多账户、Codex 登录文件、ChatGPT 登录和 Cookie 输入框，不用反复打开网页查看用量。

Windows Codex usage monitor / quota monitor：查看 5 小时、7 天和 30 天限额，在桌面悬浮窗和系统托盘同步显示。

[English](README.md) | 简体中文 | [下载 Windows exe](../../releases)

## 能查看什么？

| 功能 | 显示内容 |
| --- | --- |
| Codex 剩余额度 | 账户实际返回的 5 小时、7 天／每周、30 天额度，支持剩余或已用百分比 |
| Credits 余额 | ChatGPT/Codex Usage 的剩余 Credits，支持 0、小数和千位分隔 |
| 额度重置时间 | 鼠标悬浮显示各周期的重置日期、当地时间和大约多久后重置 |
| Codex 多账户额度 | 主界面查看多个账户，可选择悬浮窗显示哪一个账户 |
| 桌面悬浮窗与系统托盘 | 可拖动、置顶的额度条，托盘提示同步显示相同数据 |

只显示账户实际返回的额度周期。没有的周期不显示，用完的额度正常显示 **0%**。Credits 余额不是手动重置次数、Token 数或 API 账单。

## 为什么使用这个额度监控工具？

- 编程时就能看到 Codex 还剩多少额度，不用反复打开 Usage 页面。
- 悬浮窗支持横排、竖排、贴边隐藏和 50%–200% 缩放。
- 可以粘贴 Cookie 查看额度，也可以继续使用已有的 Codex 登录。
- 切换悬浮窗展示的账户，不会改变 Codex 的实际登录。
- 默认每 5 分钟获取最新用量；设置、悬浮窗右键和托盘右键可选 30 秒、1、2、5、10 分钟。
- 悬浮窗按钮可立即刷新，主界面、悬浮窗和托盘同步更新；网络失败保留上次成功值。
- 重启后恢复悬浮窗位置和设置，关闭主界面后继续留在托盘。

## 下载和使用

1. 从 [Releases](../../releases) 下载 `codex-switcher.exe`，放到长期保留的文件夹，双击运行。
2. 点击 **账户 → 添加账户**。
3. 在设置或托盘右键菜单开启 **悬浮额度窗**。
4. 将悬浮窗拖到合适的位置，右键选择账户、排列方式、缩放比例和更新间隔。

需要 Windows x64 和 [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。程序界面目前使用中文。

## 添加账户的方式

| 方式 | 查看额度和 Credits | 切换 Codex 登录／预热 |
| --- | --- | --- |
| 导入 Codex `auth.json` | 支持，以账户返回的数据为准 | 支持 |
| ChatGPT 浏览器登录 | 支持，以账户返回的数据为准 | 支持 |
| 粘贴 ChatGPT Cookie | 支持，以账户返回的数据为准 | 不支持，仅查看额度 |

文件选择框默认定位到 `%USERPROFILE%\.codex\auth.json`；配置了 `CODEX_HOME` 时使用该目录。可以为多个 Cookie 账户分别输入凭证。同一个账户通过 Cookie 和 Codex 登录添加时分别保存；同一种方式重复添加会更新已有记录。

账户备份使用 **账户 → 导出／导入**。左键点击托盘图标打开主界面，托盘右键 **退出程序** 才会彻底退出。

## 常见问题

### Codex 剩余额度怎么看？

添加账户后，在主界面或桌面悬浮窗查看剩余百分比。支持账户实际返回的 5 小时、每周和 30 天限额；不同套餐或账户返回的周期可能不同。

### Codex 5 小时、7 天额度什么时候恢复？

鼠标停在悬浮窗上，可以看到各额度周期的重置时间。设置中的更新间隔只是多久获取一次最新数据，不会改变 OpenAI 的额度重置周期。

### 可以用 Cookie 查询 Codex 额度和 Credits 余额吗？

可以。添加账户时选择 Cookie，将 ChatGPT Cookie 粘贴到输入框。Cookie 账户用于查看额度和余额，不会切换 Codex CLI 登录，也不发送预热请求。

### 刷新额度会消耗 Codex 额度吗？

刷新只是获取用量数据，不会发送 Codex 生成请求。**预热账户**是另一个可选功能，会发送小型 Codex 请求，可能消耗额度。

## 打包 Windows exe

准备 Node.js 22.12 或更新版本、pnpm、Rust，以及包含 **使用 C++ 的桌面开发**工作负载的 Visual Studio C++ Build Tools。在项目目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm tauri:win:exe
```

已有脚本 `scripts/build-windows.ps1`，会编译前端和 Windows Release exe：

```text
src-tauri/target/exe-only/release/codex-switcher.exe
```

不需要安装包或 updater 签名密钥。发版时可先用 `pnpm version:patch` 调整版本，编译并检查 exe，再上传到自己的 GitHub Release。继承的更新器仍指向原作者仓库；未配置自己的更新服务前，通过手动下载 exe 更新。开发调试：`pnpm tauri:win dev`。

## 原项目和本版本范围

基于 [Lampese](https://github.com/Lampese) 及其贡献者开发的 [Codex Switcher](https://github.com/Lampese/codex-switcher)。账户管理、登录、Codex 切换、额度请求和 Tauri 基础来自原项目。本分支增加 Windows 桌面额度悬浮窗、Cookie 账户输入、Credits 同步显示和简化操作。

这是社区项目，并非 OpenAI 官方应用。本版本面向 Windows，未验证本分支的 macOS 和 Linux 构建。
