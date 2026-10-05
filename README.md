# Codex Switcher — Codex Usage & Credits Monitor for Windows

**Check your remaining Codex quota, Credits balance, and quota reset times in a small Windows desktop floating widget.** Supports multiple accounts, Codex `auth.json`, ChatGPT login, and Cookie input.

Codex 额度查询与桌面悬浮窗：查看剩余额度、Credits 余额，以及 5 小时、7 天、30 天额度重置时间，支持多账户和 Cookie 登录。

English | [简体中文](README.zh-CN.md) | [Download Windows exe](https://github.com/lxsxyxjh/codex-switcher/releases)

## What can you monitor?

| Feature | What you see |
| --- | --- |
| Codex remaining quota | Remaining or used percentages for the account's actual 5-hour, 7-day / weekly, or 30-day quota windows |
| Codex Credits balance | The remaining ChatGPT/Codex Usage credit balance, including zero and fractional values |
| Quota reset time | Hover over the floating widget to see each window's reset date, local time, and approximate countdown |
| Multiple Codex accounts | View several accounts in the main window and choose which account appears in the floating widget |
| Desktop widget and system tray | An always-on-top, draggable quota overlay and a tray tooltip with the same usage data |

Only quota periods returned for the account are shown. Missing periods are omitted; an exhausted quota displays **0%**. Credits show the remaining Codex usage balance, separate from token counts and API billing.

## Why use this Windows quota monitor?

- Keep Codex usage limits visible while coding, without repeatedly opening the usage page.
- Use a compact horizontal bar or vertical layout, with edge hiding and 50%–200% scaling.
- Check quota through a Cookie input box, or keep using your existing Codex login.
- Choose the displayed account without changing the account signed into Codex.
- Only the account shown in the enabled floating widget refreshes automatically. Its default interval is 5 minutes; choose 30 seconds, 1, 2, 5, or 10 minutes on its account card or in the widget context menu. Other accounts refresh manually. Closing the widget pauses automatic usage refresh.
- Refresh manually from the widget. The main window, floating widget, and tray share the same quota updates; failed requests retain the last successful values.
- Restore the widget's position and preferences after restarting. Closing the main window keeps the app in the tray.

## Download and start

1. Download `codex-switcher.exe` from [Releases](https://github.com/lxsxyxjh/codex-switcher/releases), place it in a permanent folder, and open it.
2. Select **添加账户** (Add account).
3. Enable **悬浮额度窗** (Floating quota widget) in Settings or the tray context menu.
4. Drag the widget to your preferred location. Right-click it for account, layout, scaling, and refresh settings.

Requires Windows x64 and [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/). The app interface is currently in Chinese.

## Account methods

| Method | Quota and Credits |
| --- | --- |
| Import Codex `auth.json` | Yes, when returned for the account |
| ChatGPT browser login | Yes, when returned for the account |
| Paste ChatGPT Cookie | Yes, when returned for the account |

This app only monitors usage. It does not switch Codex logins, write Codex login files, or send warm-up requests.

The file picker starts at `%USERPROFILE%\.codex\auth.json`, or under `CODEX_HOME` if configured. Each Cookie account can have its own credentials. Cookie and Codex login records for the same account remain separate; adding the same account through the same method updates its existing record.

Use **导出 / 导入** to back up or restore accounts. Left-click the tray icon to reopen the main window; **退出程序** (Quit) in the tray context menu exits the whole app.

## Common questions

### How do I check how much Codex quota is left?

Add an account and read its remaining percentages in the main window or floating widget. The widget supports 5-hour, weekly, and 30-day limits when those windows are returned for your account. Displayed windows depend on the account's plan and usage response.

### When does my Codex 5-hour or weekly quota reset?

Hover over the floating widget to see the reset time for each displayed quota period. The automatic refresh interval only controls fetching new usage data; it does not change OpenAI's quota reset schedule.

### Can I check Codex Credits using a Cookie?

Yes. Paste the ChatGPT Cookie into the Cookie input box when adding an account. Cookie accounts can display quota and Credits without changing the Codex login. They cannot switch the CLI login or send warm-up requests.

### Does refreshing consume quota?

Refreshing only fetches usage data; it does not send a Codex generation request.

## Build a Windows exe

Install Node.js 22.12 or newer, pnpm, Rust, and Visual Studio C++ Build Tools with **Desktop development with C++**. In the repository folder:

```powershell
pnpm install --frozen-lockfile
pnpm tauri:win:exe
```

The script `scripts/build-windows.ps1` builds the frontend and Windows Release executable:

```text
src-tauri/target/exe-only/release/codex-switcher.exe
```

No installer or updater signing key is required. To publish, optionally bump the version with `pnpm version:patch` before building, check the exe, and upload it to your own GitHub Release. The inherited updater still targets the original repository; use manual exe downloads unless you configure your own update service. Development: `pnpm tauri:win dev`.

GitHub Actions can also build the exe: push a version tag matching `package.json` (for example `v0.2.21`), or run **Windows EXE Release** with an existing tag. It builds Windows only and uploads the exe to a Release draft. Review the draft and click **Publish release**. Existing exe attachments are preserved. No signing secrets are needed.

## Version 0.2.21

- Simplified quota-only interface; removed login switching, warm-up, usage statistics and reset-count controls.
- One selected account across the main window, floating widget and tray.
- Automatic refresh only for the account displayed in the enabled widget; other accounts refresh manually. Requests are serialized and failures preserve cached values.
- Fixed window controls and toolbar stay visible while the account list scrolls.

## Original project and scope

Based on [Codex Switcher](https://github.com/Lampese/codex-switcher), created by [Lampese](https://github.com/Lampese) and its contributors. Account storage, login, usage requests, and the Tauri foundation come from the original project. This fork focuses on quota monitoring, adds the Windows floating quota widget, Cookie input and synchronized Credits display, and removes login switching, warm-up and process controls.

This is a community project, not an official OpenAI application. These changes target Windows; this fork's macOS and Linux builds have not been validated.
