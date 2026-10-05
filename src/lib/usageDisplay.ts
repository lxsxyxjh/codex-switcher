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
