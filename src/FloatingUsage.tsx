import { useCallback, useEffect, useRef, useState } from "react";
import type { AccountInfo, UsageInfo } from "./types";
import { invokeBackend, isTauriRuntime } from "./lib/platform";
import { getTauriWindow } from "./lib/tauriWindow";
import { formatCreditsBalance } from "./lib/usageDisplay";
import {
  applyTheme,
  syncThemeFromStorage,
  THEME_CHANGED_EVENT,
  type ThemeMode,
} from "./lib/theme";

const USAGE_UPDATED_EVENT = "usage-updated";
const ACCOUNTS_CHANGED_EVENT = "accounts-changed";

export interface FloatingOptions {
  floating_usage_enabled: boolean;
  floating_usage_scale: number;
  floating_usage_account_id: string | null;
  floating_usage_show_used: boolean;
}

function remainingPercent(used: number | null | undefined, showUsed: boolean): string {
  if (used === null || used === undefined || !Number.isFinite(used)) return "--";
  return `${Math.round(Math.max(0, Math.min(100, showUsed ? used : 100 - used)))}%`;
}

function FloatingUsage() {
  const barRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<import("@tauri-apps/api/menu").Menu | null>(null);
  const [options, setOptions] = useState<FloatingOptions>({ floating_usage_enabled: false, floating_usage_scale: 100, floating_usage_account_id: null, floating_usage_show_used: false });
  const loadOptions = useCallback(async () => {
    try {
      setOptions(await invokeBackend<FloatingOptions>("get_floating_usage_options"));
    } catch (error) {
      console.error("Failed to load floating usage settings:", error);
    }
  }, []);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [usageById, setUsageById] = useState<Record<string, UsageInfo>>({});
  const [staleById, setStaleById] = useState<Record<string, boolean>>({});

  const loadAccounts = useCallback(async () => {
    try {
      setAccounts(await invokeBackend<AccountInfo[]>("list_accounts"));
    } catch (error) {
      console.error("Failed to load accounts for floating usage:", error);
    }
  }, []);

  const applyUsageUpdates = useCallback((usages: UsageInfo[]) => {
    setUsageById((previous) => {
      const next = { ...previous };
      for (const usage of usages) {
        if (!usage.error) next[usage.account_id] = usage;
      }
      return next;
    });
    setStaleById((previous) => {
      const next = { ...previous };
      for (const usage of usages) next[usage.account_id] = Boolean(usage.error);
      return next;
    });
  }, []);

  const loadCachedUsage = useCallback(async () => {
    try {
      applyUsageUpdates(await invokeBackend<UsageInfo[]>("get_cached_usage"));
    } catch (error) {
      console.error("Failed to load cached usage:", error);
    }
  }, [applyUsageUpdates]);

  useEffect(() => {
    syncThemeFromStorage();
    if (!isTauriRuntime()) return;

    let disposed = false;
    let unlistenSettings: (() => void) | undefined;
    let unlistenUsage: (() => void) | undefined;
    let unlistenAccounts: (() => void) | undefined;
    let unlistenTheme: (() => void) | undefined;
    let unlistenMoved: (() => void) | undefined;
    let savePositionTimer: number | undefined;

    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlistenUsage = await listen<UsageInfo[]>(USAGE_UPDATED_EVENT, ({ payload }) => {
        applyUsageUpdates(payload);
      });
      unlistenAccounts = await listen(ACCOUNTS_CHANGED_EVENT, () => {
        void loadAccounts();
        void loadCachedUsage();
      });
      unlistenTheme = await listen<ThemeMode>(THEME_CHANGED_EVENT, ({ payload }) => {
        if (payload === "light" || payload === "dark") applyTheme(payload);
      });

      unlistenSettings = await listen("app-settings-changed", () => { void loadOptions(); void loadCachedUsage(); });
      const currentWindow = getTauriWindow();
      if (currentWindow) {
        unlistenMoved = await currentWindow.onMoved(({ payload }) => {
          window.clearTimeout(savePositionTimer);
          savePositionTimer = window.setTimeout(() => {
            void invokeBackend("save_floating_usage_position", {
              x: payload.x,
              y: payload.y,
            }).catch((error) => console.error("Failed to save floating usage position:", error));
          }, 250);
        });
      }

      if (disposed) {
        unlistenUsage?.(); unlistenAccounts?.(); unlistenTheme?.(); unlistenMoved?.(); unlistenSettings?.();
        return;
      }
      await Promise.all([loadAccounts(), loadCachedUsage(), loadOptions()]);
    })().catch((error) => console.error("Failed to initialize floating usage:", error));

    return () => {
      disposed = true;
      unlistenSettings?.();
      void menuRef.current?.close().catch(console.error);
      if (savePositionTimer !== undefined) window.clearTimeout(savePositionTimer);
      unlistenUsage?.();
      unlistenAccounts?.();
      unlistenTheme?.();
      unlistenMoved?.();
    };
  }, [applyUsageUpdates, loadAccounts, loadCachedUsage, loadOptions]);

  const displayAccount =
    accounts.find((account) => account.id === options.floating_usage_account_id) ??
    accounts.find((account) => account.is_active) ??
    accounts.find((account) => account.auth_mode === "cookie");
  const usage = displayAccount ? usageById[displayAccount.id] : undefined;
  const isStale = displayAccount ? Boolean(staleById[displayAccount.id]) : false;
  const currentWindow = getTauriWindow();

  useEffect(() => {
    const bar = barRef.current;
    if (!bar || !isTauriRuntime()) return;
    let lastSize = "";
    const resize = () => {
      const { width, height } = bar.getBoundingClientRect();
      const size = `${Math.ceil(width)}:${Math.ceil(height)}`;
      if (size === lastSize) return;
      lastSize = size;
      void invokeBackend("resize_floating_usage", { width: Math.max(80, Math.ceil(width)), height: Math.max(16, Math.ceil(height)) }).catch(console.error);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(bar);
    resize();
    return () => observer.disconnect();
  }, []);

  const saveOptions = (values: { scale?: number; accountId?: string; showUsed?: boolean }) => {
    void invokeBackend<FloatingOptions>("set_floating_usage_options", values).then(setOptions).catch(console.error);
  };
  const showContextMenu = async () => {
    const { Menu } = await import("@tauri-apps/api/menu");
    await menuRef.current?.close();
    const menu = await Menu.new({ items: [
      { text: "打开主界面", action: () => { void invokeBackend("open_main_window"); } },
      { text: "显示账户", items: [
        { text: "跟随当前账户", checked: !options.floating_usage_account_id, action: () => saveOptions({ accountId: "" }) },
        ...accounts.map((account) => ({ text: `${account.name} (${account.auth_mode === "cookie" ? "Cookie" : "Codex 登录"})`, checked: options.floating_usage_account_id === account.id, action: () => saveOptions({ accountId: account.id }) })),
      ] },
      { text: "百分比显示", items: [
        { text: "剩余百分比", checked: !options.floating_usage_show_used, action: () => saveOptions({ showUsed: false }) },
        { text: "已用百分比", checked: options.floating_usage_show_used, action: () => saveOptions({ showUsed: true }) },
      ] },
      { text: "缩放比例", items: [
        ...[50, 75, 100, 125, 150, 200].map((scale) => ({ text: `${scale}%`, checked: options.floating_usage_scale === scale, action: () => saveOptions({ scale }) })),
        { text: "自定义…", action: () => {
          void (async () => {
            await invokeBackend("open_main_window");
            const { emit } = await import("@tauri-apps/api/event");
            await emit("floating-usage-settings-requested");
          })();
        } },
      ] },
      { text: "关闭悬浮窗", action: () => { void invokeBackend("set_floating_usage_enabled", { enabled: false }); } },
    ] });
    menuRef.current = menu;
    await menu.popup(undefined, currentWindow ?? undefined);
  };
  const scale = options.floating_usage_scale / 100;
  const mode = options.floating_usage_show_used ? "已用" : "剩余";
  return (
    <div ref={barRef}
      onContextMenu={(event) => { event.preventDefault(); void showContextMenu().catch(console.error); }}
      onMouseDown={(event) => { if (event.button === 0) void currentWindow?.startDragging().catch(console.error); }}
      title={`${displayAccount?.name ?? "未添加账户"} · ${mode}百分比${isStale ? " · 刷新失败，保留上次成功数据" : ""} · 右键设置`}
      className="select-none border border-slate-300/80 bg-slate-100/95 text-slate-600 dark:border-slate-600/80 dark:bg-slate-800/95 dark:text-slate-200"
      style={{ display: "inline-grid", gridTemplateColumns: "repeat(3, max-content)", width: "max-content", gap: 10 * scale, padding: `${8 * scale}px ${10 * scale}px`, fontSize: 12 * scale, lineHeight: 1.5, borderRadius: 10 * scale }}
    >
      <span className="whitespace-nowrap tabular-nums">5h {mode} <b>{remainingPercent(usage?.primary_window_minutes == null || usage.primary_window_minutes === 300 ? usage?.primary_used_percent : undefined, options.floating_usage_show_used)}</b></span>
      <span className="whitespace-nowrap tabular-nums">7d {mode} <b>{remainingPercent(usage?.secondary_window_minutes == null || usage.secondary_window_minutes === 10080 ? usage?.secondary_used_percent : undefined, options.floating_usage_show_used)}</b></span>
      <span className="whitespace-nowrap tabular-nums">{isStale && <span className="text-amber-500">• </span>}余额 <b>{formatCreditsBalance(usage?.credits_balance)}</b></span>
    </div>
  );
}

export default FloatingUsage;
