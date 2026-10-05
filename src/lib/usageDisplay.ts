import type { AccountInfo, UsageInfo } from "../types";

export function mergeUsageUpdate(previous: UsageInfo | undefined, update: UsageInfo): UsageInfo {
  return update.error && previous?.account_id === update.account_id
    ? { ...previous, error: update.error }
    : update;
}

export function getDisplayedUsageWindows(usage: Pick<UsageInfo, "primary_used_percent" | "primary_window_minutes" | "secondary_used_percent" | "secondary_window_minutes"> | undefined) {
  if (!usage) return [];
  return [
    { key: "primary", minutes: usage.primary_window_minutes, used: usage.primary_used_percent, fallback: "5h" },
    { key: "secondary", minutes: usage.secondary_window_minutes, used: usage.secondary_used_percent, fallback: "7d" },
  ].flatMap(({ key, minutes, used, fallback }) => typeof used === "number" && Number.isFinite(used)
    ? [{ key, label: formatUsageWindowLabel(minutes, fallback), used }]
    : []);
}

export function formatUsagePercent(used: number | null | undefined, showUsed = false): string {
  if (used === null || used === undefined || !Number.isFinite(used)) return "--";
  return `${Math.round(Math.max(0, Math.min(100, showUsed ? used : 100 - used)))}%`;
}

export function formatUsageWindowLabel(minutes: number | null | undefined, fallback: string): string {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return fallback;
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

export function formatQuotaResetTime(resetAt: number | null | undefined, nowMs = Date.now()): string {
  if (resetAt == null || !Number.isFinite(resetAt) || resetAt <= 0) return "";
  const date = new Date(resetAt * 1000);
  if (!Number.isFinite(date.getTime())) return "";
  const now = new Date(nowMs);
  const year = date.getFullYear() === now.getFullYear() ? "" : `${date.getFullYear()}年`;
  const time = `${year}${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const diff = resetAt - nowMs / 1000;
  if (diff <= 0) return `${time}（已到重置时间，等待额度更新）`;
  const days = Math.floor(diff / 86400);
  const hours = Math.floor(diff % 86400 / 3600);
  const minutes = Math.floor(diff % 3600 / 60);
  const remaining = days > 0 ? `${days}天${hours > 0 ? `${hours}小时` : ""}`
    : hours > 0 ? `${hours}小时${minutes > 0 ? `${minutes}分钟` : ""}`
    : diff >= 60 ? `${Math.floor(diff / 60)}分钟` : "不到1分钟";
  return `${time}（约${remaining}后）`;
}

export function formatCreditsBalance(balance: string | null | undefined): string {
  if (balance === null || balance === undefined || balance.trim() === "") return "--";

  const match = /^(\D*)([+-]?(?:\d+\.?\d*|\.\d+))(\D*)$/.exec(balance.trim());
  if (!match) return balance;

  const [, prefix, numericValue, suffix] = match;
  const value = Number(numericValue);
  if (!Number.isFinite(value)) return balance;

  const hasFraction = numericValue.includes(".");
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(value);

  return `${prefix}${formatted}${suffix}`;
}
export const usageRefreshIntervals = [
  { seconds: 30, label: "每 30 秒" },
  { seconds: 60, label: "每 1 分钟" },
  { seconds: 120, label: "每 2 分钟" },
  { seconds: 300, label: "每 5 分钟（默认）" },
  { seconds: 600, label: "每 10 分钟" },
];

export function getViewedAccount<T extends AccountInfo>(accounts: T[], accountId: string | null | undefined): T | undefined {
  return accounts.find((account) => account.id === accountId) ?? accounts.find((account) => account.is_active) ?? accounts.find((account) => account.auth_mode === "cookie") ?? accounts[0];
}
