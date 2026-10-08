import { useCallback, useEffect, useRef, useState } from "react";
import type { AccountInfo, UsageInfo } from "./types";
import { invokeBackend, isTauriRuntime } from "./lib/platform";
import { getTauriWindow, isCursorInsideWindow } from "./lib/tauriWindow";
import { getViewedAccount, formatCreditsBalance, formatQuotaResetTime, formatUsagePercent, getDisplayedUsageWindows, mergeUsageUpdate, usageRefreshIntervals } from "./lib/usageDisplay";
import {
  applyTheme,
  syncThemeFromStorage,
  THEME_CHANGED_EVENT,
  type ThemeMode,
} from "./lib/theme";

const USAGE_UPDATED_EVENT = "usage-updated";
const ACCOUNTS_CHANGED_EVENT = "accounts-changed";

export interface FloatingOptions {
  account_usage_refresh_intervals: Record<string, number>;
  floating_usage_enabled: boolean;
  floating_usage_scale: number;
  floating_usage_account_id: string | null;
  floating_usage_show_used: boolean;
  floating_usage_vertical: boolean;
  floating_usage_edge_hide: boolean;
  floating_usage_edge: string | null;
}

function FloatingUsage() {
  const barRef = useRef<HTMLDivElement>(null);
  const geometryRef = useRef<(detect?: boolean) => Promise<void>>(async () => {});
  const geometryUpdateRef = useRef<(detect: boolean) => Promise<void>>(async () => {});
  const ignoreMovesUntil = useRef(0);
  const draggingRef = useRef(false);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const geometryQueue = useRef<Promise<void>>(Promise.resolve());
  const edgeHideEnabled = useRef<boolean | null>(null);
  const dockedEdge = useRef<string | null>(null);
  const hoverLeaveTimer = useRef<number | undefined>(undefined);
  const refreshInFlight = useRef(false);
  const [fullSize, setFullSize] = useState({ width: 260, height: 48 });
  const [ready, setReady] = useState(false);
  const [edge, setEdge] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [hoverTime, setHoverTime] = useState(Date.now);
  const [options, setOptions] = useState<FloatingOptions>({ account_usage_refresh_intervals: {}, floating_usage_enabled: false, floating_usage_scale: 100, floating_usage_account_id: null, floating_usage_show_used: false, floating_usage_vertical: false, floating_usage_edge_hide: false, floating_usage_edge: null });
  const [hintVisible, setHintVisible] = useState(false);
  useEffect(() => {
    if (!options.floating_usage_enabled || !hovered || dragging || contextOpen) { setHintVisible(false); return; }
    const timer = window.setTimeout(() => setHintVisible(true), 450);
    return () => window.clearTimeout(timer);
  }, [hovered, dragging, contextOpen, options.floating_usage_enabled]);
  useEffect(() => {
    if (!options.floating_usage_enabled || !hovered || dragging || contextOpen) return;
    setHoverTime(Date.now());
    const timer = window.setInterval(() => setHoverTime(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hovered, dragging, contextOpen, options.floating_usage_enabled]);
  const menuRef = useRef<import("@tauri-apps/api/menu").Menu | null>(null);
  const loadOptions = useCallback(async () => {
    try {
      const settings = await invokeBackend<FloatingOptions>("get_floating_usage_options");
      setOptions(settings);
      if (!draggingRef.current) {
        dockedEdge.current = settings.floating_usage_edge;
        setEdge(settings.floating_usage_edge);
      }
      setReady(true);
    } catch (error) {
      console.error("Failed to load floating usage settings:", error);
    }
  }, []);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [usageById, setUsageById] = useState<Record<string, UsageInfo>>({});

  const loadAccounts = useCallback(async () => {
    try {
      const list = await invokeBackend<AccountInfo[]>("list_accounts");
      setAccounts(list);
      const ids = new Set(list.map((account) => account.id));
      setUsageById((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => ids.has(id))));
    } catch (error) {
      console.error("Failed to load accounts for floating usage:", error);
    }
  }, []);

  const applyUsageUpdates = useCallback((usages: UsageInfo[]) => {
    setUsageById((previous) => {
      const next = { ...previous };
      for (const usage of usages) {
        next[usage.account_id] = mergeUsageUpdate(previous[usage.account_id], usage);
      }
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
          if (draggingRef.current || Date.now() < ignoreMovesUntil.current) return;
          window.clearTimeout(savePositionTimer);
          savePositionTimer = window.setTimeout(() => {
            if (draggingRef.current) return;
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
      window.clearTimeout(hoverLeaveTimer.current);
      unlistenSettings?.();
      void menuRef.current?.close().catch(console.error);
      if (savePositionTimer !== undefined) window.clearTimeout(savePositionTimer);
      unlistenUsage?.();
      unlistenAccounts?.();
      unlistenTheme?.();
      unlistenMoved?.();
    };
  }, [applyUsageUpdates, loadAccounts, loadCachedUsage, loadOptions]);

  const displayAccount = getViewedAccount(accounts, options.floating_usage_account_id);
  const usage = displayAccount ? usageById[displayAccount.id] : undefined;
  const usageWindows = getDisplayedUsageWindows(usage);
  const isStale = Boolean(usage?.error);
  const currentWindow = getTauriWindow();

  const sideEdge = edge === "left" || edge === "right";
  const tabWidth = sideEdge ? 8 : Math.min(36, fullSize.width);
  const tabHeight = sideEdge ? Math.min(32, fullSize.height) : 8;
  const collapsed = options.floating_usage_edge_hide && Boolean(edge) && !hovered && !dragging && !contextOpen;
  geometryUpdateRef.current = async (detect) => {
    const bar = barRef.current;
    if (!bar || !ready || !isTauriRuntime() || (draggingRef.current && !detect)) return;
    const full = bar.getBoundingClientRect();
    setFullSize((previous) => previous.width === Math.ceil(full.width) && previous.height === Math.ceil(full.height) ? previous : { width: Math.ceil(full.width), height: Math.ceil(full.height) });
    ignoreMovesUntil.current = Date.now() + 1000;
    try {
      const nextEdge = await invokeBackend<string | null>("resize_floating_usage", {
        width: collapsed && !draggingRef.current ? tabWidth : Math.max(16, Math.ceil(full.width)),
        height: collapsed && !draggingRef.current ? tabHeight : Math.max(16, Math.ceil(full.height)),
        fullWidth: Math.max(16, Math.ceil(full.width)), fullHeight: Math.max(16, Math.ceil(full.height)),
        edge: draggingRef.current ? null : dockedEdge.current, detectEdge: detect,
      });
      dockedEdge.current = nextEdge;
      setEdge(nextEdge);
    } finally { ignoreMovesUntil.current = Date.now() + 150; }
  };
  geometryRef.current = (detect = false) => {
    const pending = geometryQueue.current.then(() => geometryUpdateRef.current(detect));
    geometryQueue.current = pending.catch(console.error);
    return pending;
  };
  useEffect(() => {
    if (!ready) return;
    const enabled = options.floating_usage_edge_hide;
    const newlyEnabled = enabled && edgeHideEnabled.current === false;
    edgeHideEnabled.current = enabled;
    if (newlyEnabled) {
      setHovered(false);
      void geometryRef.current(true).catch(console.error);
    }
  }, [ready, options.floating_usage_edge_hide]);
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const observer = new ResizeObserver(() => { void geometryRef.current().catch(console.error); });
    observer.observe(bar);
    return () => observer.disconnect();
  }, [ready, collapsed, edge, tabWidth, tabHeight, options.floating_usage_vertical, options.floating_usage_scale, options.floating_usage_edge_hide]);

  const saveOptions = (values: { scale?: number; accountId?: string; showUsed?: boolean; vertical?: boolean; edgeHide?: boolean }) => {
    void invokeBackend<FloatingOptions>("set_floating_usage_options", values).then(setOptions).catch(console.error);
  };
  const refreshUsage = async () => {
    if (!displayAccount || refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    try {
      await invokeBackend<UsageInfo>("get_usage", { accountId: displayAccount.id, source: "悬浮窗按钮" });
    } catch (error) {
      console.error("Failed to refresh floating usage:", error);
    } finally {
      refreshInFlight.current = false;
      setRefreshing(false);
    }
  };
  const showContextMenu = async () => {
    setContextOpen(true);
    try {
    const { Menu } = await import("@tauri-apps/api/menu");
    await menuRef.current?.close();
    const menu = await Menu.new({ items: [
      { text: "打开主界面", action: () => { void invokeBackend("open_main_window"); } },
      { text: "自动刷新间隔", enabled: !!displayAccount, items: usageRefreshIntervals.map(({ seconds, label }) => ({ text: label, checked: (options.account_usage_refresh_intervals[displayAccount?.id ?? ""] ?? 300) === seconds, action: () => { void invokeBackend("set_usage_refresh_interval", { accountId: displayAccount?.id, seconds }).catch(console.error); } })) },
      { text: "显示账户", items: [
        { text: "默认查看账户", checked: !accounts.some((account) => account.id === options.floating_usage_account_id), action: () => saveOptions({ accountId: "" }) },
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
  const resetHint = usageWindows.map((quota) => {
    const resetAt = quota.key === "primary" ? usage?.primary_resets_at : usage?.secondary_resets_at;
    return `${quota.label} 额度重置：${formatQuotaResetTime(resetAt, hoverTime) || "暂无重置时间"}`;
  }).join("\n") || "暂无额度重置时间";
  const formatRefreshHint = (timestamp: string | null | undefined) => {
    const date = timestamp ? new Date(timestamp) : null;
    if (!date || !Number.isFinite(date.getTime())) return "暂无记录";
    const pad = (value: number) => String(value).padStart(2, "0");
    const time = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    return `${time} · 距今 ${Math.max(0, Math.floor((hoverTime - date.getTime()) / 1000))} 秒`;
  };
  const usageHint = `${displayAccount?.name ?? "未添加账户"}\n${resetHint}\n最近成功：${formatRefreshHint(usage?.fetched_at)}\n最近尝试：${formatRefreshHint(usage?.attempted_at)}${usage?.attempted_at ? isStale ? " · 失败" : " · 成功" : ""}${isStale ? "\n刷新失败，保留上次成功数据" : ""}`;
  useEffect(() => {
    void invokeBackend("show_usage_hint", { text: hintVisible && options.floating_usage_enabled ? usageHint : null }).catch(console.error);
  }, [hintVisible, usageHint, options.floating_usage_enabled]);
  useEffect(() => () => { void invokeBackend("show_usage_hint", { text: null }).catch(console.error); }, []);
  return (
    <div onMouseEnter={() => {
      setHoverTime(Date.now());
      window.clearTimeout(hoverLeaveTimer.current);
      hoverLeaveTimer.current = undefined;
      setHovered(true);
    }} onMouseLeave={() => {
      if (draggingRef.current) return;
      window.clearTimeout(hoverLeaveTimer.current);
      const timer = window.setTimeout(() => {
        void (async () => {
          await geometryQueue.current;
          const inside = await isCursorInsideWindow();
          if (!draggingRef.current && hoverLeaveTimer.current === timer) {
            hoverLeaveTimer.current = undefined;
            setHovered(inside);
          }
        })().catch(console.error);
      }, 100);
      hoverLeaveTimer.current = timer;
    }}>
    {collapsed && <div className="grid place-items-center rounded-lg border border-slate-400 bg-slate-200 text-xs text-slate-600 dark:bg-slate-700 dark:text-slate-200" style={{ width: tabWidth, height: tabHeight }} onContextMenu={(event) => { event.preventDefault(); void showContextMenu().catch(console.error); }}></div>}
    <div ref={barRef}
      onContextMenu={(event) => { event.preventDefault(); void showContextMenu().catch(console.error); }}
      onDoubleClick={() => { void invokeBackend("toggle_main_window").catch(console.error); }}
      onMouseDown={(event) => { if (event.button === 0) dragStart.current = { x: event.screenX, y: event.screenY }; }}
      onMouseUp={() => { dragStart.current = null; }}
      onMouseMove={(event) => { if (event.buttons === 1 && currentWindow && dragStart.current && Math.hypot(event.screenX - dragStart.current.x, event.screenY - dragStart.current.y) >= 4) {
        dragStart.current = null;
        if (draggingRef.current) return;
        window.clearTimeout(hoverLeaveTimer.current);
        hoverLeaveTimer.current = undefined;
        draggingRef.current = true;
        setDragging(true);
        dockedEdge.current = null;
        setEdge(null);
        void (async () => {
          try {
            await geometryQueue.current;
            await currentWindow.startDragging();
            await invokeBackend("wait_for_floating_drag_release");
            await geometryRef.current(true);
          } finally {
            try { setHovered(await isCursorInsideWindow()); }
            finally {
              draggingRef.current = false;
              setDragging(false);
            }
          }
        })().catch(console.error);
      } }}
      className="select-none border border-slate-300/80 bg-slate-100/95 text-slate-600 dark:border-slate-600/80 dark:bg-slate-800/95 dark:text-slate-200"
      style={{ display: "inline-grid", position: collapsed ? "absolute" : "relative", visibility: collapsed ? "hidden" : "visible", pointerEvents: collapsed ? "none" : "auto", gridTemplateColumns: options.floating_usage_vertical ? "max-content" : `repeat(${usageWindows.length + 2}, max-content)`, alignItems: "center", width: "max-content", gap: 10 * scale, padding: `${8 * scale}px ${10 * scale}px`, fontSize: 12 * scale, lineHeight: 1.5, borderRadius: 10 * scale }}
    >
      {usageWindows.map((quota) => <span key={quota.key} className="whitespace-nowrap tabular-nums" style={{ gridColumn: options.floating_usage_vertical ? 1 : undefined }}>{quota.label} {mode}{options.floating_usage_vertical ? ":" : " "} <b style={{ display: options.floating_usage_vertical ? "block" : "inline" }}>{formatUsagePercent(quota.used, options.floating_usage_show_used)}</b></span>)}
      <span className="whitespace-nowrap tabular-nums" style={{ gridColumn: options.floating_usage_vertical ? 1 : undefined }}>额度{options.floating_usage_vertical ? ":" : " "} <b style={{ display: options.floating_usage_vertical ? "block" : "inline" }}>{formatCreditsBalance(usage?.credits_balance)}</b></span>
      <div className="grid grid-flow-col items-center" style={{ gridColumn: options.floating_usage_vertical ? 1 : undefined, justifySelf: options.floating_usage_vertical ? "center" : undefined, gap: 4 * scale }}>
      <button type="button" aria-label="刷新当前账户额度" title={refreshing ? "正在刷新额度…" : isStale ? "刷新失败，显示上次成功数据。点击重新刷新" : "立即更新额度数据"}
        disabled={refreshing || !displayAccount}
        onMouseDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onClick={() => { void refreshUsage().catch(console.error); }}
        className="grid place-items-center rounded-lg border-0 bg-transparent text-slate-500 hover:bg-slate-200 disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-700"
        style={{ width: Math.max(24, 24 * scale), height: Math.max(24, 24 * scale), fontSize: Math.max(14, 16 * scale) }}>
        <span className={refreshing ? "animate-spin" : undefined}>↻</span>
      </button>
      {isStale && <span role="img" aria-label="刷新失败，保留上次成功数据" title="刷新失败，保留上次成功数据" className="rounded-full bg-amber-500" style={{ width: 4 * scale, height: 4 * scale }} />}
      </div>
    </div>
    </div>
  );
}

export default FloatingUsage;
