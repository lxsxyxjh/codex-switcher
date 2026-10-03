import { useCallback, useEffect, useState } from "react";
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

function remainingPercent(used: number | null | undefined): string {
  if (used === null || used === undefined || !Number.isFinite(used)) return "--";
  return `${Math.round(Math.max(0, Math.min(100, 100 - used)))}%`;
}

function FloatingUsage() {
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

      await Promise.all([loadAccounts(), loadCachedUsage()]);
    })();

    return () => {
      if (savePositionTimer !== undefined) window.clearTimeout(savePositionTimer);
      unlistenUsage?.();
      unlistenAccounts?.();
      unlistenTheme?.();
      unlistenMoved?.();
    };
  }, [applyUsageUpdates, loadAccounts, loadCachedUsage]);

  const activeAccount = accounts.find((account) => account.is_active);
  const usage = activeAccount ? usageById[activeAccount.id] : undefined;
  const isStale = activeAccount ? Boolean(staleById[activeAccount.id]) : false;
  const currentWindow = getTauriWindow();

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-transparent">
      <div
        onMouseDown={(event) => {
          if (event.button === 0) void currentWindow?.startDragging();
        }}
        title={isStale ? "Usage refresh failed; showing the last successful values" : undefined}
        className="flex h-11 w-full select-none items-center justify-between gap-2 overflow-hidden rounded-xl border border-gray-200 bg-white px-3 text-xs text-gray-700 shadow-lg dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
      >
        <span className="whitespace-nowrap font-medium tabular-nums">
          5h <span className="text-gray-900 dark:text-gray-100">{remainingPercent(usage?.primary_used_percent)}</span>
        </span>
        <span className="h-4 w-px shrink-0 bg-gray-200 dark:bg-gray-700" />
        <span className="whitespace-nowrap font-medium tabular-nums">
          7d <span className="text-gray-900 dark:text-gray-100">{remainingPercent(usage?.secondary_used_percent)}</span>
        </span>
        <span className="h-4 w-px shrink-0 bg-gray-200 dark:bg-gray-700" />
        <span className="flex min-w-0 items-center gap-1 whitespace-nowrap font-medium">
          {isStale && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />}
          <span>Credits</span>
          <span className="truncate font-semibold tabular-nums text-gray-900 dark:text-gray-100">
            {formatCreditsBalance(usage?.credits_balance)}
          </span>
        </span>
      </div>
    </div>
  );
}

export default FloatingUsage;
