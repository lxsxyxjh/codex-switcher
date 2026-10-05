import assert from "node:assert/strict";
import test from "node:test";
import { formatCreditsBalance, formatQuotaResetTime, formatUsagePercent, formatUsageWindowLabel, getDisplayedUsageWindows } from "../src/lib/usageDisplay.ts";

test("shows only the quota windows returned, including exhausted free and weekly-only accounts", () => {
  const monthly = { primary_used_percent: 100, primary_window_minutes: 43200, secondary_used_percent: null, secondary_window_minutes: null };
  assert.deepEqual(getDisplayedUsageWindows(monthly).map((quota) => [quota.label, formatUsagePercent(quota.used)]), [["30d", "0%"]]);
  assert.deepEqual(getDisplayedUsageWindows({ ...monthly, primary_used_percent: 20, primary_window_minutes: 300, secondary_used_percent: 30, secondary_window_minutes: 10080 }).map((quota) => quota.label), ["5h", "7d"]);
  assert.deepEqual(getDisplayedUsageWindows({ ...monthly, primary_used_percent: null, primary_window_minutes: null, secondary_used_percent: 100, secondary_window_minutes: 10080 }).map((quota) => [quota.label, formatUsagePercent(quota.used)]), [["7d", "0%"]]);
  assert.deepEqual(getDisplayedUsageWindows(undefined), []);
});

test("formats zero and adds thousands separators to credit balances", () => {
  assert.equal(formatCreditsBalance("0"), "0");
  assert.equal(formatCreditsBalance("1011"), "1,011");
  assert.equal(formatCreditsBalance("10000"), "10,000");
});

test("rounds fractional credit balances to two decimal places", () => {
  assert.equal(formatCreditsBalance("820.6969075"), "820.70");
});

test("uses a placeholder for unavailable balances", () => {
  assert.equal(formatCreditsBalance(null), "--");
  assert.equal(formatCreditsBalance(undefined), "--");
});

test("quota percentages preserve zero remaining and zero used", () => {
  assert.equal(formatUsagePercent(100), "0%");
  assert.equal(formatUsagePercent(0, true), "0%");
  assert.equal(formatUsagePercent(0), "100%");
  assert.equal(formatUsagePercent(null), "--");
  assert.equal(formatUsagePercent(undefined), "--");
  assert.equal(formatUsagePercent(NaN), "--");
});

test("quota window labels reflect actual duration without suppressing percentages", () => {
  assert.equal(formatUsageWindowLabel(300, "5h"), "5h");
  assert.equal(formatUsageWindowLabel(10080, "7d"), "7d");
  assert.equal(formatUsageWindowLabel(43200, "5h"), "30d");
  assert.equal(formatUsageWindowLabel(0, "5h"), "5h");
  assert.equal(formatUsageWindowLabel(null, "5h"), "5h");
});

test("reset dates use numeric months and long waits use days rather than hundreds of hours", () => {
  const reset = new Date(2026, 10, 2, 20, 59).getTime();
  const now = reset - (674 * 3600 + 60) * 1000;
  assert.equal(formatQuotaResetTime(reset / 1000, now), "11月2日 20:59（约28天2小时后）");
});

test("reset dates include the year when needed and handle expired or invalid values", () => {
  const reset = new Date(2027, 0, 2, 20, 59).getTime();
  const now = new Date(2026, 11, 31, 20, 59).getTime();
  assert.equal(formatQuotaResetTime(reset / 1000, now), "2027年1月2日 20:59（约2天后）");
  assert.equal(formatQuotaResetTime(reset / 1000, reset), "1月2日 20:59（已到重置时间，等待额度更新）");
  assert.equal(formatQuotaResetTime(reset / 1000, reset - 1000), "1月2日 20:59（约不到1分钟后）");
  assert.equal(formatQuotaResetTime(null, now), "");
  assert.equal(formatQuotaResetTime(NaN, now), "");
});
