//! Window and tray popup management commands.

use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::{
    auth::{load_accounts, load_app_settings, save_app_settings},
    types::{AppSettings, DockDisplayMode, FloatingUsagePosition, TrayDisplayMode, UsageInfo},
};

/// Label of the borderless tray popup window.
pub const TRAY_WINDOW: &str = "tray";
pub const FLOATING_USAGE_WINDOW: &str = "floating-usage";
#[tauri::command]
pub fn get_cached_usage() -> Vec<UsageInfo> {
    #[cfg(desktop)]
    {
        crate::tray::cached_usage()
    }
    #[cfg(not(desktop))]
    {
        Vec::new()
    }
}

#[tauri::command]
pub fn get_floating_usage_enabled() -> Option<bool> {
    #[cfg(target_os = "windows")]
    {
        Some(
            load_app_settings()
                .map(|settings| settings.floating_usage_enabled)
                .unwrap_or(false),
        )
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

#[tauri::command]
pub async fn set_floating_usage_enabled(app: AppHandle, enabled: bool) -> Result<bool, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, enabled);
        Err("Floating usage is only available on Windows".into())
    }
    #[cfg(target_os = "windows")]
    {
        if !enabled {
            if let Some(window) = app.get_webview_window(FLOATING_USAGE_WINDOW) {
                if let Ok(position) = window.outer_position() {
                    if let Ok(mut settings) = load_app_settings() {
                        settings.floating_usage_position = Some(FloatingUsagePosition {
                            x: position.x,
                            y: position.y,
                        });
                        let _ = save_app_settings(&settings);
                    }
                }
            }
        }

        let mut settings = load_app_settings().map_err(|error| error.to_string())?;
        let previous = settings.floating_usage_enabled;
        settings.floating_usage_enabled = enabled;
        save_app_settings(&settings).map_err(|error| error.to_string())?;

        let result = if enabled {
            crate::tray::show_floating_usage_window(&app)
        } else {
            crate::tray::hide_floating_usage_window(&app)
        };
        if let Err(error) = result {
            settings.floating_usage_enabled = previous;
            let _ = save_app_settings(&settings);
            return Err(error.to_string());
        }

        let _ = app.emit("app-settings-changed", ());
        #[cfg(desktop)]
        crate::tray::refresh(&app);
        Ok(enabled)
    }
}

#[tauri::command]
pub fn get_floating_usage_options() -> Result<AppSettings, String> {
    let mut settings = load_app_settings().map_err(|error| error.to_string())?;
    settings.floating_usage_scale = settings.floating_usage_scale.clamp(50, 200);
    Ok(settings)
}

#[tauri::command]
pub fn set_usage_refresh_interval(app: AppHandle, account_id: String, seconds: u64) -> Result<(), String> {
    if ![30, 60, 120, 300, 600].contains(&seconds) {
        return Err("请选择有效的自动刷新间隔".into());
    }
    let mut settings = load_app_settings().map_err(|error| error.to_string())?;
    if !load_accounts().map_err(|error| error.to_string())?.accounts.iter().any(|account| account.id == account_id) { return Err("账户不存在".into()); }
    if settings.account_usage_refresh_intervals.get(&account_id).copied().unwrap_or(300) == seconds {
        return Ok(());
    }
    if seconds == 300 { settings.account_usage_refresh_intervals.remove(&account_id); }
    else { settings.account_usage_refresh_intervals.insert(account_id.clone(), seconds); }
    save_app_settings(&settings).map_err(|error| error.to_string())?;
    #[cfg(desktop)]
    {
        crate::tray::reset_usage_refresh_timer(&account_id);
        crate::tray::refresh(&app);
    }
    let _ = app.emit("app-settings-changed", ());
    tauri::async_runtime::spawn(async move {
        if let Err(error) = crate::commands::get_usage(app, account_id, Some("修改自动刷新间隔".into())).await {
            eprintln!("Failed to refresh usage after changing interval: {error}");
        }
    });
    Ok(())
}

#[tauri::command]
pub fn set_floating_usage_options(
    app: AppHandle,
    scale: Option<u16>,
    account_id: Option<String>,
    show_used: Option<bool>,
    vertical: Option<bool>,
    edge_hide: Option<bool>,
) -> Result<AppSettings, String> {
    let settings = update_floating_usage_options(scale, account_id, show_used, vertical, edge_hide)?;
    let _ = app.emit("app-settings-changed", ());
    #[cfg(desktop)]
    crate::tray::refresh(&app);
    Ok(settings)
}

pub fn update_floating_usage_options(
    scale: Option<u16>, account_id: Option<String>, show_used: Option<bool>,
    vertical: Option<bool>, edge_hide: Option<bool>,
) -> Result<AppSettings, String> {
    let mut settings = load_app_settings().map_err(|error| error.to_string())?;
    if let Some(scale) = scale {
        if !(50..=200).contains(&scale) {
            return Err("缩放比例应在 50% 到 200% 之间".into());
        }
        settings.floating_usage_scale = scale;
    }
    if let Some(account_id) = account_id {
        if !account_id.is_empty()
            && !load_accounts().map_err(|error| error.to_string())?.accounts.iter().any(|account| account.id == account_id)
        {
            return Err("所选账户已不存在".into());
        }
        settings.floating_usage_account_id = if account_id.is_empty() { None } else { Some(account_id) };
    }
    if let Some(show_used) = show_used {
        settings.floating_usage_show_used = show_used;
    }
    if let Some(vertical) = vertical { settings.floating_usage_vertical = vertical; }
    if let Some(edge_hide) = edge_hide {
        settings.floating_usage_edge_hide = edge_hide;
        if !edge_hide { settings.floating_usage_edge = None; }
    }
    save_app_settings(&settings).map_err(|error| error.to_string())?;
    Ok(settings)
}

#[tauri::command]
pub async fn wait_for_floating_drag_release() {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
        // Native dragging captures mouse input outside the webview. The start-dragging
        // command only queues that operation, so its completion is not a mouse release.
        while unsafe { GetAsyncKeyState(VK_LBUTTON as i32) } < 0 {
            tokio::time::sleep(std::time::Duration::from_millis(80)).await;
        }
    }
}

fn floating_edge_from_gaps(gaps: [i32; 4], tolerance: i32) -> Option<&'static str> {
    // A negative gap means part of the window is already beyond this edge.
    // At a corner, prefer the edge crossed furthest rather than a stale dock.
    ["left", "right", "top", "bottom"].into_iter().zip(gaps)
        .filter(|(_, gap)| *gap <= tolerance)
        .min_by_key(|(_, gap)| *gap)
        .map(|(edge, _)| edge)
}

#[tauri::command]
pub fn resize_floating_usage(
    app: AppHandle,
    width: f64,
    height: f64,
    full_width: f64,
    full_height: f64,
    edge: Option<String>,
    detect_edge: bool,
) -> Result<Option<String>, String> {
    for (value, limit) in [(width, 1200.0), (height, 480.0), (full_width, 1200.0), (full_height, 480.0)] {
        if !value.is_finite() || !(16.0..=limit).contains(&value) {
            return Err("悬浮窗尺寸无效".into());
        }
    }
    let Some(window) = app.get_webview_window(FLOATING_USAGE_WINDOW) else { return Ok(None); };
    let mut settings = load_app_settings().map_err(|error| error.to_string())?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let monitor = window.current_monitor().map_err(|error| error.to_string())?
        .or(app.primary_monitor().map_err(|error| error.to_string())?).ok_or("没有可用显示器")?;
    let scale = monitor.scale_factor();
    let left = monitor.position().x;
    let top = monitor.position().y;
    let right = left + monitor.size().width as i32;
    let bottom = top + monitor.size().height as i32;
    let current_size = window.outer_size().map_err(|error| error.to_string())?;
    let mut dock = if settings.floating_usage_edge_hide { edge.filter(|value| ["left", "right", "top", "bottom"].contains(&value.as_str())) } else { None };
    if detect_edge && settings.floating_usage_edge_hide {
        // Detect against the current physical window bounds, then keep the expanded anchor when collapsing.
        dock = floating_edge_from_gaps([
            position.x - left,
            right - position.x - current_size.width as i32,
            position.y - top,
            bottom - position.y - current_size.height as i32,
        ], (6.0 * scale).ceil() as i32).map(str::to_string);
    }
    let physical_width = (width.ceil() * scale).ceil() as i32;
    let physical_height = (height.ceil() * scale).ceil() as i32;
    let expanded_width = (full_width.ceil() * scale).ceil() as i32;
    let expanded_height = (full_height.ceil() * scale).ceil() as i32;
    let mut x = position.x;
    let mut y = position.y;
    if dock.is_some() {
        x = x.clamp(left, (right - expanded_width).max(left));
        y = y.clamp(top, (bottom - expanded_height).max(top));
    }
    let (mut anchor_x, mut anchor_y) = (x, y);
    match dock.as_deref() {
        Some("left") => { x = left; anchor_x = left; },
        Some("right") => { x = right - physical_width; anchor_x = right - expanded_width; },
        Some("top") => { y = top; anchor_y = top; },
        Some("bottom") => { y = bottom - physical_height; anchor_y = bottom - expanded_height; },
        _ => {},
    }
    if current_size.width as i32 != physical_width || current_size.height as i32 != physical_height {
        window.set_size(tauri::LogicalSize::new(width.ceil(), height.ceil())).map_err(|error| error.to_string())?;
    }
    if x != position.x || y != position.y {
        window.set_position(tauri::PhysicalPosition::new(x, y)).map_err(|error| error.to_string())?;
    }
    if settings.floating_usage_edge != dock
        || settings.floating_usage_position.map(|position| (position.x, position.y)) != Some((anchor_x, anchor_y))
    {
        settings.floating_usage_edge = dock.clone();
        settings.floating_usage_position = Some(FloatingUsagePosition { x: anchor_x, y: anchor_y });
        save_app_settings(&settings).map_err(|error| error.to_string())?;
    }
    Ok(dock)
}

#[cfg(test)]
mod floating_edge_tests {
    use super::floating_edge_from_gaps;

    #[test]
    fn touching_or_crossing_any_edge_docks_even_when_the_window_center_is_outside() {
        for (index, edge) in ["left", "right", "top", "bottom"].into_iter().enumerate() {
            for gap in [0, -1, -100, -300] {
                let mut gaps = [500; 4];
                gaps[index] = gap;
                assert_eq!(floating_edge_from_gaps(gaps, 6), Some(edge));
            }
        }
    }

    #[test]
    fn moving_inside_beyond_tolerance_undocks() {
        assert_eq!(floating_edge_from_gaps([500, 6, 500, 500], 6), Some("right"));
        assert_eq!(floating_edge_from_gaps([500, 7, 500, 500], 6), None);
        assert_eq!(floating_edge_from_gaps([500; 4], 6), None);
    }

    #[test]
    fn corner_prefers_the_edge_crossed_furthest() {
        assert_eq!(floating_edge_from_gaps([500, -100, -20, 500], 6), Some("right"));
        assert_eq!(floating_edge_from_gaps([-20, 500, 500, -100], 6), Some("bottom"));
    }
}

/// Hide the tray popup window (called by the tray UI after an action).
#[tauri::command]
pub fn hide_tray_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window(TRAY_WINDOW) {
        let _ = window.hide();
    }
}

/// Bring the main window to the foreground and hide the tray popup.
#[tauri::command]
pub fn open_main_window(app: AppHandle) {
    restore_main_window(&app);
}

pub fn hide_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    #[cfg(target_os = "macos")]
    let _ = app.hide();
}

/// Bring the main window to the foreground and hide the tray popup.
pub fn restore_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(tray) = app.get_webview_window(TRAY_WINDOW) {
        let _ = tray.hide();
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Quit the whole application from the tray.
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[derive(serde::Serialize)]
pub struct DisplaySettings {
    tray_display_mode: TrayDisplayMode,
    dock_display_mode: Option<DockDisplayMode>,
}

#[tauri::command]
pub fn get_display_settings() -> Result<DisplaySettings, String> {
    let settings = load_app_settings().map_err(|error| error.to_string())?;
    Ok(DisplaySettings {
        tray_display_mode: settings.tray_display_mode,
        dock_display_mode: if cfg!(target_os = "macos") {
            Some(settings.dock_display_mode)
        } else {
            None
        },
    })
}

#[tauri::command]
pub fn set_tray_display_mode(app: AppHandle, mode: TrayDisplayMode) -> Result<(), String> {
    #[cfg(desktop)]
    {
        crate::app_menu::set_tray_display_mode(&app, mode).map_err(|error| error.to_string())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, mode);
        Err("Tray settings are only available on desktop".into())
    }
}

#[tauri::command]
pub fn get_dock_display_mode() -> Option<DockDisplayMode> {
    #[cfg(target_os = "macos")]
    {
        Some(
            crate::auth::load_app_settings()
                .unwrap_or_default()
                .dock_display_mode,
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

#[tauri::command]
pub fn set_dock_display_mode(
    app: AppHandle,
    mode: DockDisplayMode,
) -> Result<Option<DockDisplayMode>, String> {
    #[cfg(target_os = "macos")]
    {
        crate::app_menu::set_dock_display_mode(&app, mode)
            .map(|settings| Some(settings.dock_display_mode))
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, mode);
        Ok(None)
    }
}
