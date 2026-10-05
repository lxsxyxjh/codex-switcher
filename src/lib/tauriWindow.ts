import { cursorPosition, getCurrentWindow, type Window as TauriWindow } from "@tauri-apps/api/window";

let cachedWindow: TauriWindow | null = null;

/**
 * Resolve the Tauri window only inside the Tauri runtime. Browser/LAN mode
 * must be able to evaluate the React bundle without touching Tauri internals.
 */
export function getTauriWindow(): TauriWindow | null {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return null;
  }
  return (cachedWindow ??= getCurrentWindow());
}

export function isPointInsideWindow(
  point: { x: number; y: number },
  position: { x: number; y: number },
  size: { width: number; height: number },
): boolean {
  return point.x >= position.x && point.y >= position.y
    && point.x < position.x + size.width && point.y < position.y + size.height;
}

export async function isCursorInsideWindow(): Promise<boolean> {
  const currentWindow = getTauriWindow();
  if (!currentWindow) return false;
  const [point, position, size] = await Promise.all([
    cursorPosition(), currentWindow.outerPosition(), currentWindow.outerSize(),
  ]);
  return isPointInsideWindow(point, position, size);
}
