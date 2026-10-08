import { useEffect, useState } from "react";
import { useAccounts } from "./hooks/useAccounts";
import { AccountCard, AddAccountModal, UpdateChecker, WindowResizeBorders } from "./components";
import { SettingsModal } from "./components/SettingsModal";
import { exportFullBackupFile, importFullBackupFile, invokeBackend, isTauriRuntime } from "./lib/platform";
import { applyTheme, readStoredTheme, THEME_CHANGED_EVENT, THEME_STORAGE_KEY, type ThemeMode } from "./lib/theme";
import type { FloatingOptions } from "./FloatingUsage";
import { getTauriWindow } from "./lib/tauriWindow";
import { getViewedAccount } from "./lib/usageDisplay";
import "./App.css";

export default function App() {
  const { accounts, loading, error, loadAccounts, refreshUsage, refreshSingleUsage, deleteAccount, renameAccount, importFromFile, importFromCookie, startOAuthLogin, completeOAuthLogin, cancelOAuthLogin } = useAccounts();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let timer: number | undefined;
    const syncTimer = () => {
      window.clearInterval(timer);
      timer = undefined;
      if (document.hidden) return;
      setNow(Date.now());
      timer = window.setInterval(() => setNow(Date.now()), 1000);
    };
    syncTimer();
    document.addEventListener("visibilitychange", syncTimer);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", syncTimer); };
  }, []);
  const [options, setOptions] = useState<FloatingOptions | null>(null);
  const [adding, setAdding] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [theme, setTheme] = useState<ThemeMode>(readStoredTheme);
  useEffect(() => {
    applyTheme(theme);
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);
  const changeTheme = async () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
    if (isTauriRuntime()) { const { emit } = await import("@tauri-apps/api/event"); await emit(THEME_CHANGED_EVENT, next); }
  };
  useEffect(() => {
    let disposed = false;
    let stops: Array<() => void> = [];
    const load = async () => {
      const value = await invokeBackend<FloatingOptions>("get_floating_usage_options");
      if (!disposed) setOptions(value);
    };
    void (async () => {
      if (!isTauriRuntime()) { await load(); return; }
      const { listen } = await import("@tauri-apps/api/event");
      stops = await Promise.all([
        listen("app-settings-changed", () => { void load().catch((error) => setMessage(String(error))); }),
        listen("floating-usage-settings-requested", () => setSettingsOpen(true)),
        listen<string>("floating-usage-error", ({ payload }) => setMessage(payload)),
        listen<ThemeMode>(THEME_CHANGED_EVENT, ({ payload }) => setTheme(payload)),
      ]);
      if (disposed) { stops.forEach((stop) => stop()); return; }
      await load();
    })().catch((error) => { if (!disposed) setMessage(String(error)); });
    return () => { disposed = true; stops.forEach((stop) => stop()); };
  }, []);
  const selected = getViewedAccount(accounts, options?.floating_usage_account_id);
  const selectAccount = async (accountId: string) => {
    try {
      setOptions(await invokeBackend<FloatingOptions>("set_floating_usage_options", { accountId }));
      setMessage(null);
    } catch (error) { setMessage(String(error)); }
  };
  const removeAccount = async (accountId: string) => {
    try { await deleteAccount(accountId); setDeleteId(null); } catch (error) { setMessage(String(error)); }
  };
  const refreshAll = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { await refreshUsage(); } catch (error) { setMessage(String(error)); }
    finally { setRefreshing(false); }
  };
  const backup = async (importing: boolean) => {
    try {
      if (importing) {
        const result = await importFullBackupFile();
        if (result) { const list = await loadAccounts(); await refreshUsage(list.filter((account) => !account.usage), "导入备份"); setMessage(`已导入 ${result.imported_count} 个账户`); }
      } else if (await exportFullBackupFile()) setMessage("账户备份已导出");
    } catch (error) { setMessage(String(error)); }
  };
  const windowAction = async (action: "minimize" | "maximize" | "close") => {
    try {
      const current = getTauriWindow();
      if (!current) return;
      if (action === "maximize") await current.toggleMaximize();
      else if (action === "minimize") await current.minimize();
      else await current.close();
    } catch (error) { setMessage(String(error)); }
  };
  const visible = accounts.filter((account) => `${account.name} ${account.email ?? ""}`.toLowerCase().includes(search.toLowerCase()));
  const ordered = [...visible].sort((a, b) => Number(b.id === selected?.id) - Number(a.id === selected?.id));
  return <div className="grid h-dvh overflow-hidden bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100" style={{ gridTemplateRows: isTauriRuntime() ? "auto auto minmax(0, 1fr)" : "auto minmax(0, 1fr)" }}>
    {isTauriRuntime() && <div className="grid grid-cols-[1fr_auto] h-8" data-tauri-drag-region>
      <span data-tauri-drag-region />
      <div className="grid grid-cols-3">
        <button aria-label="最小化" className="px-4 text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-800" onClick={() => { void windowAction("minimize"); }}>−</button>
        <button aria-label="最大化或还原" className="px-4 text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-800" onClick={() => { void windowAction("maximize"); }}>□</button>
        <button aria-label="关闭主界面" className="px-4 text-gray-500 hover:bg-red-100" onClick={() => { void windowAction("close"); }}>×</button>
      </div>
    </div>}
    <header className="border-b border-gray-200 bg-white px-6 py-5 dark:border-gray-800 dark:bg-gray-900">
      <div className="mx-auto grid max-w-5xl grid-cols-1 items-center gap-4 min-[900px]:grid-cols-[1fr_auto]">
        <h1 className="text-xl font-semibold">Codex Switcher · 额度查看</h1>
        <div className="grid grid-flow-col items-center gap-3">
          <button disabled={refreshing} onClick={() => { void refreshAll(); }} className="rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-700 disabled:opacity-50 dark:bg-sky-900/30 dark:text-sky-300">{refreshing ? "刷新中…" : "刷新所有额度"}</button>
          <button onClick={() => setAdding(true)} className="rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-700 dark:bg-sky-900/30 dark:text-sky-300">添加账户</button>
          <button onClick={() => { void backup(true); }} className="text-sm text-gray-500">导入</button>
          <button onClick={() => { void backup(false); }} className="text-sm text-gray-500">导出</button>
          <button onClick={() => setSettingsOpen(true)} className="text-sm text-gray-500">设置</button>
          <button onClick={() => { void changeTheme(); }} className="text-sm text-gray-500">{theme === "dark" ? "浅色" : "深色"}</button>
        </div>
      </div>
      <p className="mx-auto mt-3 max-w-5xl text-xs text-gray-500">仅悬浮窗当前显示的账户自动刷新；其他账户只手动刷新。关闭悬浮窗后暂停自动刷新。</p>
    </header>
    <main className="min-h-0 overflow-y-auto" aria-label="账户额度" tabIndex={0}>
      <div className="mx-auto grid w-full max-w-5xl content-start gap-5 px-6 py-6">
      <UpdateChecker />
      {(message || error) && <p role="status" className="text-sm text-amber-600">{message || error}</p>}
      {accounts.length > 5 && <input aria-label="搜索账户" placeholder="搜索账户" value={search} onChange={(event) => setSearch(event.target.value)} className="rounded-lg border border-gray-200 bg-transparent px-3 py-2 dark:border-gray-700" />}
      {loading ? <p className="text-sm text-gray-500">加载账户中…</p> : ordered.length === 0 ? <p className="text-sm text-gray-500">暂无账户，点击“添加账户”开始查看额度。</p> : ordered.map((account) => <AccountCard key={account.id} account={account} now={now} selected={account.id === selected?.id} floatingEnabled={options?.floating_usage_enabled ?? false} refreshInterval={options?.account_usage_refresh_intervals[account.id] ?? 300} onSelect={() => { void selectAccount(account.id); }} onDelete={() => setDeleteId(account.id)} onRefresh={() => refreshSingleUsage(account.id)} onRename={(name) => renameAccount(account.id, name)} />)}

      </div>
    </main>
    {deleteId && <div className="fixed inset-0 z-50 grid place-items-center bg-black/30"><div role="dialog" aria-modal="true" aria-label="删除账户" className="grid gap-5 rounded-xl bg-white p-6 dark:bg-gray-900"><p>删除 {accounts.find((account) => account.id === deleteId)?.name}？</p><div className="grid grid-cols-2 gap-4"><button className="text-sm text-gray-500" onClick={() => setDeleteId(null)}>取消</button><button className="rounded-lg bg-sky-50 px-4 py-2 text-sm text-sky-700" onClick={() => { void removeAccount(deleteId); }}>确认删除</button></div></div></div>}
    {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    <AddAccountModal isOpen={adding} onClose={() => setAdding(false)} onImportFile={importFromFile} onImportCookie={importFromCookie} onStartOAuth={startOAuthLogin} onCompleteOAuth={completeOAuthLogin} onCancelOAuth={cancelOAuthLogin} />
    <WindowResizeBorders />
  </div>;
}
