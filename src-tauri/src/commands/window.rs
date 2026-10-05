//! Window and tray popup management commands.

use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(target_os = "macos")]
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::{
    auth::{load_accounts, load_app_settings, save_app_settings},
    types::{AppSettings, DockDisplayMode, FloatingUsagePosition, TrayDisplayMode, UsageInfo},
};

/// Label of the borderless tray popup window.
pub const TRAY_WINDOW: &str = "tray";
pub const FLOATING_USAGE_WINDOW: &str = "floating-usage";
pub const CLOSE_BEHAVIOR_REQUESTED_EVENT: &str = "close-behavior-requested";

#[cfg(target_os = "macos")]
static CLOSE_BEHAVIOR_PROMPT_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static CLOSE_BEHAVIOR_PROMPT_ACKED: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseBehaviorRequestedPayload {
    pub request_id: u64,
}

/// Forward UI-reported usage failures so other windows can preserve their last successful values.
#[tauri::command]
pub fn report_usage(app: AppHandle, usages: Vec<UsageInfo>) {
    #[cfg(desktop)]
    crate::tray::ingest_usage(&app, usages);
    #[cfg(not(desktop))]
    let _ = (app, usages);
}

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
pub fn set_floating_usage_options(
    app: AppHandle,
    scale: Option<u16>,
    account_id: Option<String>,
    show_used: Option<bool>,
    vertical: Option<bool>,
    edge_hide: Option<bool>,
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
    let _ = app.emit("app-settings-changed", ());
    #[cfg(desktop)]
    crate::tray::refresh(&app);
    Ok(settings)
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
        dock = [
            ("left", (position.x - left).abs()),
            ("right", (right - position.x - current_size.width as i32).abs()),
            ("top", (position.y - top).abs()),
            ("bottom", (bottom - position.y - current_size.height as i32).abs()),
        ].into_iter().min_by_key(|(_, distance)| *distance)
            .filter(|(_, distance)| *distance <= (24.0 * scale) as i32)
            .map(|(edge, _)| edge.to_string());
    }
    let physical_width = (width.ceil() * scale).ceil() as i32;
    let physical_height = (height.ceil() * scale).ceil() as i32;
    let expanded_width = (full_width.ceil() * scale).ceil() as i32;
    let expanded_height = (full_height.ceil() * scale).ceil() as i32;
    let mut x = position.x.clamp(left, (right - expanded_width).max(left));
    let mut y = position.y.clamp(top, (bottom - expanded_height).max(top));
    let (mut anchor_x, mut anchor_y) = (x, y);
    match dock.as_deref() {
        Some("left") => { x = left; anchor_x = left; },
        Some("right") => { x = right - physical_width; anchor_x = right - expanded_width; },
        Some("top") => { y = top; anchor_y = top; },
        Some("bottom") => { y = bottom - physical_height; anchor_y = bottom - expanded_height; },
        _ => {},
    }
    window.set_size(tauri::LogicalSize::new(width.ceil(), height.ceil())).map_err(|error| error.to_string())?;
    window.set_position(tauri::PhysicalPosition::new(x, y)).map_err(|error| error.to_string())?;
    settings.floating_usage_edge = dock.clone();
    settings.floating_usage_position = Some(FloatingUsagePosition { x: anchor_x, y: anchor_y });
    save_app_settings(&settings).map_err(|error| error.to_string())?;
    Ok(dock)
}

#[tauri::command]
pub fn save_floating_usage_position(x: i32, y: i32) -> Result<(), String> {
    let mut settings = load_app_settings().map_err(|error| error.to_string())?;
    settings.floating_usage_position = Some(FloatingUsagePosition { x, y });
    save_app_settings(&settings).map_err(|error| error.to_string())
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

#[cfg(target_os = "macos")]
pub fn next_close_behavior_prompt_payload() -> CloseBehaviorRequestedPayload {
    CloseBehaviorRequestedPayload {
        request_id: CLOSE_BEHAVIOR_PROMPT_SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1,
    }
}

#[cfg(target_os = "macos")]
pub fn schedule_close_behavior_prompt_fallback<R: Runtime>(app: AppHandle<R>, request_id: u64) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(750));
        if CLOSE_BEHAVIOR_PROMPT_ACKED.load(Ordering::SeqCst) >= request_id {
            return;
        }

        let app_handle = app.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            hide_main_window(&app_handle);
        }) {
            eprintln!("Failed to schedule close prompt fallback: {error}");
        }
    });
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

#[tauri::command]
pub fn complete_close_behavior(
    app: AppHandle,
    mode: DockDisplayMode,
    dont_ask_again: bool,
) -> Result<Option<DockDisplayMode>, String> {
    #[cfg(target_os = "macos")]
    {
        let mut settings = crate::app_menu::set_dock_display_mode(&app, mode)
            .map_err(|error| error.to_string())?;
        if dont_ask_again {
            settings.close_behavior_prompt_enabled = false;
            save_app_settings(&settings).map_err(|error| error.to_string())?;
        }
        hide_main_window(&app);
        Ok(Some(settings.dock_display_mode))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (mode, dont_ask_again);
        hide_main_window(&app);
        Ok(None)
    }
}

#[tauri::command]
pub fn ack_close_behavior_prompt(request_id: u64) {
    CLOSE_BEHAVIOR_PROMPT_ACKED.fetch_max(request_id, Ordering::SeqCst);
}

pub fn should_prompt_for_close_behavior() -> bool {
    #[cfg(target_os = "macos")]
    {
        load_app_settings()
            .unwrap_or_default()
            .close_behavior_prompt_enabled
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}
