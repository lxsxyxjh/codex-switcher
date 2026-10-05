import { useCallback, useEffect, useState } from "react";
import type { AccountInfo, AccountUsageStats, DockDisplayMode, UsageInfo } from "./types";
import { invokeBackend, isTauriRuntime } from "./lib/platform";
import {
  applyTheme,
  syncThemeFromStorage,
  THEME_CHANGED_EVENT,
  type ThemeMode,
} from "./lib/theme";
import {
  AUTO_WARMUP_ALL_CHANGED_EVENT,
  readAutoWarmupAllEnabled,
  writeAutoWarmupAllEnabled,
} from "./lib/autoWarmup";
import { formatCreditsBalance } from "./lib/usageDisplay";

const TRAY_REFRESH_EVENT = "tray-refresh";
const ACCOUNTS_CHANGED_EVENT = "accounts-changed";
const SWITCH_ACCOUNT_BLOCKED_EVENT = "switch-account-blocked";
// Mirrors the backend guard message in process.rs (ensure_codex_not_running).
const CODEX_RUNNING_PREFIX = "Cannot switch accounts while";

function formatError(err: unknown): string {
  if (!err) return "Unknown error";
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "Unknown error";
  }
}

// "plus" -> "Plus". Returns null when there is no usable plan label.
function formatPlan(plan: string | null): string | null {
  const trimmed = plan?.trim();
  if (!trimmed) return null;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

// Color classes for a rate-limit window based on remaining %, matching the main app.
function remainingTone(remaining: number): { text: string; bar: string; dot: string } {
  if (remaining <= 10) {
    return { text: "text-red-500 dark:text-red-400", bar: "bg-red-500", dot: "bg-red-500" };
  }
  if (remaining <= 30) {
    return {
      text: "text-amber-500 dark:text-amber-400",
      bar: "bg-amber-500",
      dot: "bg-amber-500",
    };
  }
  return {
    text: "text-green-600 dark:text-green-400",
    bar: "bg-emerald-500",
    dot: "bg-emerald-500",
  };
}

// "time until reset" label, e.g. "4h 55m" / "4d 18h" / "now".
function formatResetAt(resetAt: number | null | undefined): string | null {
  if (!resetAt) return null;

  const diff = resetAt - Math.floor(Date.now() / 1000);
  if (diff <= 0) return "now";
  if (diff < 60) return `${diff} 秒`;
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟`;
  if (diff < 86_400) {
    return `${Math.floor(diff / 3600)} 小时 ${Math.floor((diff % 3600) / 60)} 分钟`;
  }
  return `${Math.floor(diff / 86_400)} 天 ${Math.floor((diff % 86_400) / 3600)} 小时`;
}

function formatExactResetTime(
  resetAt: number | null | undefined,
  isWeekly: boolean,
): string | null {
  if (!resetAt) return null;

  const date = new Date(resetAt * 1000);
  const diff = resetAt - Math.floor(Date.now() / 1000);

  if (isWeekly && diff > 86_400) {
    return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
  }

  const minutes = String(date.getMinutes()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  return `${hour}:${minutes}`;
}

function formatTokens(tokens: number | null | undefined): string {
  if (tokens === null || tokens === undefined || !Number.isFinite(tokens)) return "--";
  const abs = Math.abs(tokens);
  if (abs >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return `${tokens}`;
}

function dayKey(offset: number): string {
  const date = new Date();
  date.setDate(date.getDate() - offset);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function sumDailyTokens(stats: AccountUsageStats, days: number): number {
  const keys = new Set(Array.from({ length: days }, (_, index) => dayKey(index)));
  return stats.daily.reduce((total, day) => (keys.has(day.date) ? total + day.tokens : total), 0);
}

function retainUsageForAccounts(
  usageById: Record<string, UsageInfo>,
  accounts: AccountInfo[]
): Record<string, UsageInfo> {
  return Object.fromEntries(
    accounts.flatMap((account) =>
      usageById[account.id] ? [[account.id, usageById[account.id]]] : []
    )
  );
}

function mergeUsageForAccounts(
  previous: Record<string, UsageInfo>,
  accounts: AccountInfo[],
  updates: UsageInfo[]
): Record<string, UsageInfo> {
  const next = retainUsageForAccounts(previous, accounts);
  for (const usage of updates) {
    if (!usage.error || !next[usage.account_id]) {
      next[usage.account_id] = usage;
    }
  }
  return next;
}

function TrayMenu() {
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usageById, setUsageById] = useState<Record<string, UsageInfo>>({});
  const [statsById, setStatsById] = useState<Record<string, AccountUsageStats>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [autoWarmupAllEnabled, setAutoWarmupAllEnabled] = useState(readAutoWarmupAllEnabled);
  const [dockDisplayMode, setDockDisplayMode] = useState<DockDisplayMode | null>(null);
  const [floatingUsageEnabled, setFloatingUsageEnabled] = useState<boolean | null>(null);
  const [floatingUsageUpdating, setFloatingUsageUpdating] = useState(false);

  const loadActiveStats = useCallback(async (list: AccountInfo[]) => {
    const active = list.find((account) => account.is_active);
    if (!active) return;

    try {
      const stats = await invokeBackend<AccountUsageStats>("get_account_usage_stats", {
        accountId: active.id,
      });
      setStatsById((prev) => ({ ...prev, [active.id]: stats }));
    } catch (err) {
      setStatsById((prev) => ({
        ...prev,
        [active.id]: {
          account_id: active.id,
          available: false,
          source: "Codex usage stats via ChatGPT backend",
          generated_at: null,
          stats_as_of: null,
          summary: {
            lifetime_tokens: null,
            peak_daily_tokens: null,
            longest_task_seconds: null,
            current_streak_days: null,
            longest_streak_days: null,
          },
          activity: {
            fast_mode_percent: null,
            reasoning_effort: null,
            reasoning_effort_percent: null,
            skills_explored: null,
            total_skills_used: null,
            total_threads: null,
          },
          daily: [],
          top_invocations: [],
          reset_credits: null,
          error: formatError(err),
        },
      }));
    }
  }, []);

  const loadDockDisplayMode = useCallback(async () => {
    try {
      const mode = await invokeBackend<DockDisplayMode | null>("get_dock_display_mode");
      setDockDisplayMode(mode);
    } catch {
      setDockDisplayMode(null);
    }
  }, []);

  const loadFloatingUsageEnabled = useCallback(async () => {
    try {
      setFloatingUsageEnabled(await invokeBackend<boolean | null>("get_floating_usage_enabled"));
    } catch {
      setFloatingUsageEnabled(null);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      void loadDockDisplayMode();
      void loadFloatingUsageEnabled();
      const list = await invokeBackend<AccountInfo[]>("list_accounts");
      setAccounts(list);
      let cachedUsage: UsageInfo[] = [];
      try {
        cachedUsage = await invokeBackend<UsageInfo[]>("get_cached_usage");
      } catch (err) {
        console.warn("Failed to load cached usage for tray:", err);
      }
      setUsageById((prev) => mergeUsageForAccounts(prev, list, cachedUsage));
      setError(null);
      void loadActiveStats(list);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, [loadActiveStats, loadDockDisplayMode, loadFloatingUsageEnabled]);

  // Manual refresh: re-pull accounts and actively fetch fresh usage once.
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const list = await invokeBackend<AccountInfo[]>("list_accounts");
      setAccounts(list);
      setError(null);
      const [usages] = await Promise.all([
        invokeBackend<UsageInfo[]>("refresh_all_accounts_usage"),
        loadActiveStats(list),
      ]);
      await invokeBackend("report_usage", { usages });
      setUsageById((prev) => mergeUsageForAccounts(prev, list, usages));
    } catch (err) {
      setError(formatError(err));
    } finally {
      setRefreshing(false);
    }
  }, [loadActiveStats]);

  const handleAutoWarmupToggle = useCallback(async () => {
    const next = !autoWarmupAllEnabled;
    setAutoWarmupAllEnabled(next);
    try {
      writeAutoWarmupAllEnabled(next);
      if (isTauriRuntime()) {
        const { emit } = await import("@tauri-apps/api/event");
        await emit(AUTO_WARMUP_ALL_CHANGED_EVENT, next);
      }
    } catch (err) {
      setAutoWarmupAllEnabled(!next);
      setError(formatError(err));
    }
  }, [autoWarmupAllEnabled]);

  const handleDockDisplayMode = useCallback(
    async (mode: DockDisplayMode) => {
      const previous = dockDisplayMode;
      setDockDisplayMode(mode);
      try {
        const next = await invokeBackend<DockDisplayMode | null>("set_dock_display_mode", {
          mode,
        });
        setDockDisplayMode(next);
      } catch (err) {
        setDockDisplayMode(previous);
        setError(formatError(err));
      }
    },
    [dockDisplayMode]
  );

  const handleFloatingUsageToggle = useCallback(async () => {
    if (floatingUsageEnabled === null || floatingUsageUpdating) return;
    const next = !floatingUsageEnabled;
    setFloatingUsageUpdating(true);
    try {
      const enabled = await invokeBackend<boolean>("set_floating_usage_enabled", {
        enabled: next,
      });
      setFloatingUsageEnabled(enabled);
      setError(null);
    } catch (err) {
      setError(formatError(err));
      void loadFloatingUsageEnabled();
    } finally {
      setFloatingUsageUpdating(false);
    }
  }, [floatingUsageEnabled, floatingUsageUpdating, loadFloatingUsageEnabled]);

  // Reload when the tray is reopened or accounts change elsewhere.
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlistenRefresh: (() => void) | undefined;
    let unlistenChanged: (() => void) | undefined;
    let unlistenUsage: (() => void) | undefined;
    let unlistenTheme: (() => void) | undefined;
    let unlistenAutoWarmup: (() => void) | undefined;

    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlistenRefresh = await listen(TRAY_REFRESH_EVENT, () => {
        syncThemeFromStorage();
        setAutoWarmupAllEnabled(readAutoWarmupAllEnabled());
        void load();
      });
      unlistenChanged = await listen(ACCOUNTS_CHANGED_EVENT, () => void load());
      unlistenUsage = await listen<UsageInfo[]>("usage-updated", ({ payload }) => {
        setUsageById((previous) => {
          const next = { ...previous };
          for (const usage of payload) {
            if (!usage.error || !next[usage.account_id]) {
              next[usage.account_id] = usage;
            }
          }
          return next;
        });
      });
      unlistenTheme = await listen<ThemeMode>(THEME_CHANGED_EVENT, ({ payload }) => {
        if (payload === "light" || payload === "dark") {
          applyTheme(payload);
        }
      });
      unlistenAutoWarmup = await listen<boolean>(
        AUTO_WARMUP_ALL_CHANGED_EVENT,
        ({ payload }) => {
          if (typeof payload === "boolean") {
            setAutoWarmupAllEnabled(payload);
          }
        }
      );
    })();

    return () => {
      unlistenRefresh?.();
      unlistenChanged?.();
      unlistenUsage?.();
      unlistenTheme?.();
      unlistenAutoWarmup?.();
    };
  }, [load]);

  const handleSwitch = useCallback(async (account: AccountInfo) => {
    if (account.auth_mode === "cookie") return;
    if (account.is_active) {
      void invokeBackend("hide_tray_window");
      return;
    }
    try {
      setSwitchingId(account.id);
      setError(null);
      await invokeBackend("switch_account", { accountId: account.id });
      // Notify the main window immediately so its active-account state stays in
      // sync without waiting on the backend accounts-file watcher (~1s poll).
      const { emit } = await import("@tauri-apps/api/event");
      await emit(ACCOUNTS_CHANGED_EVENT);
      void invokeBackend("hide_tray_window");
    } catch (err) {
      const message = formatError(err);
      // Codex is running: hand off to the main window's force-close flow.
      if (message.startsWith(CODEX_RUNNING_PREFIX)) {
        const { emit } = await import("@tauri-apps/api/event");
        await emit(SWITCH_ACCOUNT_BLOCKED_EVENT, {
          accountId: account.id,
          error: message,
        });
        void invokeBackend("open_main_window"); // focus main + hide tray
        return;
      }
      setError(message);
    } finally {
      setSwitchingId(null);
    }
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden rounded-xl border border-gray-200 bg-white text-gray-900 shadow-2xl dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100">
      <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2 dark:border-gray-800">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-black text-xs font-bold text-white">
          C
        </div>
        <span className="text-sm font-semibold">Codex Switcher</span>
        <button
          onClick={() => void handleAutoWarmupToggle()}
          disabled={accounts.length === 0}
          title={
            autoWarmupAllEnabled
              ? "关闭所有账户的自动预热"
              : "开启所有账户的自动预热"
          }
          className={`ml-auto rounded-md px-2 py-1 text-[11px] font-semibold transition-colors disabled:opacity-50 ${
            autoWarmupAllEnabled
              ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-900/20 dark:text-emerald-300 dark:hover:bg-emerald-900/30"
              : "bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          }`}
        >
          自动预热：{autoWarmupAllEnabled ? "开启" : "关闭"}
        </button>
        <button
          onClick={() => void handleRefresh()}
          disabled={refreshing}
          title="刷新额度"
          className="flex h-6 w-6 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
        >
          <span className={`text-base leading-none ${refreshing ? "inline-block animate-spin" : ""}`}>
            ↻
          </span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-1.5">
        {loading ? (
          <div className="px-2 py-6 text-center text-xs text-gray-500 dark:text-gray-400">
            正在加载…
          </div>
        ) : accounts.length === 0 ? (
          <div className="px-2 py-6 text-center text-xs text-gray-500 dark:text-gray-400">
            尚未添加账户
          </div>
        ) : (
          accounts.map((account) => {
            const planValue = formatPlan(account.plan_type) || (account.auth_mode === "cookie" ? "Cookie" : "");
            const plan = planValue === "Free" ? "免费" : planValue === "Cookie" ? "Cookie 账户" : planValue;
            const usage = usageById[account.id];
            const stats = statsById[account.id];
            const windows =
              usage && !usage.error
                ? ([
                    {
                      label: "5 小时",
                      used: usage.primary_used_percent,
                      resetAt: usage.primary_resets_at,
                    },
                    {
                      label: "每周",
                      used: usage.secondary_used_percent,
                      resetAt: usage.secondary_resets_at,
                    },
                  ].filter((w) => w.used != null) as {
                    label: string;
                    used: number;
                    resetAt: number | null;
                  }[])
                : [];

            return (
              <button
                key={account.id}
                onClick={() => void handleSwitch(account)}
                disabled={switchingId !== null || account.auth_mode === "cookie"}
                className={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors disabled:opacity-60 ${
                  account.is_active
                    ? "bg-gray-100 dark:bg-gray-800"
                    : "hover:bg-gray-100 dark:hover:bg-gray-800"
                }`}
              >
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                  {account.is_active && (
                    <svg
                      className="h-4 w-4 text-emerald-500"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                    >
                      <path
                        fillRule="evenodd"
                        d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 011.4-1.4l3.3 3.3 6.8-6.8a1 1 0 011.4 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {account.name}
                    </span>
                    {plan && (
                      <span className="shrink-0 rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-200">
                        {plan}
                      </span>
                    )}
                  </span>
                  {windows.length > 0 ? (
                    <span className="mt-1.5 block space-y-1.5">
                      {windows.map((w) => {
                        const remaining = Math.max(0, 100 - w.used);
                        const tone = remainingTone(remaining);
                        const reset = formatResetAt(w.resetAt);
                        const exactReset = formatExactResetTime(w.resetAt, w.label === "每周");
                        return (
                          <span key={w.label} className="block">
                            <span className="flex items-center gap-1">
                              <span className="text-[11px] font-medium text-gray-700 dark:text-gray-200">
                                {w.label}
                              </span>
                              <span
                                className={`h-1.5 w-1.5 rounded-full ${tone.dot}`}
                              />
                            </span>
                            <span className="mt-0.5 block h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800">
                              <span
                                className={`block h-full rounded-full ${tone.bar}`}
                                style={{ width: `${Math.min(remaining, 100)}%` }}
                              />
                            </span>
                            <span className="mt-0.5 flex justify-between text-[11px] text-gray-500 dark:text-gray-400">
                              <span className={tone.text}>
                                剩余 {remaining.toFixed(0)}%
                              </span>
                              {reset && (
                                <span className="shrink-0 whitespace-nowrap">
                                  {reset === "now" ? "现在重置" : `${reset}后重置`}
                                  {exactReset && ` • ${exactReset}`}
                                </span>
                              )}
                            </span>
                          </span>
                        );
                      })}
                    </span>
                  ) : usage?.error ? (
                    <span className="block truncate text-xs text-red-500 dark:text-red-400">
                      额度暂不可用
                    </span>
                  ) : account.email ? (
                    <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
                      {account.email}
                    </span>
                  ) : null}
                  {(account.is_active || account.auth_mode === "cookie") && (
                    <span className="mt-1 block text-[11px] text-gray-500 dark:text-gray-400">
                      余额：{formatCreditsBalance(usage?.credits_balance)}
                    </span>
                  )}
                  {account.is_active && stats?.available && (
                    <span className="mt-2 grid grid-cols-2 gap-1.5">
                      <span className="rounded-md bg-white px-2 py-1 text-[11px] text-gray-600 shadow-sm dark:bg-gray-950 dark:text-gray-300">
                        <span className="block font-medium text-gray-900 dark:text-gray-100">
                          {formatTokens(sumDailyTokens(stats, 1))}
                        </span>
                        <span>今天</span>
                      </span>
                      <span className="rounded-md bg-white px-2 py-1 text-[11px] text-gray-600 shadow-sm dark:bg-gray-950 dark:text-gray-300">
                        <span className="block font-medium text-gray-900 dark:text-gray-100">
                          {formatTokens(sumDailyTokens(stats, 7))}
                        </span>
                        <span>最近 7 天</span>
                      </span>
                    </span>
                  )}
                </span>
                {switchingId === account.id && (
                  <span className="shrink-0 text-xs text-gray-400">...</span>
                )}
              </button>
            );
          })
        )}
      </div>

      {error && (
        <div className="border-t border-gray-100 px-3 py-2 text-xs text-red-600 dark:border-gray-800 dark:text-red-400">
          {error}
        </div>
      )}

      {dockDisplayMode && (
        <div className="flex items-center gap-1 border-t border-gray-100 px-1.5 py-1.5 dark:border-gray-800">
          <span className="px-1.5 text-[11px] font-medium text-gray-500 dark:text-gray-400">
            程序坞
          </span>
          <button
            onClick={() => void handleDockDisplayMode("show_in_dock")}
            className={`rounded-md px-2 py-1 text-[11px] font-semibold transition-colors ${
              dockDisplayMode === "show_in_dock"
                ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
                : "bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
            }`}
          >
            显示
          </button>
          <button
            onClick={() => void handleDockDisplayMode("menu_bar_only")}
            className={`rounded-md px-2 py-1 text-[11px] font-semibold transition-colors ${
              dockDisplayMode === "menu_bar_only"
                ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
                : "bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
            }`}
          >
            菜单栏
          </button>
        </div>
      )}

      {floatingUsageEnabled !== null && (
        <div className="border-t border-gray-100 px-2 py-1.5 dark:border-gray-800">
          <button
            onClick={() => void handleFloatingUsageToggle()}
            disabled={floatingUsageUpdating}
            className="w-full rounded-md px-2 py-1 text-left text-xs text-gray-600 transition-colors hover:bg-gray-100 disabled:opacity-50 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            {floatingUsageUpdating ? "正在更新悬浮额度窗…" : floatingUsageEnabled ? "隐藏悬浮额度窗" : "显示悬浮额度窗"}
          </button>
        </div>
      )}

      <div className="flex items-center gap-1 border-t border-gray-100 p-1.5 dark:border-gray-800">
        <button
          onClick={() => void invokeBackend("open_main_window")}
          className="flex-1 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          打开 Codex Switcher
        </button>
        <button
          onClick={() => void invokeBackend("quit_app")}
          className="rounded-lg px-2 py-1.5 text-sm text-gray-500 transition-colors hover:bg-gray-100 hover:text-red-600 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-red-400"
        >
          退出程序
        </button>
      </div>
    </div>
  );
}

export default TrayMenu;
