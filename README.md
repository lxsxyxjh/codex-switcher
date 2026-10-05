<p align="center">
  <img src="src-tauri/icons/logo.svg" alt="Codex Switcher" width="96">
</p>

# Codex Switcher — Windows Edition

A small desktop app for checking your Codex quota and remaining Credits, with an optional floating bar that stays visible while you work.

**English** | [简体中文](README.zh-CN.md)

## Based on the original Codex Switcher

This is a modified version of [Codex Switcher](https://github.com/Lampese/codex-switcher), originally created by **[Lampese](https://github.com/Lampese)** and its contributors.

The original project provides account management, ChatGPT login, Codex account switching, usage requests, and the Tauri application foundation. This fork builds on that work and focuses on a simpler Windows experience for checking quota. Credit for the original project belongs to its author and contributors.

This fork focuses on **Windows x64**. Its Windows interface is currently in Chinese; this English README explains how to use it. The new floating bar and Cookie account features are Windows only.

## What this version adds

- **Floating quota bar:** see 5-hour quota, weekly quota, and Credits without opening the main window.
- **Simple controls:** drag the bar anywhere; right-click to choose an account, change its size, switch between used and remaining percentages, open the main window, or hide the bar.
- **Layout and edge hiding:** choose a horizontal bar or vertical label/value rows. Enable edge hiding, drag to a screen edge, and hover over the small tab to expand it. Drag away from the edge to undock.
- **Remembered settings:** the bar restores its position, visibility, size, and display preferences after restarting.
- **Cookie accounts:** add a browser Cookie to check quota alongside accounts added through a Codex login file or ChatGPT login.
- **Shared refresh:** quota refreshes on startup and every **5 minutes** by default. Choose 30 seconds, 1, 2, 5, or 10 minutes, or turn automatic refresh off, in Settings or the floating window / tray context menu. Your choice is saved. Manual refresh updates all displays immediately. A failed refresh keeps the previous successful values.
- **Simpler account setup:** login file first, ChatGPT login second, Cookie third. Account names are identified automatically; the account menu has just Import and Export file actions.
- **Stay in the tray:** closing the main window keeps the app running. Launching it again reopens the existing window instead of starting a second copy.
- **Small Windows executable:** build an exe without creating installers or updater signatures.

The original account switching and warm-up features are retained for Codex login accounts.

## Get started

1. Download `codex-switcher.exe` from **[this repository's Releases page](../../releases)**.
2. Put it in a folder you want to keep and double-click it. You can create a desktop shortcut if you like.
3. Open **账户 → 添加账户** (Account → Add account) and choose one of the methods below.
4. Click the refresh button to update quota whenever you need to.

Windows needs the Microsoft Edge WebView2 Runtime to display the app. If it is missing, install it from [Microsoft](https://developer.microsoft.com/microsoft-edge/webview2/).

### Choose an account method

| Method | What you need | What it can do |
| --- | --- | --- |
| Login file | Your existing Codex `auth.json` | Check quota, switch the Codex login, and warm up the account |
| ChatGPT login | Sign in through the browser | Check quota, switch the Codex login, and warm up the account |
| Cookie | Paste your ChatGPT browser Cookie into the input box | Check quota; it does not switch the Codex login or send warm-up requests |

The file picker opens at the usual Codex login file: `%USERPROFILE%\.codex\auth.json`. If you use `CODEX_HOME`, it opens at that folder's `auth.json` instead.

Adding the same account through Cookie and a Codex login creates separate records, with the login method shown on the account card. Adding it again through the same method updates its credentials while keeping its existing record.

## Use the floating bar

Right-click the tray icon near the Windows clock and enable **悬浮额度窗** (Floating quota bar). You can also enable it in **菜单 → 设置** (Menu → Settings).

The bar shows three items:

```text
5h 86% | 7d 72% | Credits 1,011
```

- **5h / 7d:** remaining percentages by default. Right-click to select used percentages instead.
- **Credits / 余额:** the existing ChatGPT/Codex Usage credit balance. This is separate from manual reset credits, token counts, or API billing.
- **`--`:** the corresponding value is unavailable. A monthly quota is not relabeled as a 5-hour or weekly quota; see the main window for other quota periods.

The bar stays on top, uses a compact gray-blue style, and supports **50%–200%** scaling. Choosing a display account changes what the bar shows; it does not change the account signed into Codex.

## Close or quit

- **Main window ×:** hide the main window and keep the tray, floating bar, and refresh running.
- **Left-click the tray icon:** reopen the main window.
- **Hover over the tray icon:** see quota and Credits in its tooltip.
- **Tray right-click → 退出程序 (Quit):** exit the entire app, including the floating bar.

The tray tooltip updates with the same quota data. This version does not add a permanent text panel inside the Windows taskbar.

## Import and export

Use **账户 → 导出** (Account → Export) to save an account backup file, or **账户 → 导入** (Account → Import) to restore one. Existing accounts are kept; duplicate records are skipped.

Local Cookie storage uses the current Windows user's protection. Importing a backup saves the restored credentials under the Windows user running the app.

## Build from source

These steps are for developers. To use the app, download the exe instead.

Install Node.js **22.12 or newer**, pnpm, Rust, and Visual Studio C++ Build Tools with the **Desktop development with C++** workload. Download or clone **this repository**, then open PowerShell in its folder:

```powershell
pnpm install
pnpm tauri:win:exe
```

Output:

```text
src-tauri/target/exe-only/release/codex-switcher.exe
```

The build script loads the installed Visual Studio build environment and reuses its build cache. The exe-only build does not require `TAURI_SIGNING_PRIVATE_KEY`.

For development, use `pnpm tauri:win dev`. Other platform code is inherited from upstream; these Windows changes do not establish that macOS or Linux builds have been tested.

### Publishing this fork

Upload the built exe to a release in **your own repository**. Keep the original author attribution above.

The inherited automatic updater still points to **Lampese's upstream releases**. Before distributing automatic updates for this fork, configure your own update endpoint and signing keys. Uploading the exe as a normal release download does not require updater signing.
