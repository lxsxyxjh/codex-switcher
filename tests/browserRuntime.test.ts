import assert from "node:assert/strict";
import test from "node:test";
import { getTauriWindow, isPointInsideWindow } from "../src/lib/tauriWindow.ts";

test("browser runtime does not resolve a Tauri window", () => {
  assert.equal(getTauriWindow(), null);
});

test("a plain browser-like window without Tauri internals remains safe", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {},
  });
  try {
    assert.equal(getTauriWindow(), null);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else delete (globalThis as { window?: unknown }).window;
  }
});

test("a pointer left inside the docked window keeps it expanded", () => {
  const position = { x: 1600, y: 300 };
  const size = { width: 320, height: 48 };
  assert.equal(isPointInsideWindow({ x: 1800, y: 324 }, position, size), true);
  assert.equal(isPointInsideWindow({ x: 1600, y: 300 }, position, size), true);
  for (const point of [{ x: 1599, y: 324 }, { x: 1920, y: 324 }, { x: 1800, y: 299 }, { x: 1800, y: 348 }]) {
    assert.equal(isPointInsideWindow(point, position, size), false);
  }
});

test("pointer checks use physical coordinates including negative monitor positions", () => {
  assert.equal(isPointInsideWindow({ x: -1850, y: 250 }, { x: -1920, y: 200 }, { width: 300, height: 60 }), true);
});
