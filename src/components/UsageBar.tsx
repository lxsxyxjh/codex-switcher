import type { UsageInfo } from "../types";
import { formatCreditsBalance, formatQuotaResetTime, formatUsagePercent, formatUsageError } from "../lib/usageDisplay";

interface UsageBarProps {
  usage?: UsageInfo;
  loading?: boolean;
  now?: number;
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
  now,
}: {
  label: string;
  usedPercent: number;
  windowMinutes?: number | null;
  resetsAt?: number | null;
  now?: number;
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
  const resetLabel = formatQuotaResetTime(resetsAt, now);

  return (
    <div className="space-y-2 py-2">
      <div className="grid grid-cols-[1fr_auto] items-start gap-3 text-xs text-gray-500 dark:text-gray-400">
        <div>
          <span>{windowLabel ? `${windowLabel}额度` : label}</span>
          {resetLabel && <span className="ml-3 inline-block text-gray-400 dark:text-gray-500">重置：{resetLabel}</span>}
        </div>
        <span>剩余 {formatUsagePercent(usedPercent)}</span>
      </div>
      <div className="h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
        <div
          className={`h-full transition-all duration-300 ${colorClass}`}
          style={{ width: `${Math.min(remainingPercent, 100)}%` }}
        ></div>
      </div>
    </div>
  );
}

export function UsageBar({ usage, loading, now }: UsageBarProps) {
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
      <div role="alert" className="break-words text-xs text-amber-600 dark:text-amber-400 py-1">
        <p>{formatUsageError(usage.error)}</p>
        {(hasPrimary || hasSecondary || hasCredits) && <p className="mt-1">当前显示上次成功获取的额度。</p>}
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
          now={now}
        />
      )}
      {hasSecondary && (
        <RateLimitBar
          label="每周额度"
          usedPercent={usage.secondary_used_percent!}
          windowMinutes={usage.secondary_window_minutes}
          resetsAt={usage.secondary_resets_at}
          now={now}
        />
      )}
      {hasCredits && (
        <div className="grid grid-cols-[max-content_max-content] items-center gap-3 py-4 text-xs text-gray-500 dark:text-gray-400">
          <span>剩余额度 <span className="text-gray-400 dark:text-gray-500">(Credits)</span></span>
          <strong className="text-sm font-medium tabular-nums text-gray-700 dark:text-gray-200">{formatCreditsBalance(usage.credits_balance)}</strong>
        </div>
      )}
    </div>
  );
}
