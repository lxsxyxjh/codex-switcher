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
  floating_usage_vertical: boolean;
  floating_usage_edge_hide: boolean;
  floating_usage_edge: string | null;
}

function remainingPercent(used: number | null | undefined, showUsed: boolean): string {
  if (used === null || used === undefined || !Number.isFinite(used)) return "--";
  return `${Math.round(Math.max(0, Math.min(100, showUsed ? used : 100 - used)))}%`;
}

function FloatingUsage() {
  const barRef = useRef<HTMLDivElement>(null);
  const geometryRef = useRef<(detect?: boolean) => Promise<void>>(async () => {});
  const ignoreMovesUntil = useRef(0);
  const [fullSize, setFullSize] = useState({ width: 260, height: 48 });
  const [ready, setReady] = useState(false);
  const [edge, setEdge] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const menuRef = useRef<import("@tauri-apps/api/menu").Menu | null>(null);
  const [options, setOptions] = useState<FloatingOptions>({ floating_usage_enabled: false, floating_usage_scale: 100, floating_usage_account_id: null, floating_usage_show_used: false, floating_usage_vertical: false, floating_usage_edge_hide: false, floating_usage_edge: null });
  const loadOptions = useCallback(async () => {
    try {
      const settings = await invokeBackend<FloatingOptions>("get_floating_usage_options");
      setOptions(settings);
      setEdge(settings.floating_usage_edge);
      setReady(true);
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
        unlistenMoved = await currentWindow.onMoved(() => {
          if (Date.now() < ignoreMovesUntil.current) return;
          window.clearTimeout(savePositionTimer);
          savePositionTimer = window.setTimeout(() => {
            void geometryRef.current(true).catch(console.error);
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

  const sideEdge = edge === "left" || edge === "right";
  const tabWidth = sideEdge ? 16 : Math.min(52, fullSize.width);
  const tabHeight = sideEdge ? Math.min(44, fullSize.height) : 16;
  const collapsed = options.floating_usage_edge_hide && Boolean(edge) && !hovered && !dragging && !contextOpen;
  geometryRef.current = async (detect = false) => {
    const bar = barRef.current;
    if (!bar || !ready || !isTauriRuntime()) return;
    const full = bar.getBoundingClientRect();
    setFullSize((previous) => previous.width === Math.ceil(full.width) && previous.height === Math.ceil(full.height) ? previous : { width: Math.ceil(full.width), height: Math.ceil(full.height) });
    ignoreMovesUntil.current = Date.now() + 1000;
    try {
      const nextEdge = await invokeBackend<string | null>("resize_floating_usage", {
        width: collapsed ? tabWidth : Math.max(16, Math.ceil(full.width)),
        height: collapsed ? tabHeight : Math.max(16, Math.ceil(full.height)),
        fullWidth: Math.max(16, Math.ceil(full.width)), fullHeight: Math.max(16, Math.ceil(full.height)),
        edge, detectEdge: detect,
      });
      setEdge(nextEdge);
    } finally { ignoreMovesUntil.current = Date.now() + 150; }
  };
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const observer = new ResizeObserver(() => { void geometryRef.current().catch(console.error); });
    observer.observe(bar);
    void geometryRef.current().catch(console.error);
    return () => observer.disconnect();
  }, [ready, collapsed, edge, tabWidth, tabHeight, options.floating_usage_vertical, options.floating_usage_scale, options.floating_usage_edge_hide]);

  const saveOptions = (values: { scale?: number; accountId?: string; showUsed?: boolean; vertical?: boolean; edgeHide?: boolean }) => {
    void invokeBackend<FloatingOptions>("set_floating_usage_options", values).then(setOptions).catch(console.error);
  };
  const showContextMenu = async () => {
    setContextOpen(true);
    try {
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
      { text: "贴边隐藏", checked: options.floating_usage_edge_hide, action: () => saveOptions({ edgeHide: !options.floating_usage_edge_hide }) },
      { text: "排列方式", items: [
        { text: "横排", checked: !options.floating_usage_vertical, action: () => saveOptions({ vertical: false }) },
        { text: "竖排", checked: options.floating_usage_vertical, action: () => saveOptions({ vertical: true }) },
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
    } finally { setContextOpen(false); }
  };
  const scale = options.floating_usage_scale / 100;
  const mode = options.floating_usage_show_used ? "已用" : "剩余";
  return (
    <div onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
    {collapsed && <div title="鼠标移入展开额度，右键设置" className="grid place-items-center rounded-lg border border-slate-400 bg-slate-200 text-xs text-slate-600 dark:bg-slate-700 dark:text-slate-200" style={{ width: tabWidth, height: tabHeight }} onContextMenu={(event) => { event.preventDefault(); void showContextMenu().catch(console.error); }}>{edge === "left" ? "›" : edge === "right" ? "‹" : edge === "top" ? "⌄" : "⌃"}</div>}
    <div ref={barRef}
      onContextMenu={(event) => { event.preventDefault(); void showContextMenu().catch(console.error); }}
      onMouseDown={(event) => { if (event.button === 0 && currentWindow) {
        setDragging(true); ignoreMovesUntil.current = 0;
        void currentWindow.startDragging().catch(console.error).finally(() => {
          void geometryRef.current(true).catch(console.error).finally(() => setDragging(false));
        });
      } }}
      title={`${displayAccount?.name ?? "未添加账户"} · ${mode}百分比${isStale ? " · 刷新失败，保留上次成功数据" : ""} · 右键设置`}
      className="select-none border border-slate-300/80 bg-slate-100/95 text-slate-600 dark:border-slate-600/80 dark:bg-slate-800/95 dark:text-slate-200"
      style={{ display: "inline-grid", position: collapsed ? "absolute" : "relative", visibility: collapsed ? "hidden" : "visible", pointerEvents: collapsed ? "none" : "auto", gridTemplateColumns: options.floating_usage_vertical ? "max-content" : "repeat(3, max-content)", width: "max-content", gap: 10 * scale, padding: `${8 * scale}px ${10 * scale}px`, fontSize: 12 * scale, lineHeight: 1.5, borderRadius: 10 * scale }}
    >
      <span className="whitespace-nowrap tabular-nums">5h {mode}{options.floating_usage_vertical ? ":" : " "} <b style={{ display: options.floating_usage_vertical ? "block" : "inline" }}>{remainingPercent(usage?.primary_window_minutes == null || usage.primary_window_minutes === 300 ? usage?.primary_used_percent : undefined, options.floating_usage_show_used)}</b></span>
      <span className="whitespace-nowrap tabular-nums">7d {mode}{options.floating_usage_vertical ? ":" : " "} <b style={{ display: options.floating_usage_vertical ? "block" : "inline" }}>{remainingPercent(usage?.secondary_window_minutes == null || usage.secondary_window_minutes === 10080 ? usage?.secondary_used_percent : undefined, options.floating_usage_show_used)}</b></span>
      <span className="whitespace-nowrap tabular-nums">{isStale && <span className="text-amber-500">• </span>}余额{options.floating_usage_vertical ? ":" : " "} <b style={{ display: options.floating_usage_vertical ? "block" : "inline" }}>{formatCreditsBalance(usage?.credits_balance)}</b></span>
    </div>
    </div>
  );
}

export default FloatingUsage;
