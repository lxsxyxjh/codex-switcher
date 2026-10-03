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
