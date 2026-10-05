import { useState, useEffect, useCallback, useRef } from "react";
import type {
  AccountInfo,
  UsageInfo,
  AccountWithUsage,
  WarmupSummary,
  ImportAccountsSummary,
} from "../types";
import { mergeUsageUpdate } from "../lib/usageDisplay";
import { invokeBackend, isTauriRuntime, type FileSource } from "../lib/platform";

export function useAccounts() {
  const [accounts, setAccounts] = useState<AccountWithUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const accountsRef = useRef<AccountWithUsage[]>([]);
  const metadataRefreshInFlightRef = useRef(new Set<string>());
  const maxConcurrentUsageRequests = 10;

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

  const runWithConcurrency = useCallback(
    async <T,>(
      items: T[],
      worker: (item: T) => Promise<void>,
      concurrency: number
    ) => {
      if (items.length === 0) return;
      const limit = Math.min(Math.max(concurrency, 1), items.length);
      let index = 0;
      const runners = Array.from({ length: limit }, async () => {
        while (true) {
          const current = index++;
          if (current >= items.length) return;
          await worker(items[current]);
        }
      });
      await Promise.allSettled(runners);
    },
    []
  );

  const loadAccounts = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const accountList = await invokeBackend<AccountInfo[]>("list_accounts");
      
      // Preserve existing usage data when just updating account info
      setAccounts((prev) => {
        const usageMap = new Map(
          prev.map((a) => [a.id, { usage: a.usage, usageLoading: a.usageLoading }])
        );
        return accountList.map((a) => ({
          ...a,
          usage: usageMap.get(a.id)?.usage,
          usageLoading: usageMap.get(a.id)?.usageLoading,
        }));
      });
      return accountList;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return [];
    } finally {
      setLoading(false);
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

      await runWithConcurrency(
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
        },
        maxConcurrentUsageRequests
      );
    },
    [maxConcurrentUsageRequests, runWithConcurrency]
  );

  const refreshUsage = useCallback(
    async (
      accountList?: AccountInfo[] | AccountWithUsage[],
      options?: { refreshMetadata?: boolean }
    ) => {
      try {
        const list = accountList ?? accountsRef.current;
        if (list.length === 0) {
          return;
        }

        // Explicit refreshes include metadata, but run it beside usage so a
        // slow accounts endpoint never delays healthy rate-limit updates.
        const metadataPromise = options?.refreshMetadata
          ? refreshMetadata(list)
          : Promise.resolve();

        const accountIds = list.map((account) => account.id);
        const accountIdSet = new Set(accountIds);
        const usageResults = new Map<string, UsageInfo>();

        setAccounts((prev) =>
          prev.map((account) =>
            accountIdSet.has(account.id)
              ? { ...account, usageLoading: true }
              : account
          )
        );

        await runWithConcurrency(
          list,
          async (account) => {
            try {
              const usage = await invokeBackend<UsageInfo>("get_usage", {
                accountId: account.id,
              });
              usageResults.set(account.id, usage);
            } catch (err) {
              console.error("Failed to refresh usage:", err);
              const message = err instanceof Error ? err.message : String(err);
              usageResults.set(
                account.id,
                buildUsageError(account.id, message, account.plan_type ?? null)
              );
            }
          },
          maxConcurrentUsageRequests
        );

        setAccounts((prev) =>
          prev.map((account) => {
            const usage = usageResults.get(account.id);
            if (!usage) return account;
            return {
              ...account,
              usage: mergeUsageUpdate(account.usage, usage),
              usageLoading: false,
            };
          })
        );
        await metadataPromise;
      } catch (err) {
        console.error("Failed to refresh usage:", err);
        throw err;
      }
    },
    [
      buildUsageError,
      maxConcurrentUsageRequests,
      refreshMetadata,
      runWithConcurrency,
    ]
  );

  const refreshSingleUsage = useCallback(async (
    accountId: string,
    options?: { refreshMetadata?: boolean }
  ) => {
    try {
      const account = accountsRef.current.find((item) => item.id === accountId);
      const metadataPromise = options?.refreshMetadata && account
        ? refreshMetadata([account])
        : Promise.resolve();

      setAccounts((prev) =>
        prev.map((a) =>
          a.id === accountId ? { ...a, usageLoading: true } : a
        )
      );
      const usage = await invokeBackend<UsageInfo>("get_usage", { accountId });
      setAccounts((prev) =>
        prev.map((a) =>
          a.id === accountId ? { ...a, usage: mergeUsageUpdate(a.usage, usage), usageLoading: false } : a
        )
      );
      await metadataPromise;
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
  }, [buildUsageError, refreshMetadata]);

  const warmupAccount = useCallback(async (accountId: string) => {
    try {
      await invokeBackend("warmup_account", { accountId });
    } catch (err) {
      console.error("Failed to warm up account:", err);
      throw err;
    }
  }, []);

  const warmupAllAccounts = useCallback(async () => {
    try {
      return await invokeBackend<WarmupSummary>("warmup_all_accounts");
    } catch (err) {
      console.error("Failed to warm up all accounts:", err);
      throw err;
    }
  }, []);

  const switchAccount = useCallback(
    async (accountId: string) => {
      try {
        await invokeBackend("switch_account", { accountId });
        await loadAccounts(); // Preserve usage data
      } catch (err) {
        throw err;
      }
    },
    [loadAccounts]
  );

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
        if (typeof source === "string") {
          await invokeBackend<AccountInfo>("add_account_from_file", { path: source, name });
        } else {
          const contents = await source.text();
          await invokeBackend<AccountInfo>("add_account_from_auth_json_text", {
            name,
            contents,
          });
        }
        const accountList = await loadAccounts();
        await refreshUsage(accountList);
      } catch (err) {
        throw err;
      }
    },
    [loadAccounts, refreshUsage]
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
      const accountList = await loadAccounts();
      await refreshUsage(accountList);
      return account;
    } catch (err) {
      throw err;
    }
  }, [loadAccounts, refreshUsage]);

  const exportAccountsFullEncryptedFile = useCallback(
    async (path: string) => {
      try {
        await invokeBackend("export_accounts_full_encrypted_file", { path });
      } catch (err) {
        throw err;
      }
    },
    []
  );

  const importAccountsFullEncryptedFile = useCallback(
    async (path: string) => {
      try {
        const summary = await invokeBackend<ImportAccountsSummary>(
          "import_accounts_full_encrypted_file",
          { path }
        );
        const accountList = await loadAccounts();
        await refreshUsage(accountList);
        return summary;
      } catch (err) {
        throw err;
      }
    },
    [loadAccounts, refreshUsage]
  );

  const cancelOAuthLogin = useCallback(async () => {
    try {
      await invokeBackend("cancel_login");
    } catch (err) {
      console.error("Failed to cancel login:", err);
    }
  }, []);

  useEffect(() => {
    loadAccounts().then((accountList) => {
      void refreshUsage(accountList);
      if (!isTauriRuntime()) void refreshMetadata(accountList);
    });
    
    // Desktop refreshes are published by Rust; browser mode owns its timer.
    const usageInterval = !isTauriRuntime()
      ? setInterval(() => {
          refreshUsage().catch(() => {});
        }, 5 * 60 * 1000)
      : undefined;

    const metadataInterval = !isTauriRuntime()
      ? setInterval(() => {
          refreshMetadata().catch(() => {});
        }, 6 * 60 * 60 * 1000)
      : undefined;
    
    return () => {
      if (usageInterval !== undefined) clearInterval(usageInterval);
      if (metadataInterval !== undefined) clearInterval(metadataInterval);
    };
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
    warmupAccount,
    warmupAllAccounts,
    switchAccount,
    deleteAccount,
    renameAccount,
    importFromFile,
    importFromCookie,
    exportAccountsFullEncryptedFile,
    importAccountsFullEncryptedFile,
    startOAuthLogin,
    completeOAuthLogin,
    cancelOAuthLogin,
  };
}
