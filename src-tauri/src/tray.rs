use std::collections::{HashMap, HashSet};
use std::sync::{
    LazyLock, Mutex,
};
use std::time::{Duration, Instant};

use tauri::{
    menu::{CheckMenuItemBuilder, Menu, MenuItemBuilder, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, Runtime, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};

use crate::{
    api::usage::get_account_usage,
    auth::{get_accounts_file, load_accounts, load_app_settings, save_app_settings},
    commands::{
        restore_main_window,
        window::{FLOATING_USAGE_WINDOW, TRAY_WINDOW},
    },
    types::{
        AccountsStore, AuthData, FloatingUsagePosition, StoredAccount, TrayDisplayMode, UsageInfo,
    },
};

static TRAY_USAGE: LazyLock<Mutex<HashMap<String, UsageInfo>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

const TRAY_ID: &str = "codex-switcher-tray";
const TRAY_ICON: tauri::image::Image<'static> = tauri::include_image!("./icons/tray.png");
const TRAY_REFRESH_EVENT: &str = "tray-refresh";
const USAGE_UPDATED_EVENT: &str = "usage-updated";
const ACCOUNTS_CHANGED_EVENT: &str = "accounts-changed";
const ACCOUNT_ITEM_PREFIX: &str = "account:";
const OPEN_ITEM_ID: &str = "open";
const QUIT_ITEM_ID: &str = "quit";
#[cfg(target_os = "windows")]
const FLOATING_ITEM_ID: &str = "floating";
const TRAY_WIDTH: f64 = 300.0;
const TRAY_HEIGHT: f64 = 420.0;
const FLOATING_USAGE_WIDTH: f64 = 260.0;
const FLOATING_USAGE_HEIGHT: f64 = 48.0;
static LAST_USAGE_REFRESH: LazyLock<Mutex<HashMap<String, Instant>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
// 所有后台网络任务共用一个锁，自动刷新忙时跳过，手动操作等待。
pub static USAGE_REFRESH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
pub fn reset_usage_refresh_timer(account_id: &str) {
    if let Ok(mut last) = LAST_USAGE_REFRESH.lock() { last.insert(account_id.to_string(), Instant::now()); }
    let interval = load_app_settings().unwrap_or_default().account_usage_refresh_intervals.get(account_id).copied().unwrap_or(300);
    crate::api::usage::write_usage_log(&format!("倒计时重置 account={account_id} interval={interval}s next_due={}（仅悬浮窗显示此账户时自动刷新）", (chrono::Local::now() + chrono::Duration::seconds(interval as i64)).format("%Y-%m-%d %H:%M:%S")));
}
const ACCOUNT_METADATA_REFRESH_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    create_tray_window(app)?;

    #[cfg(target_os = "windows")]
    if load_app_settings()
        .map(|settings| settings.floating_usage_enabled)
        .unwrap_or(false)
    {
        if let Err(error) = create_floating_usage_window(app) {
            eprintln!("Failed to restore floating usage window: {error}");
            if let Ok(mut settings) = load_app_settings() {
                settings.floating_usage_enabled = false;
                let _ = save_app_settings(&settings);
            }
        }
    }

    let menu = build_menu(app, &load_accounts().unwrap_or_default())?;

    #[cfg(target_os = "linux")]
    let icon = app
        .default_window_icon()
        .cloned()
        .expect("application icon should be configured");

    #[cfg(target_os = "macos")]
    let icon = TRAY_ICON;

    #[cfg(target_os = "windows")]
    let icon = tray_icon_for_theme(current_system_theme());

    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("Codex Switcher")
        .menu(&menu)
        .on_menu_event(handle_menu_event);

    #[cfg(target_os = "macos")]
    let builder = builder.icon_as_template(true);

    #[cfg(not(target_os = "linux"))]
    let builder = builder
        .on_tray_icon_event(handle_tray_icon_event)
        .show_menu_on_left_click(false);

    builder.build(app)?;
    refresh_menu(app);

    watch_accounts_file(app.clone());
    #[cfg(target_os = "windows")]
    watch_system_theme(app.clone());
    poll_active_account_usage(app.clone());
    poll_account_metadata(app.clone());
    Ok(())
}

pub fn refresh<R: Runtime>(app: &AppHandle<R>) {
    refresh_menu(app);
}

#[cfg(target_os = "windows")]
fn update_theme<R: Runtime>(app: &AppHandle<R>, theme: tauri::Theme) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };

    if let Err(error) = tray.set_icon(Some(tray_icon_for_theme(theme))) {
        eprintln!("Failed to update tray icon theme: {error}");
    }
}

#[cfg(any(target_os = "windows", test))]
fn tray_icon_for_theme(theme: tauri::Theme) -> tauri::image::Image<'static> {
    let mut rgba = TRAY_ICON.rgba().to_vec();
    if theme == tauri::Theme::Dark {
        for pixel in rgba.chunks_exact_mut(4) {
            if pixel[3] > 0 {
                pixel[..3].fill(255);
            }
        }
    }

    tauri::image::Image::new_owned(rgba, TRAY_ICON.width(), TRAY_ICON.height())
}

#[cfg(target_os = "windows")]
fn current_system_theme() -> tauri::Theme {
    read_system_theme().unwrap_or(tauri::Theme::Light)
}

#[cfg(target_os = "windows")]
fn read_system_theme() -> Option<tauri::Theme> {
    use windows_sys::Win32::{
        Foundation::ERROR_SUCCESS,
        System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD},
    };

    let subkey = wide_null(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
    // The notification area follows Windows' system mode, which is independent of app mode.
    let value_name = wide_null("SystemUsesLightTheme");
    let mut value = 0_u32;
    let mut value_size = std::mem::size_of::<u32>() as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            value_name.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            (&mut value as *mut u32).cast(),
            &mut value_size,
        )
    };

    (status == ERROR_SUCCESS).then_some(if value == 0 {
        tauri::Theme::Dark
    } else {
        tauri::Theme::Light
    })
}

#[cfg(target_os = "windows")]
fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
fn watch_system_theme<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, ERROR_SUCCESS, WAIT_OBJECT_0},
            System::Registry::{
                RegCloseKey, RegNotifyChangeKeyValue, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER,
                KEY_NOTIFY, REG_NOTIFY_CHANGE_LAST_SET,
            },
            System::Threading::{CreateEventW, WaitForSingleObject, INFINITE},
        };

        let subkey = wide_null(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
        let mut key: HKEY = std::ptr::null_mut();
        let open_status =
            unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, KEY_NOTIFY, &mut key) };
        if open_status != ERROR_SUCCESS {
            eprintln!("Failed to watch Windows system theme: {open_status}");
            return;
        }

        let event = unsafe { CreateEventW(std::ptr::null(), 0, 0, std::ptr::null()) };
        if event.is_null() {
            eprintln!("Failed to create Windows system theme event");
            unsafe {
                RegCloseKey(key);
            }
            return;
        }

        loop {
            let status =
                unsafe { RegNotifyChangeKeyValue(key, 0, REG_NOTIFY_CHANGE_LAST_SET, event, 1) };
            if status != ERROR_SUCCESS {
                eprintln!("Failed to watch Windows system theme: {status}");
                break;
            }

            if let Some(theme) = read_system_theme() {
                update_theme(&app, theme);
            }

            let wait_status = unsafe { WaitForSingleObject(event, INFINITE) };
            if wait_status != WAIT_OBJECT_0 {
                eprintln!("Failed waiting for Windows system theme change: {wait_status}");
                break;
            }
        }

        unsafe {
            CloseHandle(event);
            RegCloseKey(key);
        }
    });
}

/// Store usage updates and notify the open windows and native tray menu.
pub fn ingest_usage<R: Runtime>(app: &AppHandle<R>, mut usages: Vec<UsageInfo>) {
    for usage in &usages { reset_usage_refresh_timer(&usage.account_id); }
    let account_ids = load_accounts().ok().map(|store| store.accounts.into_iter().map(|account| account.id).collect::<HashSet<_>>());
    if let Ok(mut cache) = TRAY_USAGE.lock() {
        if let Some(account_ids) = account_ids {
            cache.retain(|id, _| account_ids.contains(id));
            usages.retain(|usage| account_ids.contains(&usage.account_id));
        }
        for usage in &mut usages {
            *usage = usage.clone().retain_previous_on_error(cache.get(&usage.account_id));
            cache.insert(usage.account_id.clone(), usage.clone());
        }
    }
    let _ = app.emit(USAGE_UPDATED_EVENT, &usages);
    refresh_menu(app);
}

pub fn cached_usage() -> Vec<UsageInfo> {
    TRAY_USAGE
        .lock()
        .map(|cache| cache.values().cloned().collect())
        .unwrap_or_default()
}

#[cfg(target_os = "windows")]
pub fn show_floating_usage_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(FLOATING_USAGE_WINDOW) {
        window.show()?;
        window.set_always_on_top(true)?;
        keep_floating_usage_visible(app)?;
        return Ok(());
    }

    create_floating_usage_window(app)
}

#[cfg(target_os = "windows")]
pub fn hide_floating_usage_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(FLOATING_USAGE_WINDOW) {
        window.hide()?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn create_floating_usage_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if app.get_webview_window(FLOATING_USAGE_WINDOW).is_some() {
        return Ok(());
    }

    let settings = load_app_settings().unwrap_or_default();
    let restoring_edge = settings.floating_usage_edge_hide && settings.floating_usage_edge.is_some();
    let window = WebviewWindowBuilder::new(
        app,
        FLOATING_USAGE_WINDOW,
        WebviewUrl::App("floating.html".into()),
    )
    .title("Codex Usage")
    .inner_size(if restoring_edge { 20.0 } else { FLOATING_USAGE_WIDTH }, if restoring_edge { 20.0 } else { FLOATING_USAGE_HEIGHT })
    .resizable(false)
    .decorations(false)
    .shadow(false)
    .transparent(true)
    .background_color(tauri::utils::config::Color(0, 0, 0, 0))
    .always_on_top(true)
    .focusable(false)
    .skip_taskbar(true)
    .visible(false)
    .build()?;

    let saved_position = settings
        .floating_usage_position
        .map(|position| PhysicalPosition::new(position.x, position.y));
    let position = saved_position
        .filter(|position| floating_position_is_visible(app, *position))
        .unwrap_or_else(|| default_floating_usage_position(app));
    if let Err(error) = window.set_position(position).and_then(|()| window.show()) {
        let _ = window.close();
        return Err(error);
    }
    persist_floating_usage_position(position);
    Ok(())
}

#[cfg(target_os = "windows")]
fn persist_floating_usage_position(position: PhysicalPosition<i32>) {
    let Ok(mut settings) = load_app_settings() else {
        return;
    };
    settings.floating_usage_position = Some(FloatingUsagePosition {
        x: position.x,
        y: position.y,
    });
    if let Err(error) = save_app_settings(&settings) {
        eprintln!("Failed to save floating usage position: {error}");
    }
}

#[cfg(target_os = "windows")]
fn floating_position_is_visible<R: Runtime>(
    app: &AppHandle<R>,
    position: PhysicalPosition<i32>,
) -> bool {
    let size = app.get_webview_window(FLOATING_USAGE_WINDOW).and_then(|window| window.outer_size().ok());
    app.available_monitors().unwrap_or_default().iter().any(|monitor| {
        let monitor_position = monitor.position();
        let monitor_size = monitor.size();
        let scale = monitor.scale_factor();
        let width = size.map(|size| size.width as i32).unwrap_or((FLOATING_USAGE_WIDTH * scale).ceil() as i32);
        let height = size.map(|size| size.height as i32).unwrap_or((FLOATING_USAGE_HEIGHT * scale).ceil() as i32);
        floating_bounds_are_visible(
            (position.x, position.y, width, height),
            (monitor_position.x, monitor_position.y, monitor_size.width as i32, monitor_size.height as i32),
        )
    })
}

#[cfg(any(target_os = "windows", test))]
fn floating_bounds_are_visible(window: (i32, i32, i32, i32), monitor: (i32, i32, i32, i32)) -> bool {
    let (x, y, width, height) = window;
    let (left, top, monitor_width, monitor_height) = monitor;
    let overlap_width = (i64::from(x) + i64::from(width)).min(i64::from(left) + i64::from(monitor_width)) - i64::from(x.max(left));
    let overlap_height = (i64::from(y) + i64::from(height)).min(i64::from(top) + i64::from(monitor_height)) - i64::from(y.max(top));
    overlap_width >= i64::from(width.min(16)) && overlap_height >= i64::from(height.min(16))
}

#[cfg(target_os = "windows")]
fn default_floating_usage_position<R: Runtime>(app: &AppHandle<R>) -> PhysicalPosition<i32> {
    let monitor = app
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| app.available_monitors().ok()?.into_iter().next());
    let Some(monitor) = monitor else {
        return PhysicalPosition::new(24, 24);
    };

    let position = monitor.position();
    let size = monitor.size();
    let scale = monitor.scale_factor();
    let width = app.get_webview_window(FLOATING_USAGE_WINDOW)
        .and_then(|window| window.outer_size().ok())
        .map(|size| size.width as i32)
        .unwrap_or((FLOATING_USAGE_WIDTH * scale).ceil() as i32);
    let margin = (16.0 * scale).ceil() as i32;
    PhysicalPosition::new(
        (position.x + size.width as i32 - width - margin).max(position.x),
        position.y + margin,
    )
}

#[cfg(target_os = "windows")]
pub fn keep_floating_usage_visible<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(FLOATING_USAGE_WINDOW) {
        if !floating_position_is_visible(app, window.outer_position()?) {
            window.set_position(default_floating_usage_position(app))?;
        }
    }
    Ok(())
}
// React popup window (used on macOS/Windows via tray click events)

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn create_tray_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if app.get_webview_window(TRAY_WINDOW).is_some() {
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(app, TRAY_WINDOW, WebviewUrl::App("tray.html".into()))
        .title("Codex Switcher")
        .inner_size(TRAY_WIDTH, TRAY_HEIGHT)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .build()?;

    // Hide the popup as soon as it loses focus so it behaves like a native menu.
    let app_handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Focused(false) = event {
            if let Some(window) = app_handle.get_webview_window(TRAY_WINDOW) {
                let _ = window.hide();
            }
        }
    });

    Ok(())
}

#[cfg_attr(target_os = "linux", allow(dead_code))]
fn handle_tray_icon_event<R: Runtime>(tray: &tauri::tray::TrayIcon<R>, event: TrayIconEvent) {
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        position: _,
        ..
    } = event
    {
        #[cfg(target_os = "windows")]
        show_main_window(tray.app_handle());
        #[cfg(not(target_os = "windows"))]
        if let TrayIconEvent::Click { position, .. } = event {
            toggle_tray_window(tray.app_handle(), position);
        }
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn toggle_tray_window<R: Runtime>(app: &AppHandle<R>, cursor: PhysicalPosition<f64>) {
    let Some(window) = app.get_webview_window(TRAY_WINDOW) else {
        return;
    };

    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        return;
    }

    position_near_cursor(&window, cursor);
    let _ = window.show();
    let _ = window.set_focus();
    let _ = app.emit_to(TRAY_WINDOW, TRAY_REFRESH_EVENT, ());
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn position_near_cursor<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    cursor: PhysicalPosition<f64>,
) {
    let size = window.outer_size().ok();
    let width = size.map(|s| s.width as f64).unwrap_or(TRAY_WIDTH);
    let height = size.map(|s| s.height as f64).unwrap_or(TRAY_HEIGHT);

    let x = (cursor.x - width / 2.0).max(0.0);
    // macOS menu bar sits at the top, so drop the popup below the icon.
    // Other platforms keep the tray at the bottom, so float it above the cursor.
    let y = if cfg!(target_os = "macos") {
        cursor.y + 4.0
    } else {
        (cursor.y - height - 4.0).max(0.0)
    };

    let _ = window.set_position(PhysicalPosition::new(x, y));
}
// Native menu (the only tray interaction on Linux; right-click on macOS/Windows)

fn build_menu<R: Runtime>(app: &AppHandle<R>, store: &AccountsStore) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;

    if store.accounts.is_empty() {
        menu.append(
            &MenuItemBuilder::with_id("empty", "尚未添加账户")
                .enabled(false)
                .build(app)?,
        )?;
    } else {
        let settings = load_app_settings().unwrap_or_default();
        let displayed_id = settings.floating_usage_account_id.as_deref()
            .filter(|id| store.accounts.iter().any(|account| account.id == *id))
            .or_else(|| account_for_usage_poll(store).map(|account| account.id.as_str()));
        menu.append(&MenuItemBuilder::with_id("usage-accounts-label", "查看额度账户").enabled(false).build(app)?)?;
        for account in &store.accounts {
            let usage_only = matches!(&account.auth_data, crate::types::AuthData::Cookie { .. });
            let account_name = if usage_only {
                format!("{} (Cookie)", account.name)
            } else {
                account.name.clone()
            };
            let label = format!("{}{}", account_name, usage_suffix(&account.id));
            let item =
                CheckMenuItemBuilder::with_id(account_menu_id(&account.id), menu_label(&label))
                    .checked(displayed_id == Some(account.id.as_str()))
                    .build(app)?;
            menu.append(&item)?;
        }
    }

    menu.append(&PredefinedMenuItem::separator(app)?)?;
    #[cfg(target_os = "windows")]
    menu.append(&CheckMenuItemBuilder::with_id(FLOATING_ITEM_ID, "悬浮额度窗")
        .checked(load_app_settings().map(|settings| settings.floating_usage_enabled).unwrap_or(false))
        .build(app)?)?;
    let settings = load_app_settings().unwrap_or_default();
    let selected_id = settings.floating_usage_account_id.as_deref().filter(|id| store.accounts.iter().any(|account| account.id == *id)).or_else(|| account_for_usage_poll(store).map(|account| account.id.as_str()));
    let interval = selected_id.and_then(|id| settings.account_usage_refresh_intervals.get(id)).copied().unwrap_or(300);
    let refresh_menu = Submenu::new(app, if settings.floating_usage_enabled { "悬浮窗账户自动刷新" } else { "自动刷新已暂停（悬浮窗未开启）" }, settings.floating_usage_enabled && selected_id.is_some())?;
    for (seconds, label) in [(30, "每 30 秒"), (60, "每 1 分钟"), (120, "每 2 分钟"), (300, "每 5 分钟（默认）"), (600, "每 10 分钟")] {
        refresh_menu.append(&CheckMenuItemBuilder::with_id(format!("usage-refresh:{seconds}"), label).checked(interval == seconds).build(app)?)?;
    }
    menu.append(&refresh_menu)?;
    #[cfg(target_os = "macos")]
    append_dock_settings_menu(app, &menu)?;
    #[cfg(target_os = "macos")]
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItemBuilder::with_id(OPEN_ITEM_ID, "打开主界面").build(app)?)?;
    menu.append(&MenuItemBuilder::with_id(QUIT_ITEM_ID, "退出程序").build(app)?)?;
    Ok(menu)
}

#[cfg(target_os = "macos")]
fn append_dock_settings_menu<R: Runtime>(app: &AppHandle<R>, menu: &Menu<R>) -> tauri::Result<()> {
    let settings = load_app_settings().unwrap_or_default();
    let dock_settings = Submenu::with_items(
        app,
        "Dock Icon",
        true,
        &[
            &CheckMenuItemBuilder::with_id(crate::app_menu::DOCK_SHOW_IN_DOCK_ID, "Show in Dock")
                .checked(settings.dock_display_mode == crate::app_menu::DockDisplayMode::ShowInDock)
                .build(app)?,
            &CheckMenuItemBuilder::with_id(crate::app_menu::DOCK_MENU_BAR_ONLY_ID, "Menu Bar Only")
                .checked(
                    settings.dock_display_mode == crate::app_menu::DockDisplayMode::MenuBarOnly,
                )
                .build(app)?,
        ],
    )?;
    menu.append(&dock_settings)?;
    Ok(())
}

fn handle_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    let item_id = event.id().as_ref();
    if let Some(seconds) = item_id.strip_prefix("usage-refresh:").and_then(|value| value.parse::<u64>().ok()) {
        let store = load_accounts().unwrap_or_default();
        let selected_id = load_app_settings().ok().and_then(|settings| settings.floating_usage_account_id).filter(|id| store.accounts.iter().any(|account| account.id == *id)).or_else(|| account_for_usage_poll(&store).map(|account| account.id.clone()));
        let Some(selected_id) = selected_id else { return; };
        if let Err(error) = crate::commands::set_usage_refresh_interval(app.clone(), selected_id, seconds) {
            eprintln!("Failed to save usage refresh interval: {error}");
        }
        return;
    }

    #[cfg(target_os = "macos")]
    if let Some(mode) = crate::app_menu::dock_display_mode_for_item(item_id) {
        crate::app_menu::update_dock_display_mode(app, mode);
        return;
    }

    match item_id {
        #[cfg(target_os = "windows")]
        FLOATING_ITEM_ID => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let enabled = load_app_settings().map(|settings| settings.floating_usage_enabled).unwrap_or(false);
                if let Err(error) = crate::commands::set_floating_usage_enabled(app.clone(), !enabled).await {
                    show_main_window(&app);
                    let _ = app.emit("floating-usage-error", error);
                }
            });
        }
        OPEN_ITEM_ID => show_main_window(app),
        QUIT_ITEM_ID => app.exit(0),
        _ => {
            let Some(account_id) = item_id.strip_prefix(ACCOUNT_ITEM_PREFIX) else {
                return;
            };

            if let Err(error) = crate::commands::set_floating_usage_options(
                app.clone(), None, Some(account_id.to_string()), None, None, None,
            ) {
                show_main_window(app);
                let _ = app.emit("floating-usage-error", error);
            }
        }
    }
}

fn refresh_menu<R: Runtime>(app: &AppHandle<R>) {
    let app_handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        refresh_menu_on_main_thread(&app_handle);
    }) {
        eprintln!("Failed to schedule tray menu refresh: {error}");
    }
}

fn refresh_menu_on_main_thread<R: Runtime>(app: &AppHandle<R>) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };

    match load_accounts()
        .map_err(|error| error.to_string())
        .and_then(|store| {
            let settings = load_app_settings().unwrap_or_default();
            let title = active_tray_title(
                settings.floating_usage_account_id.as_deref().filter(|id| store.accounts.iter().any(|account| account.id == *id)).or_else(|| account_for_usage_poll(&store).map(|account| account.id.as_str())),
                settings.tray_display_mode,
            );
            let displayed = settings.floating_usage_account_id.as_deref()
                .and_then(|id| store.accounts.iter().find(|account| account.id == id))
                .or_else(|| store.active_account_id.as_deref().and_then(|id| store.accounts.iter().find(|account| account.id == id)))
                .or_else(|| store.accounts.iter().find(|account| matches!(&account.auth_data, AuthData::Cookie { .. }))).or_else(|| store.accounts.first());
            let usage = TRAY_USAGE.lock().ok().and_then(|cache| displayed.and_then(|account| cache.get(&account.id).cloned()));
            let tooltip = usage_tooltip(usage.as_ref());
            let menu = build_menu(app, &store).map_err(|error| error.to_string())?;
            Ok((menu, title, settings.tray_display_mode, tooltip))
        }) {
        Ok((menu, title, mode, tooltip)) => {
            if let Err(error) = tray.set_tooltip(Some(&tooltip)) {
                eprintln!("Failed to refresh tray tooltip: {error}");
            }
            if let Err(error) = tray.set_menu(Some(menu)) {
                eprintln!("Failed to refresh tray menu: {error}");
            }
            refresh_tray_display(&tray, mode, title.as_deref());
        }
        Err(error) => eprintln!("Failed to build tray menu: {error}"),
    }
}

fn refresh_tray_display<R: Runtime>(
    tray: &tauri::tray::TrayIcon<R>,
    mode: TrayDisplayMode,
    title: Option<&str>,
) {
    match mode {
        TrayDisplayMode::IconAndSession => {
            if let Err(error) = tray.set_visible(true) {
                eprintln!("Failed to show tray icon: {error}");
            }
            #[cfg(target_os = "macos")]
            {
                if let Err(error) = tray.set_icon(Some(TRAY_ICON)) {
                    eprintln!("Failed to refresh tray icon: {error}");
                }
                if let Err(error) = tray.set_icon_as_template(true) {
                    eprintln!("Failed to refresh tray icon template mode: {error}");
                }
            }
            #[cfg(target_os = "windows")]
            if let Err(error) = tray.set_icon(Some(tray_icon_for_theme(current_system_theme()))) {
                eprintln!("Failed to refresh tray icon: {error}");
            }
            if let Err(error) = tray.set_title(title) {
                eprintln!("Failed to refresh tray title: {error}");
            }
        }
        TrayDisplayMode::ActiveUsageText => {
            if let Err(error) = tray.set_visible(true) {
                eprintln!("Failed to show tray icon: {error}");
            }
            #[cfg(target_os = "macos")]
            if let Err(error) = tray.set_icon(None) {
                eprintln!("Failed to hide tray icon: {error}");
            }
            #[cfg(target_os = "windows")]
            if let Err(error) = tray.set_icon(Some(tray_icon_for_theme(current_system_theme()))) {
                eprintln!("Failed to refresh tray icon: {error}");
            }
            if let Err(error) = tray.set_title(title) {
                eprintln!("Failed to refresh tray title: {error}");
            }
        }
        TrayDisplayMode::Hidden => {
            if let Err(error) = tray.set_title(None::<&str>) {
                eprintln!("Failed to clear tray title: {error}");
            }
            if let Err(error) = tray.set_visible(false) {
                eprintln!("Failed to hide tray icon: {error}");
            }
        }
    }
}

fn usage_tooltip(usage: Option<&UsageInfo>) -> String {
    let Some(usage) = usage else {
        return "Codex Switcher\n额度尚未获取".into();
    };
    let windows = usage_title(
        usage.primary_used_percent,
        usage.primary_window_minutes,
        usage.secondary_used_percent,
        usage.secondary_window_minutes,
    );
    let balance = usage.credits_balance.as_deref().map(str::trim).filter(|value| !value.is_empty());
    let credits = balance.map(|value| {
        value.parse::<f64>().ok().filter(|number| number.is_finite())
            .map(|number| if number.fract() == 0.0 { format!("{number:.0}") } else { format!("{number:.2}") })
            .unwrap_or_else(|| value.to_string())
    }).unwrap_or_else(|| "--".into());
    let seconds = load_app_settings().unwrap_or_default().account_usage_refresh_intervals.get(&usage.account_id).copied().unwrap_or(300);
    let status = if usage.error.is_some() { "刷新失败，保留上次数据".into() } else { format!("每 {seconds} 秒更新额度数据") };
    format!("Codex Switcher\n剩余 {windows} · 余额 {credits}\n{status}")
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    restore_main_window(app);
}

// The tray title sits after the icon, e.g. "[icon] 66%".
fn active_session_title(active_account_id: Option<&str>) -> Option<String> {
    let active_account_id = active_account_id?;
    let cache = TRAY_USAGE.lock().ok()?;
    let usage = cache.get(active_account_id)?;
    session_remaining_title(
        usage.primary_used_percent.or(usage.secondary_used_percent),
        false,
    )
}

fn active_tray_title(active_account_id: Option<&str>, mode: TrayDisplayMode) -> Option<String> {
    match mode {
        TrayDisplayMode::IconAndSession => active_session_title(active_account_id),
        TrayDisplayMode::ActiveUsageText => Some(active_usage_title(active_account_id)),
        TrayDisplayMode::Hidden => None,
    }
}

fn active_usage_title(active_account_id: Option<&str>) -> String {
    let Some(active_account_id) = active_account_id else {
        return "Codex".to_string();
    };

    let usage = TRAY_USAGE
        .lock()
        .ok()
        .and_then(|cache| cache.get(active_account_id).cloned());

    match usage {
        Some(usage) => {
            usage_title(
                usage.primary_used_percent,
                usage.primary_window_minutes,
                usage.secondary_used_percent,
                usage.secondary_window_minutes,
            )
        }
        _ => "H:-- W:--".to_string(),
    }
}

fn usage_title(
    primary_used_percent: Option<f64>,
    primary_window_minutes: Option<i64>,
    secondary_used_percent: Option<f64>,
    secondary_window_minutes: Option<i64>,
) -> String {
    let mut parts = Vec::new();
    if let Some(remaining) = remaining_percent_label(primary_used_percent) {
        let label = window_duration_label(primary_window_minutes)
            .unwrap_or_else(|| "H".to_string());
        parts.push(format!("{label}:{remaining}"));
    }
    if let Some(remaining) = remaining_percent_label(secondary_used_percent) {
        let label = window_duration_label(secondary_window_minutes)
            .unwrap_or_else(|| "W".to_string());
        parts.push(format!("{label}:{remaining}"));
    }

    if parts.is_empty() {
        "H:-- W:--".to_string()
    } else {
        parts.join(" ")
    }
}

fn window_duration_label(window_minutes: Option<i64>) -> Option<String> {
    let minutes = window_minutes?;
    if minutes <= 0 {
        return None;
    }
    if minutes < 24 * 60 {
        Some(format!("{}h", (minutes + 59) / 60))
    } else {
        Some(format!("{}d", (minutes + 24 * 60 - 1) / (24 * 60)))
    }
}

fn session_remaining_title(used_percent: Option<f64>, has_error: bool) -> Option<String> {
    if has_error {
        return None;
    }

    remaining_percent_label(used_percent)
}

fn remaining_percent_label(used_percent: Option<f64>) -> Option<String> {
    let used_percent = used_percent?;
    if !used_percent.is_finite() {
        return None;
    }

    Some(format!("{:.0}%", (100.0 - used_percent).clamp(0.0, 100.0)))
}

// "  —  S:73% W:51%" remaining-quota suffix for a menu label, or "" when unknown.
fn usage_suffix(account_id: &str) -> String {
    let Ok(cache) = TRAY_USAGE.lock() else {
        return String::new();
    };
    let Some(usage) = cache.get(account_id) else {
        return String::new();
    };
    let mut parts = Vec::new();
    if let Some(remaining) = session_remaining_title(usage.primary_used_percent, false) {
        let label = window_duration_label(usage.primary_window_minutes)
            .unwrap_or_else(|| "S".to_string());
        parts.push(format!("{label}:{remaining}"));
    }
    if let Some(used) = usage.secondary_used_percent {
        if used.is_finite() {
            let label = window_duration_label(usage.secondary_window_minutes)
                .unwrap_or_else(|| "W".to_string());
            parts.push(format!("{label}:{:.0}%", (100.0 - used).clamp(0.0, 100.0)));
        }
    }

    if parts.is_empty() {
        String::new()
    } else {
        format!("  —  {}", parts.join(" "))
    }
}

fn account_menu_id(account_id: &str) -> String {
    format!("{ACCOUNT_ITEM_PREFIX}{account_id}")
}

fn menu_label(label: &str) -> String {
    label.replace('&', "&&")
}
// Shared: react to external account changes

fn watch_accounts_file<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || {
        let accounts_path = match get_accounts_file() {
            Ok(path) => path,
            Err(error) => {
                eprintln!("Failed to resolve accounts file for tray: {error}");
                return;
            }
        };
        let mut last_modified = modified_at(&accounts_path);

        loop {
            std::thread::sleep(Duration::from_secs(1));
            let modified = modified_at(&accounts_path);
            if modified != last_modified {
                if let Ok(store) = load_accounts() {
                    let ids: HashSet<String> = store.accounts.iter().map(|account| account.id.clone()).collect();
                    if let Ok(mut cache) = TRAY_USAGE.lock() { cache.retain(|id, _| ids.contains(id)); }
                    crate::commands::usage::retain_account_metadata(&ids);
                } else {
                    continue;
                }
                last_modified = modified;
                refresh_menu(&app); // keep the native menu current
                let _ = app.emit(ACCOUNTS_CHANGED_EVENT, ()); // refresh the React UIs
            }
        }
    });
}

fn modified_at(path: &std::path::Path) -> Option<std::time::SystemTime> {
    path.metadata()
        .and_then(|metadata| metadata.modified())
        .ok()
}

fn account_for_usage_poll(store: &AccountsStore) -> Option<&StoredAccount> {
    store.active_account_id.as_deref().and_then(|id| store.accounts.iter().find(|account| account.id == id))
        .or_else(|| store.accounts.iter().find(|account| matches!(&account.auth_data, AuthData::Cookie { .. }))).or_else(|| store.accounts.first())
}

/// Only the account displayed in the enabled floating window is automatically refreshed.
fn poll_active_account_usage<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || {
      let accounts_path = get_accounts_file().ok();
      let settings_path = crate::auth::get_settings_file().ok();
      let mut accounts_modified = None;
      let mut settings_modified = None;
      let mut store = AccountsStore::default();
      let mut settings = crate::types::AppSettings::default();
      loop {
        std::thread::sleep(Duration::from_secs(1));
        let Ok(_refresh_guard) = USAGE_REFRESH_LOCK.try_lock() else { continue; };
        let modified = accounts_path.as_deref().and_then(modified_at);
        if modified != accounts_modified {
            let Ok(updated) = load_accounts() else { continue; };
            store = updated;
            accounts_modified = modified;
        }
        let modified = settings_path.as_deref().and_then(modified_at);
        if modified != settings_modified {
            let Ok(updated) = load_app_settings() else { continue; };
            settings = updated;
            settings_modified = modified;
        }
        if let Ok(mut last) = LAST_USAGE_REFRESH.lock() { last.retain(|id, _| store.accounts.iter().any(|account| &account.id == id)); }
        let displayed = if settings.floating_usage_enabled {
            settings.floating_usage_account_id.as_deref().filter(|id| store.accounts.iter().any(|account| account.id == *id))
                .or_else(|| account_for_usage_poll(&store).map(|account| account.id.as_str()))
        } else { None };
        for account in &store.accounts {
            if displayed != Some(account.id.as_str()) { continue; }
            if matches!(&account.auth_data, AuthData::ApiKey { .. }) { continue; }
            let interval = settings.account_usage_refresh_intervals.get(&account.id).copied().unwrap_or(300);
            let due = LAST_USAGE_REFRESH.lock().map(|mut last| last.entry(account.id.clone()).or_insert_with(Instant::now).elapsed() >= Duration::from_secs(interval)).unwrap_or(false);
            if !due { continue; }
            crate::api::usage::write_usage_log(&format!("自动刷新开始 account={} name={} interval={interval}s", account.id, account.name));
            let usage = match tauri::async_runtime::block_on(get_account_usage(&account)) {
                Ok(usage) => usage,
                Err(error) => UsageInfo::error(account.id.clone(), format!("{error:#}")),
            };
            ingest_usage(&app, vec![usage]);
        }
      }
    });
}
/// Keep subscription dates current even when the main webview is hidden or
/// suspended. Live metadata stays in memory and is announced to the webviews.
fn poll_account_metadata<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || loop {
        let accounts = load_accounts()
            .map(|store| store.accounts)
            .unwrap_or_default();

        for account in accounts {
            if matches!(
                &account.auth_data,
                crate::types::AuthData::ApiKey { .. } | crate::types::AuthData::Cookie { .. }
            ) {
                continue;
            }

            if tauri::async_runtime::block_on(crate::commands::refresh_account_metadata(account.id))
                .is_err()
            {
                eprintln!(
                    "[Account] Failed to refresh subscription metadata for: {}",
                    account.name
                );
            }
        }

        let _ = app.emit(ACCOUNTS_CHANGED_EVENT, ());

        std::thread::sleep(ACCOUNT_METADATA_REFRESH_INTERVAL);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn visible_partial_and_spanning_windows_keep_their_position() {
        let monitor = (0, 0, 1920, 1080);
        assert!(floating_bounds_are_visible((1800, 200, 300, 48), monitor));
        assert!(floating_bounds_are_visible((-200, 200, 300, 48), monitor));
        assert!(floating_bounds_are_visible((1904, 200, 16, 44), monitor));
        assert!(!floating_bounds_are_visible((1920, 200, 300, 48), monitor));
        assert!(!floating_bounds_are_visible((1915, 200, 300, 48), monitor));
        assert!(floating_bounds_are_visible((-1900, 200, 300, 48), (-1920, 0, 1920, 1080)));
    }

    #[test]
    fn themed_tray_icon_preserves_shape_and_switches_to_white() {
        let light = tray_icon_for_theme(tauri::Theme::Light);
        let dark = tray_icon_for_theme(tauri::Theme::Dark);

        assert_eq!(light.rgba(), TRAY_ICON.rgba());
        assert_eq!(
            dark.rgba().iter().skip(3).step_by(4).collect::<Vec<_>>(),
            TRAY_ICON
                .rgba()
                .iter()
                .skip(3)
                .step_by(4)
                .collect::<Vec<_>>()
        );
        assert!(dark
            .rgba()
            .chunks_exact(4)
            .filter(|pixel| pixel[3] > 0)
            .all(|pixel| pixel[..3] == [255, 255, 255]));
        assert!(dark
            .rgba()
            .chunks_exact(4)
            .zip(TRAY_ICON.rgba().chunks_exact(4))
            .filter(|(_, original)| original[3] == 0)
            .all(|(themed, original)| themed == original));
    }

    #[test]
    fn embedded_tray_icon_is_not_an_opaque_block() {
        let alphas: Vec<_> = TRAY_ICON
            .rgba()
            .iter()
            .skip(3)
            .step_by(4)
            .copied()
            .collect();
        let width = TRAY_ICON.width() as usize;

        assert_eq!(
            [
                alphas[0],
                alphas[width - 1],
                alphas[alphas.len() - width],
                alphas[alphas.len() - 1]
            ],
            [0, 0, 0, 0]
        );
        assert!(alphas.contains(&0));
        assert!(alphas.contains(&255));
    }

    #[test]
    fn account_ids_are_namespaced_for_tray_events() {
        assert_eq!(account_menu_id("abc-123"), "account:abc-123");
    }

    #[test]
    fn usage_poll_prefers_the_active_codex_account() {
        let cookie = StoredAccount::new_cookie(
            "Cookie".into(),
            None,
            None,
            None,
            "session=sample".into(),
        );
        let active = StoredAccount::new_api_key("Active".into(), "key-sample".into());
        let active_id = active.id.clone();
        let store = AccountsStore {
            accounts: vec![cookie, active],
            active_account_id: Some(active_id.clone()),
            ..AccountsStore::default()
        };

        let selected = account_for_usage_poll(&store).unwrap();

        assert_eq!(selected.id, active_id);
    }

    #[test]
    fn usage_poll_falls_back_to_the_first_cookie_account() {
        let cookie = StoredAccount::new_cookie(
            "Cookie".into(),
            None,
            None,
            None,
            "session=sample".into(),
        );
        let cookie_id = cookie.id.clone();
        let store = AccountsStore {
            accounts: vec![cookie],
            ..AccountsStore::default()
        };

        let selected = account_for_usage_poll(&store).unwrap();

        assert_eq!(selected.id, cookie_id);
    }

    #[test]
    fn menu_labels_escape_mnemonic_markers() {
        assert_eq!(
            menu_label("Research & Development"),
            "Research && Development"
        );
    }

    #[test]
    fn session_title_shows_remaining_percentage() {
        assert_eq!(
            session_remaining_title(Some(34.0), false),
            Some("66%".to_string())
        );
    }

    #[test]
    fn session_title_hides_unknown_or_invalid_usage() {
        assert_eq!(session_remaining_title(None, false), None);
        assert_eq!(session_remaining_title(Some(f64::NAN), false), None);
        assert_eq!(session_remaining_title(Some(34.0), true), None);
    }

    #[test]
    fn session_title_clamps_remaining_percentage() {
        assert_eq!(
            session_remaining_title(Some(-5.0), false),
            Some("100%".to_string())
        );
        assert_eq!(
            session_remaining_title(Some(105.0), false),
            Some("0%".to_string())
        );
    }

    #[test]
    fn usage_title_omits_missing_windows() {
        assert_eq!(
            usage_title(Some(27.0), Some(5 * 60), Some(82.0), Some(30 * 24 * 60)),
            "5h:73% 30d:18%"
        );
        assert_eq!(
            usage_title(None, None, Some(35.0), Some(7 * 24 * 60)),
            "7d:65%"
        );
        assert_eq!(
            usage_title(Some(27.0), Some(5 * 60), None, None),
            "5h:73%"
        );
        assert_eq!(usage_title(None, None, None, None), "H:-- W:--");
    }

    #[test]
    fn window_duration_labels_round_to_hours_and_days() {
        assert_eq!(window_duration_label(Some(5 * 60)), Some("5h".to_string()));
        assert_eq!(window_duration_label(Some(12 * 60)), Some("12h".to_string()));
        assert_eq!(
            window_duration_label(Some(7 * 24 * 60)),
            Some("7d".to_string())
        );
        assert_eq!(
            window_duration_label(Some(30 * 24 * 60)),
            Some("30d".to_string())
        );
        assert_eq!(window_duration_label(Some(0)), None);
        assert_eq!(window_duration_label(None), None);
    }

    #[test]
    fn active_usage_title_falls_back_when_usage_is_missing() {
        assert_eq!(active_usage_title(Some("missing")), "H:-- W:--");
        assert_eq!(active_usage_title(None), "Codex");
    }

    #[test]
    fn hidden_tray_mode_has_no_title() {
        assert_eq!(
            active_tray_title(Some("active"), TrayDisplayMode::Hidden),
            None
        );
    }
}
