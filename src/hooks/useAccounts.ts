import { useState, useEffect, useCallback, useRef } from "react";
import type {
  AccountInfo,
  UsageInfo,
  AccountWithUsage,
} from "../types";
import { mergeUsageUpdate } from "../lib/usageDisplay";
import { invokeBackend, isTauriRuntime, type FileSource } from "../lib/platform";

export function useAccounts() {
  const [accounts, setAccounts] = useState<AccountWithUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const accountsRef = useRef<AccountWithUsage[]>([]);
  const metadataRefreshInFlightRef = useRef(new Set<string>());
  const loadSequence = useRef(0);
  const usageInFlight = useRef(new Map<string, Promise<UsageInfo>>());

  useEffect(() => {
    accountsRef.current = accounts;
  }, [accounts]);

  const buildUsageError = useCallback(
    (accountId: string, message: string, planType: string | null): UsageInfo => ({
      account_id: accountId,
      plan_type: planType,
      primary_used_percent: null,
      primary_window_minutes: null,
      primary_resets_at: null,
      secondary_used_percent: null,
      secondary_window_minutes: null,
      secondary_resets_at: null,
      has_credits: null,
      unlimited_credits: null,
      credits_balance: null,
      error: message,
    }),
    []
  );

  const runSequentially = useCallback(async <T,>(items: T[], worker: (item: T) => Promise<void>) => {
    for (const item of items) await worker(item);
  }, []);

  const loadAccounts = useCallback(async () => {
    const sequence = ++loadSequence.current;
    try {
      setLoading(true);
      setError(null);
      const [accountList, cached] = await Promise.all([
        invokeBackend<AccountInfo[]>("list_accounts"),
        isTauriRuntime() ? invokeBackend<UsageInfo[]>("get_cached_usage") : Promise.resolve([]),
      ]);
      if (sequence !== loadSequence.current) return [];
      const cachedById = new Map(cached.map((usage) => [usage.account_id, usage]));

      // Preserve existing usage data when just updating account info
      setAccounts((prev) => {
        const usageMap = new Map(
          prev.map((a) => [a.id, { usage: a.usage, usageLoading: a.usageLoading }])
        );
        return accountList.map((a) => ({
          ...a,
          usage: usageMap.get(a.id)?.usage ?? cachedById.get(a.id),
          usageLoading: usageMap.get(a.id)?.usageLoading,
        }));
      });
      return accountList.map((account) => ({ ...account, usage: accountsRef.current.find((item) => item.id === account.id)?.usage ?? cachedById.get(account.id) }));
    } catch (err) {
      if (sequence === loadSequence.current) setError(err instanceof Error ? err.message : String(err));
      return [];
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, []);

  const refreshMetadata = useCallback(
    async (
      accountList?: AccountInfo[] | AccountWithUsage[]
    ) => {
      const list = accountList ?? accountsRef.current;
      const dueAccounts = list.filter(
        (account) => !metadataRefreshInFlightRef.current.has(account.id)
      );

      // Mark attempts before starting requests so overlapping refresh cycles
      // cannot issue duplicate metadata calls for the same account.
      dueAccounts.forEach((account) => {
        metadataRefreshInFlightRef.current.add(account.id);
      });

      await runSequentially(
        dueAccounts,
        async (account) => {
          try {
            const metadata = await invokeBackend<AccountInfo>("refresh_account_metadata", {
              accountId: account.id,
            });
            setAccounts((prev) =>
              prev.map((item) =>
                item.id === account.id
                  ? {
                      ...item,
                      plan_type: metadata.plan_type,
                      subscription_expires_at: metadata.subscription_expires_at,
                    }
                  : item
              )
            );
          } catch (err) {
            console.warn("Failed to refresh account metadata:", err);
          } finally {
            metadataRefreshInFlightRef.current.delete(account.id);
          }
        }
      );
    },
    [runSequentially]
  );

  const refreshSingleUsage = useCallback(async (
    accountId: string, source = "账户按钮"
  ) => {
    const pending = usageInFlight.current.get(accountId);
    if (pending) return pending;
    const request = (async () => {
      try {
        setAccounts((prev) =>
          prev.map((a) =>
            a.id === accountId ? { ...a, usageLoading: true } : a
          )
        );
        const usage = await invokeBackend<UsageInfo>("get_usage", { accountId, source });
        setAccounts((prev) =>
          prev.map((a) =>
            a.id === accountId ? { ...a, usage: mergeUsageUpdate(a.usage, usage), usageLoading: false } : a
          )
        );

        return usage;
      } catch (err) {
        console.error("Failed to refresh single usage:", err);
        const message = err instanceof Error ? err.message : String(err);
        const failedUsage = buildUsageError(
          accountId,
          message,
          accountsRef.current.find((account) => account.id === accountId)?.plan_type ?? null
        );
        setAccounts((prev) =>
          prev.map((a) =>
            a.id === accountId
              ? {
                  ...a,
                  usage: mergeUsageUpdate(a.usage, failedUsage),
                  usageLoading: false,
                }
              : a
          )
        );
        throw err;
      }
      finally { usageInFlight.current.delete(accountId); }
    })();
    usageInFlight.current.set(accountId, request);
    return request;
  }, [buildUsageError]);

  const refreshUsage = useCallback(async (accountList?: AccountInfo[] | AccountWithUsage[], source = "刷新所有") => {
    const list = accountList ?? accountsRef.current;
    const ids = new Set(list.map((account) => account.id));
    setAccounts((previous) => previous.map((account) => ids.has(account.id) ? { ...account, usageLoading: true } : account));
    for (const account of list) {
      try { await refreshSingleUsage(account.id, source); }
      catch (error) { console.warn("Failed to refresh account usage:", error); }
    }
  }, [refreshSingleUsage]);

  const deleteAccount = useCallback(
    async (accountId: string) => {
      try {
        await invokeBackend("delete_account", { accountId });
        // Account activation can change while deletion is in flight. Re-read
        // backend metadata without discarding the latest cached usage.
        await loadAccounts();
      } catch (err) {
        throw err;
      }
    },
    [loadAccounts]
  );

  const renameAccount = useCallback(
    async (accountId: string, newName: string) => {
      try {
        await invokeBackend("rename_account", { accountId, newName });
        await loadAccounts(); // Preserve usage data
      } catch (err) {
        throw err;
      }
    },
    [loadAccounts]
  );

  const importFromFile = useCallback(
    async (source: FileSource, name: string) => {
      try {
        let added: AccountInfo;
        if (typeof source === "string") {
          added = await invokeBackend<AccountInfo>("add_account_from_file", { path: source, name });
        } else {
          const contents = await source.text();
          added = await invokeBackend<AccountInfo>("add_account_from_auth_json_text", {
            name,
            contents,
          });
        }
        await loadAccounts();
        await refreshSingleUsage(added.id, "导入登录文件");
      } catch (err) {
        throw err;
      }
    },
    [loadAccounts, refreshSingleUsage]
  );

  const importFromCookie = useCallback(
    async (cookie: string, name: string) => {
      const added = await invokeBackend<{ account: AccountInfo; usage: UsageInfo }>(
        "add_account_from_cookie",
        { cookie, name }
      );
      await loadAccounts();
      setAccounts((current) =>
        current.map((account) =>
          account.id === added.account.id
            ? { ...account, usage: added.usage, usageLoading: false }
            : account
        )
      );
    },
    [loadAccounts]
  );

  const startOAuthLogin = useCallback(async (accountName: string) => {
    try {
      const info = await invokeBackend<{ auth_url: string; callback_port: number }>(
        "start_login",
        { accountName }
      );
      return info;
    } catch (err) {
      throw err;
    }
  }, []);

  const completeOAuthLogin = useCallback(async () => {
    try {
      const account = await invokeBackend<AccountInfo>("complete_login");
      await loadAccounts();
      await refreshSingleUsage(account.id, "添加登录账户");
      return account;
    } catch (err) {
      throw err;
    }
  }, [loadAccounts, refreshSingleUsage]);

  const cancelOAuthLogin = useCallback(async () => {
    try {
      await invokeBackend("cancel_login");
    } catch (err) {
      console.error("Failed to cancel login:", err);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    void loadAccounts().then((list) => {
      if (disposed) return;
      void refreshUsage(list.filter((account) => !account.usage), "启动加载");
      if (!isTauriRuntime()) void refreshMetadata(list);
    });
    const metadataInterval = !isTauriRuntime() ? setInterval(() => { void refreshMetadata(); }, 6 * 60 * 60 * 1000) : undefined;
    return () => { disposed = true; if (metadataInterval !== undefined) clearInterval(metadataInterval); };
  }, [loadAccounts, refreshMetadata, refreshUsage]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let unlistenUsage: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      if (!("__TAURI_INTERNALS__" in window)) return;
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen("accounts-changed", () => {
        void loadAccounts();
      });
      unlistenUsage = await listen<UsageInfo[]>("usage-updated", ({ payload }) => {
        const updates = new Map(payload.map((usage) => [usage.account_id, usage]));
        setAccounts((previous) => previous.map((account) => {
          const usage = updates.get(account.id);
          if (!usage) return account;
          return {
            ...account,
            usage: mergeUsageUpdate(account.usage, usage),
            usageLoading: false,
          };
        }));
      });
      if (cancelled) {
        unlisten();
        unlistenUsage();
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
      unlistenUsage?.();
    };
  }, [loadAccounts]);

  return {
    accounts,
    loading,
    error,
    loadAccounts,
    refreshUsage,
    refreshSingleUsage,
    deleteAccount,
    renameAccount,
    importFromFile,
    importFromCookie,
    startOAuthLogin,
    completeOAuthLogin,
    cancelOAuthLogin,
  };
}
