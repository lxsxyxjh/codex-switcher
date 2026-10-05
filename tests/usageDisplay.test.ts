import assert from "node:assert/strict";
import test from "node:test";
import { formatCreditsBalance } from "../src/lib/usageDisplay.ts";

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
