import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AccountDailyUsage,
  AccountTopInvocation,
  AccountUsageStats as AccountUsageStatsInfo,
  UsageInfo,
} from "../types";
import { invokeBackend } from "../lib/platform";

interface AccountUsageStatsProps {
  accountId: string;
  enabled: boolean;
  open: boolean;
  usage?: UsageInfo;
  usageLoading?: boolean;
  onStatsLoaded?: (stats: AccountUsageStatsInfo | null) => void;
}

function emptyStats(accountId: string, error: string): AccountUsageStatsInfo {
  return {
    account_id: accountId,
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
    error,
  };
}

function formatTokens(tokens: number | null | undefined): string {
  if (tokens === null || tokens === undefined || !Number.isFinite(tokens)) return "--";
  const abs = Math.abs(tokens);
  if (abs >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return `${tokens}`;
}

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  return new Intl.NumberFormat().format(value);
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  return `${Math.round(value)}%`;
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "--";
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return minutes > 0 ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
}

function formatDateLabel(date: string): string {
  const parsed = new Date(`${date}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(parsed);
}

function formatGeneratedAt(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return "刚刚";
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))} 小时前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
}

function dayKey(offset: number): string {
  const date = new Date();
  date.setDate(date.getDate() - offset);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function sumDays(daily: AccountDailyUsage[], days: number): number {
  const keys = new Set(Array.from({ length: days }, (_, index) => dayKey(index)));
  return daily.reduce((total, day) => (keys.has(day.date) ? total + day.tokens : total), 0);
}

type ActivityRange = 30 | 90 | 180 | "all";

const ACTIVITY_RANGE_OPTIONS: { value: ActivityRange; label: string }[] = [
  { value: 30, label: "30 天" },
  { value: 90, label: "3 个月" },
  { value: 180, label: "6 个月" },
  { value: "all", label: "全部" },
];

function activityRangeDays(range: ActivityRange, daily: AccountDailyUsage[]): number {
  if (range !== "all") return range;
  return Math.max(30, daily.length);
}

function activityRangeLabel(range: ActivityRange): string {
  switch (range) {
    case 30:
      return "最近 30 天";
    case 90:
      return "最近 3 个月";
    case 180:
      return "最近 6 个月";
    case "all":
      return "全部数据";
  }
}

function recentDailyBars(daily: AccountDailyUsage[], range: ActivityRange): AccountDailyUsage[] {
  if (range === "all") {
    return [...daily].sort((a, b) => a.date.localeCompare(b.date));
  }

  const byDate = new Map(daily.map((day) => [day.date, day.tokens]));
  return Array.from({ length: range }, (_, index) => {
    const date = dayKey(range - index - 1);
    return { date, tokens: byDate.get(date) ?? 0 };
  });
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-800 dark:bg-gray-950/50">
      <div className="truncate text-[11px] font-medium text-gray-500 dark:text-gray-400">
        {label}
      </div>
      <div className="mt-1 truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
        {value}
      </div>
      {sub && (
        <div className="mt-0.5 truncate text-[11px] text-gray-500 dark:text-gray-400">
          {sub}
        </div>
      )}
    </div>
  );
}

function TokenActivity({ daily }: { daily: AccountDailyUsage[] }) {
  const [range, setRange] = useState<ActivityRange>(30);
  const [hoveredDate, setHoveredDate] = useState<string | null>(null);
  const bars = useMemo(() => recentDailyBars(daily, range), [daily, range]);
  const rangeDays = activityRangeDays(range, daily);
  const maxTokens = Math.max(1, ...bars.map((day) => day.tokens));

  if (bars.length === 0 || !bars.some((day) => day.tokens > 0)) {
    return (
      <div className="flex h-14 items-center justify-center rounded-lg border border-dashed border-gray-200 text-[11px] text-gray-400 dark:border-gray-800 dark:text-gray-500">
        暂无每日活动数据
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white px-3 pb-3 pt-2 dark:border-gray-800 dark:bg-gray-950/40">
      <div className="mb-2 flex items-center justify-between text-[11px]">
        <span className="font-medium text-gray-600 dark:text-gray-300">Token 活动</span>
        <div className="flex items-center gap-2">
          <span className="text-gray-400 dark:text-gray-500">{activityRangeLabel(range)}</span>
          <select
            value={range}
            onChange={(event) => {
              const value = event.target.value;
              setRange(value === "all" ? "all" : (Number(value) as ActivityRange));
            }}
            className="h-6 rounded-md border border-gray-200 bg-gray-50 px-1.5 text-[11px] text-gray-600 outline-none dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300"
            aria-label="Token 活动范围"
          >
            {ACTIVITY_RANGE_OPTIONS.map((option) => (
              <option key={option.label} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div
        className="relative grid h-14 grid-flow-col auto-cols-fr items-end gap-px sm:gap-1"
        onMouseLeave={() => setHoveredDate(null)}
      >
        {bars.map((day) => {
          const height = day.tokens > 0 ? Math.max(8, Math.round((day.tokens / maxTokens) * 52)) : 3;
          const isEmpty = day.tokens === 0;
          const maxWidth = rangeDays > 90 ? "max-w-1.5" : rangeDays > 45 ? "max-w-2" : "max-w-3";
          const isHovered = hoveredDate === day.date;
          return (
            <div
              key={day.date}
              className="relative flex h-14 items-end justify-center"
              onMouseEnter={() => setHoveredDate(day.date)}
            >
              {isHovered && (
                <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 min-w-max -translate-x-1/2 rounded-md bg-gray-950 px-2 py-1 text-[11px] text-white shadow-lg dark:bg-gray-100 dark:text-gray-950">
                  {formatDateLabel(day.date)} · {formatTokens(day.tokens)}
                </div>
              )}
              <div
                className={`w-full ${maxWidth} rounded-t transition-colors ${
                  isEmpty
                    ? "bg-gray-200 dark:bg-gray-800"
                    : "bg-blue-500 hover:bg-blue-400"
                }`}
                style={{ height }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DetailPanel({
  activity,
  thirtyDayTokens,
  summary,
  topInvocations,
}: {
  activity: AccountUsageStatsInfo["activity"];
  thirtyDayTokens: number | null;
  summary: AccountUsageStatsInfo["summary"];
  topInvocations: AccountTopInvocation[];
}) {
  const hasActivity =
    activity.fast_mode_percent !== null ||
    activity.reasoning_effort !== null ||
    activity.skills_explored !== null ||
    activity.total_threads !== null;
  const [open, setOpen] = useState(false);

  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="rounded-lg border border-gray-200 bg-gray-50 transition-colors dark:border-gray-800 dark:bg-gray-950/50"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between rounded-lg px-3 py-2 text-[12px] font-semibold text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-900">
        更多使用详情
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-white text-gray-500 transition-colors dark:bg-gray-900 dark:text-gray-400">
          <svg
            className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
              clipRule="evenodd"
            />
          </svg>
        </span>
      </summary>
      <div className="grid gap-3 border-t border-gray-200 p-3 dark:border-gray-800 sm:grid-cols-2">
        <div className="grid grid-cols-3 gap-2 sm:col-span-2">
          <StatTile label="最近 30 天" value={formatTokens(thirtyDayTokens)} sub="已报告" />
          <StatTile label="最长任务" value={formatDuration(summary.longest_task_seconds)} />
          <StatTile label="最长连续使用" value={`${formatNumber(summary.longest_streak_days)} 天`} />
        </div>

        {hasActivity && (
          <div className="space-y-1.5">
            <div className="mb-1 text-[11px] font-semibold text-gray-600 dark:text-gray-300">
              活动概览
            </div>
            <div className="flex justify-between gap-2 text-[11px]">
              <span className="text-gray-500 dark:text-gray-400">快速模式</span>
              <span className="text-gray-800 dark:text-gray-100">{formatPercent(activity.fast_mode_percent)}</span>
            </div>
            <div className="flex justify-between gap-2 text-[11px]">
              <span className="text-gray-500 dark:text-gray-400">推理</span>
              <span className="text-gray-800 dark:text-gray-100">
                {activity.reasoning_effort ?? "--"}
                {activity.reasoning_effort_percent !== null && ` · ${formatPercent(activity.reasoning_effort_percent)}`}
              </span>
            </div>
            <div className="flex justify-between gap-2 text-[11px]">
              <span className="text-gray-500 dark:text-gray-400">探索的技能</span>
              <span className="text-gray-800 dark:text-gray-100">{formatNumber(activity.skills_explored)}</span>
            </div>
            <div className="flex justify-between gap-2 text-[11px]">
              <span className="text-gray-500 dark:text-gray-400">会话总数</span>
              <span className="text-gray-800 dark:text-gray-100">{formatNumber(activity.total_threads)}</span>
            </div>
          </div>
        )}

        {topInvocations.length > 0 && (
          <div className="space-y-1.5">
            <div className="mb-1 text-[11px] font-semibold text-gray-600 dark:text-gray-300">
              常用插件
            </div>
            {topInvocations.slice(0, 5).map((invocation) => (
              <InvocationRow
                key={`${invocation.kind}-${invocation.display_name}-${invocation.usage_count}`}
                invocation={invocation}
              />
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

function InvocationRow({ invocation }: { invocation: AccountTopInvocation }) {
  const prefix = invocation.kind === "plugin" ? "@" : "$";
  return (
    <div className="flex items-center justify-between gap-2 text-[11px]">
      <span className="min-w-0 truncate text-gray-700 dark:text-gray-200">
        {prefix}{invocation.display_name}
      </span>
      <span className="shrink-0 text-gray-500 dark:text-gray-400">
        {formatNumber(invocation.usage_count)} 次
      </span>
    </div>
  );
}

export function AccountUsageStats({
  accountId,
  enabled,
  open,
  usage,
  usageLoading = false,
  onStatsLoaded,
}: AccountUsageStatsProps) {
  const [stats, setStats] = useState<AccountUsageStatsInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const requestSeq = useRef(0);
  const backgroundInFlight = useRef(false);
  const lastObservedUsage = useRef<UsageInfo | undefined>(usage);

  const loadStats = useCallback(async (background = false) => {
    if (background && backgroundInFlight.current) return;
    const requestId = ++requestSeq.current;

    if (!enabled) {
      if (background) return;
      const next = emptyStats(accountId, "仅 ChatGPT 账户提供使用统计。");
      setStats(next);
      onStatsLoaded?.(next);
      setLoading(false);
      return;
    }

    if (background) {
      backgroundInFlight.current = true;
    } else {
      setLoading(true);
    }
    try {
      const next = await invokeBackend<AccountUsageStatsInfo>("get_account_usage_stats", {
        accountId,
      });
      if (requestId !== requestSeq.current) return;
      if (background && (!next.available || next.error)) return;
      setStats(next);
      onStatsLoaded?.(next);
    } catch (err) {
      if (background || requestId !== requestSeq.current) return;
      const next = emptyStats(accountId, err instanceof Error ? err.message : String(err));
      setStats(next);
      onStatsLoaded?.(next);
    } finally {
      if (background) {
        backgroundInFlight.current = false;
      } else if (requestId === requestSeq.current) {
        setLoading(false);
      }
    }
  }, [accountId, enabled, onStatsLoaded]);

  useEffect(() => {
    requestSeq.current += 1;
    setStats(null);
    onStatsLoaded?.(null);
    setLoading(false);
  }, [accountId, onStatsLoaded]);

  useEffect(() => {
    const usageChanged = usage !== lastObservedUsage.current;
    lastObservedUsage.current = usage;
    if (!usageChanged || !enabled || !open || usageLoading || !usage || usage.error) return;
    void loadStats(true);
  }, [enabled, loadStats, open, usage, usageLoading]);

  const currentStats = stats?.account_id === accountId ? stats : null;
  const generatedAt = currentStats ? formatGeneratedAt(currentStats.generated_at) : "";
  const todayTokens = currentStats ? sumDays(currentStats.daily, 1) : null;
  const sevenDayTokens = currentStats ? sumDays(currentStats.daily, 7) : null;
  const thirtyDayTokens = currentStats ? sumDays(currentStats.daily, 30) : null;

  if (!open) return null;

  return (
    <div className="mt-4 border-t border-gray-200 pt-3 dark:border-gray-800">
      <div>
        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="truncate text-[11px] text-gray-500 dark:text-gray-400">
            {currentStats?.stats_as_of ? `统计时间：${currentStats.stats_as_of}` : "ChatGPT 使用统计"}
            {generatedAt && ` · 更新于 ${generatedAt}`}
          </p>
          <button
            onClick={() => void loadStats()}
            disabled={loading || !enabled}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-600 transition-colors hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
            title="刷新使用统计"
          >
            <span className={loading ? "inline-block animate-spin" : ""}>↻</span>
          </button>
        </div>

        {loading && !currentStats ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {[0, 1, 2, 3, 4].map((item) => (
              <div key={item} className="h-16 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
            ))}
          </div>
        ) : currentStats?.available ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <StatTile label="累计" value={formatTokens(currentStats.summary.lifetime_tokens)} sub="tokens" />
              <StatTile label="今天" value={formatTokens(todayTokens)} sub="已报告" />
              <StatTile label="最近 7 天" value={formatTokens(sevenDayTokens)} sub="已报告" />
              <StatTile label="当前连续使用" value={`${formatNumber(currentStats.summary.current_streak_days)} 天`} />
              <StatTile label="单日峰值" value={formatTokens(currentStats.summary.peak_daily_tokens)} sub="tokens" />
            </div>

            <TokenActivity daily={currentStats.daily} />

            <DetailPanel
              activity={currentStats.activity}
              thirtyDayTokens={thirtyDayTokens}
              summary={currentStats.summary}
              topInvocations={currentStats.top_invocations}
            />
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-gray-200 px-3 py-3 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
            {currentStats?.error ?? "使用统计暂不可用。"}
          </div>
        )}
      </div>
    </div>
  );
}
