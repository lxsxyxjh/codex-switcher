# Codex Switcher — Windows Edition

A small Windows app for checking Codex quota and Credits, with a desktop floating bar. The app interface is in Chinese.

English | [简体中文](README.zh-CN.md)

## Original project

Based on [Codex Switcher](https://github.com/Lampese/codex-switcher), created by [Lampese](https://github.com/Lampese) and its contributors. Account management, login, Codex switching, usage requests, and the Tauri foundation come from the original project. This fork adds the Windows features below and keeps the original author attribution and license.

## Features in this fork

- A compact, draggable, always-on-top quota bar with Credits.
- Horizontal or vertical layout, edge hiding, 50%–200% scaling, and used/remaining percentages.
- Hover to see when each quota period resets. Actual periods are shown: 5h, 7d, or 30d, depending on the account. Missing periods are omitted; zero remains visible.
- Choose the account displayed in the bar without changing the Codex login.
- Add accounts through a Codex login file, ChatGPT login, or a Cookie input box.
- Shared quota updates every 5 minutes by default. Choose 30 seconds, 1, 2, 5, or 10 minutes in Settings or the floating bar / tray context menu. This changes how often data is fetched, not when Codex resets quota.
- Manual refresh synchronizes the main window, floating bar, and tray. Failed requests keep the last successful values.
- Closing the main window keeps the app running; tray Quit exits it completely. Floating preferences are saved across restarts.

## Use the app

1. Download `codex-switcher.exe` from [this repository's Releases](../../releases), place it in a permanent folder, and open it.
2. Select **账户 → 添加账户** to add an account.
3. Enable **悬浮额度窗** in Settings or the tray context menu.
4. Right-click the floating bar to adjust it. Its refresh button fetches the latest quota.

Windows x64 and [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) are required. You can create a desktop shortcut to the exe.

| Account method | Supported actions |
| --- | --- |
| Codex `auth.json` | Check quota, switch Codex login, warm up |
| ChatGPT browser login | Check quota, switch Codex login, warm up |
| ChatGPT Cookie | Check quota only |

The file picker starts at `%USERPROFILE%\.codex\auth.json`, or `auth.json` under `CODEX_HOME` if configured. Cookie and Codex login records for the same account are kept separately; reimporting through the same method updates that record.

**Refresh quota** fetches usage data. **Warm up** sends a small Codex request and can consume quota; it is optional and unavailable for Cookie accounts.

The **余额** value is the existing ChatGPT/Codex Usage Credits balance, not reset credits, token counts, or API billing. Use **账户 → 导出 / 导入** for account backups.

## Build and publish

Prerequisites: Node.js 22.12 or newer, pnpm, Rust, and Visual Studio C++ Build Tools with **Desktop development with C++**.

Open PowerShell in the repository:

```powershell
pnpm install --frozen-lockfile
pnpm tauri:win:exe
```

The existing script, `scripts/build-windows.ps1`, loads the Visual Studio build environment and builds TypeScript, Rust, and the Windows Release exe. It reuses the build cache and does not create installers or updater signatures. No `TAURI_SIGNING_PRIVATE_KEY` is needed.

Output:

```text
src-tauri/target/exe-only/release/codex-switcher.exe
```

To publish:

1. If changing the version, run `pnpm version:patch` before building and review the resulting version changes.
2. Build, then open the generated exe and check login, quota, and the floating bar.
3. Create a GitHub Release in your own repository and upload `codex-switcher.exe`. Users do not need the source folder or build cache.
4. Retain the original author attribution and license. Do not upload local account files or credentials.

The inherited updater still targets Lampese's releases. Distribute this fork through manual exe downloads unless you configure your own update endpoint and signing keys. The inherited release automation is not the exe-only publishing workflow above.

Development: `pnpm tauri:win dev`. These changes target Windows; macOS and Linux have not been validated for this fork.
