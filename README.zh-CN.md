# Codex Switcher — Windows 增强版

一个查看 Codex 额度和 Credits 余额的 Windows 工具，支持常驻桌面的悬浮窗。程序界面使用中文。

[English](README.md) | 简体中文

## 项目来源

修改自 [Lampese](https://github.com/Lampese) 及其贡献者开发的 [Codex Switcher](https://github.com/Lampese/codex-switcher)。账户管理、登录、Codex 切换、额度请求和 Tauri 基础来自原项目。本版本增加下面的 Windows 功能，保留原作者署名和许可证。

## 本版本的功能

- 小型、可拖动、置顶的额度悬浮窗，显示 Credits 余额。
- 横排、竖排、贴边隐藏、50%–200% 缩放、已用／剩余百分比。
- 鼠标悬浮时显示各周期的额度重置时间。根据账户实际数据显示 5h、7d、30d；没有的周期不显示，额度为 0 时正常显示。
- 可选择悬浮窗展示的账户，不改变 Codex 的实际登录。
- 支持导入 Codex 登录文件、ChatGPT 登录和 Cookie 输入框。
- 默认每 5 分钟获取最新额度，设置、悬浮窗右键、托盘右键可选 30 秒、1、2、5、10 分钟。这是获取数据的间隔，不是 Codex 重置额度的周期。
- 手动更新后，主界面、悬浮窗和托盘同步显示；网络失败保留上次成功数据。
- 关闭主界面后留在托盘；托盘右键“退出程序”才彻底退出。重启后恢复悬浮窗设置。

## 使用方法

1. 从[本仓库的 Releases](../../releases)下载 `codex-switcher.exe`，放到长期保留的文件夹，双击运行。
2. 点击 **账户 → 添加账户**。
3. 在设置或托盘右键菜单开启 **悬浮额度窗**。
4. 右键悬浮窗调整显示方式，点击悬浮窗刷新按钮获取最新额度。

需要 Windows x64 和 [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。可以自行为 exe 创建桌面快捷方式。

| 添加方式 | 支持的操作 |
| --- | --- |
| Codex `auth.json` 文件 | 查看额度、切换 Codex 登录、预热 |
| ChatGPT 浏览器登录 | 查看额度、切换 Codex 登录、预热 |
| ChatGPT Cookie | 查看额度 |

文件选择器默认定位到 `%USERPROFILE%\.codex\auth.json`；设置了 `CODEX_HOME` 时使用该目录下的 `auth.json`。同一个账户通过 Cookie 和 Codex 登录添加时分别保存；同一种方式重复导入会更新已有记录。

**刷新额度**只是获取使用情况。**预热账户**会发送一个小型 Codex 请求，可能消耗额度；这是可选功能，Cookie 账户不支持。

**余额**使用现有 ChatGPT/Codex Usage Credits 数据，不是重置次数、Token 数或 API 账单。账户备份使用 **账户 → 导出／导入**。

## 打包和发布

准备 Node.js 22.12 或更新版本、pnpm、Rust，以及包含 **使用 C++ 的桌面开发**工作负载的 Visual Studio C++ Build Tools。

在项目目录打开 PowerShell：

```powershell
pnpm install --frozen-lockfile
pnpm tauri:win:exe
```

已有打包脚本 `scripts/build-windows.ps1`，会加载 Visual Studio 编译环境，编译 TypeScript、Rust 和 Windows Release exe，并复用编译缓存。只生成 exe，不生成安装包或更新签名，不需要 `TAURI_SIGNING_PRIVATE_KEY`。

生成位置：

```text
src-tauri/target/exe-only/release/codex-switcher.exe
```

发版步骤：

1. 需要调整版本号时，先执行 `pnpm version:patch`，检查版本文件变化，再编译。
2. 打开生成的 exe，确认登录、额度显示和悬浮窗正常。
3. 在自己的 GitHub 仓库创建 Release，上传 `codex-switcher.exe`。用户无需下载源码或编译缓存。
4. 保留原作者署名和许可证，不上传本地账户配置或凭证。

继承的更新器仍指向 Lampese 原项目。当前建议通过 Release 手动下载 exe 更新；要提供本分支的自动更新，需要配置自己的更新地址和签名密钥。原有发布自动化不属于上述只打包 exe 的流程。

开发调试使用 `pnpm tauri:win dev`。本版本面向 Windows，未验证本分支的 macOS 和 Linux 构建。
