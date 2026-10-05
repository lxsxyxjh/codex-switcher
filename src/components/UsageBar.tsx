import type { UsageInfo } from "../types";
import { formatCreditsBalance, formatQuotaResetTime, formatUsagePercent } from "../lib/usageDisplay";

interface UsageBarProps {
  usage?: UsageInfo;
  loading?: boolean;
}

function formatWindowDuration(minutes: number | null | undefined): string {
  if (!minutes) return "";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

function RateLimitBar({
  label,
  usedPercent,
  windowMinutes,
  resetsAt,
}: {
  label: string;
  usedPercent: number;
  windowMinutes?: number | null;
  resetsAt?: number | null;
}) {
  // Calculate remaining percentage
  const remainingPercent = Math.max(0, Math.min(100, 100 - usedPercent));
  
  // Color based on remaining (green = plenty left, red = almost none left)
  const colorClass =
    remainingPercent <= 10
      ? "bg-red-500"
      : remainingPercent <= 30
        ? "bg-amber-500"
        : "bg-emerald-500";

  const windowLabel = formatWindowDuration(windowMinutes);
  const resetLabel = formatQuotaResetTime(resetsAt);

  return (
    <div className="space-y-1">
      <div className="grid grid-cols-[1fr_auto] gap-2 text-xs text-gray-500 dark:text-gray-400">
        <span>{windowLabel ? `${windowLabel}额度` : label}</span>
        <span>剩余 {formatUsagePercent(usedPercent)}</span>
      </div>
      {resetLabel && <div className="text-xs text-gray-400 dark:text-gray-500">重置：{resetLabel}</div>}
      <div className="h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
        <div
          className={`h-full transition-all duration-300 ${colorClass}`}
          style={{ width: `${Math.min(remainingPercent, 100)}%` }}
        ></div>
      </div>
    </div>
  );
}

export function UsageBar({ usage, loading }: UsageBarProps) {
  if (loading && !usage) {
    return (
      <div className="space-y-2">
        <div className="text-xs text-gray-400 dark:text-gray-500 italic animate-pulse">
          正在获取额度…
        </div>
        <div className="h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden animate-pulse">
          <div className="h-full w-2/3 bg-gray-200 dark:bg-gray-700"></div>
        </div>
      </div>
    );
  }

  if (!usage) {
    return (
      <div className="text-xs text-gray-400 dark:text-gray-500 italic py-1 animate-pulse">
        正在获取额度…
      </div>
    );
  }

  const hasPrimary = typeof usage.primary_used_percent === "number" && Number.isFinite(usage.primary_used_percent);
  const hasSecondary = typeof usage.secondary_used_percent === "number" && Number.isFinite(usage.secondary_used_percent);
  const hasCredits = usage.credits_balance != null && usage.credits_balance.trim() !== "";
  const errorNotice = usage.error ? (
      <div title={usage.error} className="text-xs text-amber-600 dark:text-amber-400 py-1">
        {hasPrimary || hasSecondary || hasCredits ? "刷新失败，显示上次成功的额度。" : usage.error
          .replace(/^API error:\s*/i, "接口错误：")
          .replace(/Unauthorized/gi, "未授权")
          .replace(/Forbidden/gi, "禁止访问")
          .replace(/Not Found/gi, "未找到")}
      </div>
    ) : null;

  if (!hasPrimary && !hasSecondary && !hasCredits) {
    return errorNotice ?? (
      <div className="text-xs text-gray-400 dark:text-gray-500 italic py-1">
        暂无额度数据
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {errorNotice}
      {hasPrimary && (
        <RateLimitBar
          label="5 小时额度"
          usedPercent={usage.primary_used_percent!}
          windowMinutes={usage.primary_window_minutes}
          resetsAt={usage.primary_resets_at}
        />
      )}
      {hasSecondary && (
        <RateLimitBar
          label="每周额度"
          usedPercent={usage.secondary_used_percent!}
          windowMinutes={usage.secondary_window_minutes}
          resetsAt={usage.secondary_resets_at}
        />
      )}
      {hasCredits && (
        <div className="text-xs text-gray-500 dark:text-gray-400">
          余额：{formatCreditsBalance(usage.credits_balance)}
        </div>
      )}
    </div>
  );
}
