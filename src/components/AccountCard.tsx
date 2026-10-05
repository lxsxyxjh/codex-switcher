import { useState, useRef, useEffect } from "react";
import type { AccountWithUsage } from "../types";
import { invokeBackend, isTauriRuntime } from "../lib/platform";
import { usageRefreshIntervals } from "../lib/usageDisplay";
import { UsageBar } from "./UsageBar";


interface AccountCardProps {
  account: AccountWithUsage;
  selected: boolean;
  floatingEnabled: boolean;
  refreshInterval: number;
  onSelect: () => void;
  onDelete: () => void;
  onRefresh: () => Promise<unknown>;
  onRename: (newName: string) => Promise<void>;
}

function formatLastRefresh(date: Date | null): string {
  if (!date) return "从未刷新";
  const now = new Date();
  const diff = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (diff < 5) return "刚刚";
  if (diff < 60) return `${diff} 秒前`;
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return date.toLocaleDateString("zh-CN");
}

function getSubscriptionStatus(timestamp: string | null | undefined): {
  label: string;
  className: string;
} {
  if (!timestamp) {
    return {
      label: "到期时间不可用",
      className: "text-gray-400 dark:text-gray-500",
    };
  }

  const expiryDate = new Date(timestamp);
  const formattedDate = new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(expiryDate);

  const remainingMs = expiryDate.getTime() - Date.now();
  if (remainingMs <= 0) {
    return {
      label: `已于 ${formattedDate} 到期`,
      className: "text-red-500 dark:text-red-400",
    };
  }

  if (remainingMs <= 3 * 24 * 60 * 60 * 1000) {
    return {
      label: `有效至 ${formattedDate}`,
      className: "text-red-500 dark:text-red-400",
    };
  }

  if (remainingMs <= 7 * 24 * 60 * 60 * 1000) {
    return {
      label: `有效至 ${formattedDate}`,
      className: "text-amber-500 dark:text-amber-400",
    };
  }

  return {
    label: `有效至 ${formattedDate}`,
    className: "text-gray-400 dark:text-gray-500",
  };
}

export function AccountCard({
  account,
  selected,
  floatingEnabled,
  refreshInterval,
  onSelect,
  onDelete,
  onRefresh,
  onRename,
}: AccountCardProps) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const floatingDisplayed = selected && floatingEnabled;
  const autoRefreshActive = floatingDisplayed && account.auth_mode !== "api_key";
  const [intervalSaving, setIntervalSaving] = useState(false);
  const [intervalError, setIntervalError] = useState<string | null>(null);
  const changeInterval = async (seconds: number) => {
    setIntervalSaving(true);
    setIntervalError(null);
    try {
      await invokeBackend("set_usage_refresh_interval", { accountId: account.id, seconds });
    } catch (error) { setIntervalError(String(error)); }
    finally { setIntervalSaving(false); }
  };
  const [lastRefresh, setLastRefresh] = useState<Date | null>(
    account.usage && !account.usage.error ? new Date() : null
  );
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(account.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  useEffect(() => {
    if (account.usage && !account.usage.error) {
      setLastRefresh(new Date());
    }
  }, [account.usage]);

  const handleRefresh = async () => {
    if (isRefreshing || account.usageLoading) return;
    setIsRefreshing(true);
    try {
      await onRefresh();
    } catch (error) {
      console.error("Failed to refresh account usage:", error);
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleRename = async () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== account.name) {
      try {
        await onRename(trimmed);
      } catch {
        setEditName(account.name);
      }
    } else {
      setEditName(account.name);
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleRename();
    } else if (e.key === "Escape") {
      setEditName(account.name);
      setIsEditing(false);
    }
  };

  const planDisplay = account.plan_type
    ? account.plan_type.toLowerCase() === "free"
      ? "免费"
      : account.plan_type.charAt(0).toUpperCase() + account.plan_type.slice(1)
    : account.auth_mode === "api_key"
      ? "API 密钥"
      : account.auth_mode === "cookie"
        ? "Cookie 账户"
        : "未知";

  const planColors: Record<string, string> = {
    pro: "bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-300 dark:border-indigo-700",
    plus: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-700",
    team: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700",
    enterprise: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700",
    free: "bg-gray-50 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700",
    api_key: "bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-900/30 dark:text-orange-300 dark:border-orange-700",
    cookie: "bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-900/30 dark:text-sky-300 dark:border-sky-700",
  };

  const planKey = account.plan_type?.toLowerCase() || (account.auth_mode === "cookie" ? "cookie" : "api_key");
  const planColorClass = planColors[planKey] || planColors.free;
  const showSubscriptionStatus =
    account.auth_mode === "chat_g_p_t" && account.plan_type?.toLowerCase() !== "free";
  const subscriptionStatus = getSubscriptionStatus(account.subscription_expires_at);
  return (
    <div
      className={`relative rounded-xl border p-5 transition-all duration-200 ${
        selected
          ? "bg-white dark:bg-gray-900 border-emerald-400 shadow-sm"
          : "bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600"
      }`}
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            {selected && (
              <span className="flex h-2 w-2">
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
              </span>
            )}
            {isEditing ? (
              <input
                ref={inputRef}
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={handleRename}
                onKeyDown={handleKeyDown}
                className="font-semibold text-gray-900 dark:text-gray-100 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded border border-gray-300 dark:border-gray-700 focus:outline-none focus:border-gray-500 dark:focus:border-gray-500 w-full"
              />
            ) : (
              <h3
                className="font-semibold text-gray-900 dark:text-gray-100 truncate cursor-pointer hover:text-gray-600 dark:hover:text-gray-300"
                onClick={() => {
                  setEditName(account.name);
                  setIsEditing(true);
                }}
                title="点击修改名称"
              >
                {account.name}
              </h3>
            )}
          </div>
          <p className="text-xs text-gray-400 dark:text-gray-500">{account.auth_mode === "cookie" ? "Cookie · 额度查看" : account.auth_mode === "chat_g_p_t" ? "Codex 登录" : "API Key"}</p>
          {account.email && account.email !== account.name && (
            <p className="text-sm text-gray-500 dark:text-gray-400 truncate">
              {account.email}
            </p>
          )}
        </div>

        <div className="flex max-w-[60%] flex-wrap items-center justify-end gap-2">
          {/* Refresh */}
          <button
            onClick={handleRefresh}
            disabled={isRefreshing || account.usageLoading}
            className="p-1 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors disabled:opacity-50"
            title="刷新额度"
          >
            <span className={`inline-block h-4 w-4 text-base leading-none ${isRefreshing ? "animate-spin" : ""}`}>↻</span>
          </button>
          {/* Plan badge */}
          <span
            className={`px-2.5 py-1 text-xs font-medium rounded-full border ${planColorClass}`}
          >
            {planDisplay}
          </span>
          {floatingDisplayed && <span className="text-xs text-sky-600 dark:text-sky-400">悬浮窗显示中</span>}
        </div>
      </div>

      {/* Usage */}
      <div className="mb-3">
        <UsageBar usage={account.usage} loading={isRefreshing || account.usageLoading} />
        {isTauriRuntime() && <label className="mt-3 inline-block text-xs text-gray-500">{autoRefreshActive ? "自动刷新（悬浮窗显示中）" : "仅手动刷新"} {autoRefreshActive && <select aria-label={`${account.name}自动刷新间隔`} value={refreshInterval} disabled={intervalSaving} onChange={(event) => { void changeInterval(Number(event.target.value)); }} className="ml-2 rounded-lg border border-gray-200 bg-transparent px-2 py-1 dark:border-gray-700">{usageRefreshIntervals.map(({ seconds, label }) => <option key={seconds} value={seconds}>{label}</option>)}</select>}</label>}
        {intervalError && <p role="alert" className="text-xs text-red-500">{intervalError}</p>}
      </div>

      {/* Last refresh time */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs mb-3">
        <div className="text-gray-400 dark:text-gray-500">
          最近更新：{formatLastRefresh(lastRefresh)}
        </div>
        {showSubscriptionStatus && (
          <div className={`text-right ${subscriptionStatus.className}`}>
            {subscriptionStatus.label}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-2 mt-3">
        <button onClick={onSelect} disabled={selected} className="grow rounded-lg bg-sky-50 px-4 py-2 text-sm text-sky-700 disabled:opacity-60 dark:bg-sky-900/20 dark:text-sky-300">{selected ? "当前查看账户" : "查看此账户额度"}</button>
        <button
          onClick={onDelete}
          className="px-3 py-2 text-sm rounded-lg bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/40 text-red-600 dark:text-red-300 transition-colors"
          title="删除账户"
        >
          ✕
        </button>
      </div>

    </div>
  );
}
