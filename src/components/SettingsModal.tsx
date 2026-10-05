import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopReopenPreference } from "../lib/desktopReopen";
import type { CodexClosePreference } from "../lib/codexClosePreference";
import { invokeBackend, isTauriRuntime, isWindowsPlatform } from "../lib/platform";
import type { FloatingOptions } from "../FloatingUsage";
import type { DockDisplayMode } from "../types";
import { usageRefreshIntervals } from "../lib/usageDisplay";

type TrayDisplayMode = "icon_and_session" | "active_usage_text" | "hidden";
interface DisplaySettings {
  tray_display_mode: TrayDisplayMode;
  dock_display_mode: DockDisplayMode | null;
}

interface SettingsModalProps {
  reopenPreference: DesktopReopenPreference;
  onReopenPreferenceChange: (value: DesktopReopenPreference) => void;
  closePreference: CodexClosePreference;
  onClosePreferenceChange: (value: CodexClosePreference) => void;
  onClose: () => void;
}

export function SettingsModal({
  reopenPreference,
  onReopenPreferenceChange,
  closePreference,
  onClosePreferenceChange,
  onClose,
}: SettingsModalProps) {
  const [displaySettings, setDisplaySettings] = useState<DisplaySettings | null>(null);
  const [floating, setFloating] = useState<FloatingOptions | null>(null);
  const [scaleDraft, setScaleDraft] = useState("100");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const desktop = isTauriRuntime();
  const loadDisplaySettings = useCallback(async () => {
    const currentRequest = ++requestId.current;
    try {
      const [settings, floatingSettings] = await Promise.all([
        invokeBackend<DisplaySettings>("get_display_settings"),
        isWindowsPlatform() ? invokeBackend<FloatingOptions>("get_floating_usage_options") : Promise.resolve(null),
      ]);
      if (currentRequest === requestId.current) {
        setDisplaySettings(settings);
        setFloating(floatingSettings);
        if (floatingSettings) setScaleDraft(String(floatingSettings.floating_usage_scale));
        setError(null);
      }
    } catch (err) {
      if (currentRequest === requestId.current) setError(String(err));
    }
  }, []);

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const stop = await listen("app-settings-changed", () => {
        void loadDisplaySettings();
      });
      if (disposed) stop();
      else {
        unlisten = stop;
        void loadDisplaySettings();
      }
    }).catch((err) => {
      if (!disposed) setError(String(err));
    });
    return () => {
      disposed = true;
      requestId.current += 1;
      unlisten?.();
    };
  }, [desktop, loadDisplaySettings]);

  const changeDisplaySetting = async (command: string, mode: string) => {
    setSaving(true);
    setError(null);
    try {
      await invokeBackend(command, { mode });
      // Changing tray visibility can also adjust the Dock mode, and vice versa.
      await loadDisplaySettings();
    } catch (err) {
      requestId.current += 1;
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const changeFloating = async (values: { scale?: number; showUsed?: boolean; enabled?: boolean; vertical?: boolean; edgeHide?: boolean }) => {
    setSaving(true);
    setError(null);
    try {
      if (values.enabled !== undefined) await invokeBackend("set_floating_usage_enabled", { enabled: values.enabled });
      else {
        if (values.scale !== undefined && (!Number.isInteger(values.scale) || values.scale < 50 || values.scale > 200)) throw new Error("缩放比例应为 50 到 200 的整数");
        await invokeBackend("set_floating_usage_options", values);
      }
      await loadDisplaySettings();
    } catch (err) { setError(String(err)); }
    finally { setSaving(false); }
  };

  const selectClassName = "w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 disabled:opacity-50";
  const changeRefreshInterval = async (seconds: number) => {
    setSaving(true);
    setError(null);
    try {
      await invokeBackend("set_usage_refresh_interval", { seconds });
      await loadDisplaySettings();
    } catch (err) { setError(String(err)); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div role="dialog" aria-modal="true" aria-labelledby="settings-title" className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl w-full max-w-md mx-4 shadow-xl">
        <div className="p-5 border-b border-gray-100 dark:border-gray-800">
          <h2 id="settings-title" className="text-lg font-semibold text-gray-900 dark:text-gray-100">设置</h2>
        </div>
        <div className="p-5 space-y-3 max-h-[65vh] overflow-y-auto">
          {desktop && (
            <>
              {displaySettings ? (
                <>
                  <label htmlFor="tray-display-mode" className="block text-sm font-medium text-gray-900 dark:text-gray-100">系统托盘</label>
                  <select
                    id="tray-display-mode"
                    value={isWindowsPlatform() && displaySettings.tray_display_mode !== "icon_and_session" ? "icon_and_session" : displaySettings.tray_display_mode}
                    disabled={saving}
                    onChange={(event) => void changeDisplaySetting("set_tray_display_mode", event.target.value)}
                    className={selectClassName}
                  >
                    <option value="icon_and_session">{isWindowsPlatform() ? "显示图标（悬停查看额度）" : "图标 + 额度时段"}</option>
                    {!isWindowsPlatform() && <option value="active_usage_text">每小时 + 每周额度</option>}
                    {!isWindowsPlatform() && <option value="hidden">隐藏</option>}
                  </select>
                  {displaySettings.dock_display_mode !== null && (
                    <>
                      <label htmlFor="dock-display-mode" className="block text-sm font-medium text-gray-900 dark:text-gray-100">程序坞图标</label>
                      <select
                        id="dock-display-mode"
                        value={displaySettings.dock_display_mode}
                        disabled={saving}
                        onChange={(event) => void changeDisplaySetting("set_dock_display_mode", event.target.value)}
                        className={selectClassName}
                      >
                        <option value="show_in_dock">显示在程序坞</option>
                        <option value="menu_bar_only">仅显示在菜单栏</option>
                      </select>
                      <p className="text-xs text-gray-500 dark:text-gray-400">程序坞或系统托盘至少保留一个图标，以便重新打开 Codex Switcher。</p>
                    </>
                  )}
                </>
              ) : !error && <p className="text-sm text-gray-500 dark:text-gray-400">正在加载显示设置…</p>}
              {error && <p role="alert" className="text-sm text-red-600 dark:text-red-300">无法更新显示设置：{error}</p>}
              <div className="border-t border-gray-100 dark:border-gray-800" />
            </>
          )}
          {floating && <section className="grid gap-3">
            <label htmlFor="usage-refresh-interval" className="text-sm font-medium">额度自动刷新</label>
            <select id="usage-refresh-interval" className={selectClassName} disabled={saving} value={floating.usage_refresh_interval_seconds} onChange={(event) => void changeRefreshInterval(Number(event.target.value))}>
              {usageRefreshIntervals.map(({ seconds, label }) => <option key={seconds} value={seconds}>{label}</option>)}
            </select>
            <p className="text-xs text-gray-500">此间隔用于获取最新额度，不改变 Codex 的额度重置时间。主界面显示时更新所有账户，隐藏时更新当前显示账户。</p>
            <label className="text-sm font-medium"><input type="checkbox" checked={floating.floating_usage_enabled} disabled={saving} onChange={(event) => void changeFloating({ enabled: event.target.checked })} /> 桌面悬浮额度窗</label>
            <label htmlFor="floating-layout" className="text-sm">悬浮窗排列方式</label>
            <select id="floating-layout" className={selectClassName} disabled={saving} value={String(floating.floating_usage_vertical)} onChange={(event) => void changeFloating({ vertical: event.target.value === "true" })}>
              <option value="false">横排</option><option value="true">竖排（标题与数值分行）</option>
            </select>
            <label className="text-sm"><input type="checkbox" checked={floating.floating_usage_edge_hide} disabled={saving} onChange={(event) => void changeFloating({ edgeHide: event.target.checked })} /> 贴边隐藏（拖到屏幕边缘，鼠标移入展开）</label>
            <label htmlFor="floating-percent-mode" className="text-sm">百分比显示</label>
            <select id="floating-percent-mode" className={selectClassName} disabled={saving} value={String(floating.floating_usage_show_used)} onChange={(event) => void changeFloating({ showUsed: event.target.value === "true" })}>
              <option value="false">剩余百分比</option><option value="true">已用百分比</option>
            </select>
            <label htmlFor="floating-scale" className="text-sm">悬浮窗缩放比例（50%–200%）</label>
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <input id="floating-scale" type="number" min={50} max={200} step={1} value={scaleDraft} disabled={saving} onChange={(event) => setScaleDraft(event.target.value)} className={selectClassName} />
              <button disabled={saving} onClick={() => void changeFloating({ scale: Number(scaleDraft) })} className="h-[34px] rounded-lg bg-blue-50 px-3 text-sm text-blue-600 hover:bg-blue-100 disabled:opacity-50">保存</button>
            </div>
            <p className="text-xs text-gray-500">右键悬浮窗可以选择显示账户、打开主界面或关闭悬浮窗。</p>
          </section>}
          <p className="text-xs text-gray-500">可以在主界面或悬浮窗手动刷新。网络异常时保留上次成功数据。</p>
          <label htmlFor="codex-close-preference" className="block text-sm font-medium text-gray-900 dark:text-gray-100">
            Codex 关闭方式
          </label>
          <select id="codex-close-preference" value={closePreference} onChange={(event) => onClosePreferenceChange(event.target.value as CodexClosePreference)} className={selectClassName}>
            <option value="ask">每次询问</option>
            <option value="graceful">正常关闭</option>
            <option value="force">强制关闭</option>
          </select>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            正常关闭会让 Codex 完成清理；强制关闭会立即结束进程，可能丢失未保存的内容。
          </p>
          <label htmlFor="desktop-reopen-preference" className="block text-sm font-medium text-gray-900 dark:text-gray-100">
            关闭后重新打开 Codex
          </label>
          <select id="desktop-reopen-preference" value={reopenPreference} onChange={(event) => onReopenPreferenceChange(event.target.value as DesktopReopenPreference)} className={selectClassName}>
            <option value="ask">每次询问</option>
            <option value="always">重新打开桌面版</option>
            <option value="never">保持关闭</option>
          </select>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            适用于检测到的 macOS 和 Windows Codex 桌面版。切换账户成功后可自动重新打开。
          </p>
        </div>
        <div className="flex justify-end p-5 border-t border-gray-100 dark:border-gray-800">
          <button onClick={onClose} disabled={saving} className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 disabled:opacity-50">完成</button>
        </div>
      </div>
    </div>
  );
}
