import { useEffect, useState } from "react";
import type { AccountInfo, UsageInfo } from "./types";
import type { FloatingOptions } from "./FloatingUsage";
import { invokeBackend, isTauriRuntime } from "./lib/platform";
import { getViewedAccount, formatCreditsBalance, formatUsagePercent, getDisplayedUsageWindows, mergeUsageUpdate } from "./lib/usageDisplay";
import { applyTheme, syncThemeFromStorage, THEME_CHANGED_EVENT, type ThemeMode } from "./lib/theme";

export default function TrayMenu() {
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [options, setOptions] = useState<FloatingOptions | null>(null);
  const [usages, setUsages] = useState<Record<string, UsageInfo>>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let stops: Array<() => void> = [];
    const load = async () => {
      const [list, settings, cached] = await Promise.all([
        invokeBackend<AccountInfo[]>("list_accounts"),
        invokeBackend<FloatingOptions>("get_floating_usage_options"),
        invokeBackend<UsageInfo[]>("get_cached_usage"),
      ]);
      if (disposed) return;
      setAccounts(list);
      setOptions(settings);
      setUsages((previous) => Object.fromEntries(cached.map((usage) => [usage.account_id, mergeUsageUpdate(previous[usage.account_id], usage)])));
    };
    syncThemeFromStorage();
    void (async () => {
      if (isTauriRuntime()) {
        const { listen } = await import("@tauri-apps/api/event");
        stops = await Promise.all([...["accounts-changed", "app-settings-changed", "usage-updated", "tray-refresh"].map((event) => listen(event, () => { void load().catch((error) => setError(String(error))); })), listen<ThemeMode>(THEME_CHANGED_EVENT, ({ payload }) => applyTheme(payload))]);
      }
      if (disposed) { stops.forEach((stop) => stop()); return; }
      await load();
    })().catch((error) => { if (!disposed) setError(String(error)); });
    return () => { disposed = true; stops.forEach((stop) => stop()); };
  }, []);
  const selected = getViewedAccount(accounts, options?.floating_usage_account_id);
  const select = async (accountId: string) => {
    try { setOptions(await invokeBackend<FloatingOptions>("set_floating_usage_options", { accountId })); }
    catch (error) { setError(String(error)); }
  };
  return <div className="grid h-screen grid-rows-[auto_1fr_auto] bg-white p-3 text-gray-900 dark:bg-gray-900 dark:text-gray-100">
    <h1 className="mb-3 font-semibold">Codex Switcher · 查看额度账户</h1>
    <div className="grid content-start gap-2 overflow-auto">
      {error && <p className="text-xs text-red-500">{error}</p>}
      {accounts.map((account) => <button key={account.id} onClick={() => { void select(account.id); }} className={`rounded-lg p-3 text-left text-sm ${selected?.id === account.id ? "bg-sky-50 dark:bg-sky-900/30" : "bg-gray-50 dark:bg-gray-800"}`}>
        <span className="block truncate">{selected?.id === account.id ? "✓ " : ""}{account.name}</span>
        <span className="block text-xs text-gray-500">{getDisplayedUsageWindows(usages[account.id]).map((window) => `${window.label} ${formatUsagePercent(window.used)}`).join(" · ")}</span>
        <span className="block text-xs text-gray-500">余额：{formatCreditsBalance(usages[account.id]?.credits_balance)}</span>
      </button>)}
    </div>
    <div className="mt-3 grid grid-cols-2 gap-3 text-sm text-gray-500">
      <button onClick={() => { void invokeBackend("open_main_window"); }}>打开主界面</button>
      <button onClick={() => { void invokeBackend("quit_app"); }}>退出程序</button>
    </div>
  </div>;
}
