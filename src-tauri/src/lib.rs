//! Codex usage and Credits monitor

pub mod api;
#[cfg(desktop)]
pub mod app_menu;
pub mod auth;
pub mod commands;
#[cfg(desktop)]
pub mod tray;
pub mod types;
pub mod web;

use commands::{
    add_account_from_cookie, add_account_from_file, cancel_login,
    complete_login, delete_account, export_accounts_full_encrypted_file,
    get_dock_display_mode, get_usage, hide_tray_window,
    import_accounts_full_encrypted_file,
    get_cached_usage, get_floating_usage_enabled, list_accounts, open_main_window, quit_app,
    refresh_account_metadata,
    rename_account, set_dock_display_mode,
    set_floating_usage_enabled, start_login,
};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "windows")]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
        commands::restore_main_window(app);
    }));
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                app_menu::setup(app.handle())?;
                tray::setup(app.handle())?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(desktop)]
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    #[cfg(target_os = "windows")]
                    {
                        api.prevent_close();
                        let app = window.app_handle();
                        if auth::load_app_settings().map(|settings| settings.tray_display_mode == types::TrayDisplayMode::Hidden).unwrap_or(false) {
                            if let Err(error) = app_menu::set_tray_display_mode(app, types::TrayDisplayMode::IconAndSession) {
                                eprintln!("Failed to restore tray before hiding main window: {error}");
                                return;
                            }
                        }
                        commands::hide_main_window(app);
                    }
                    #[cfg(not(target_os = "windows"))]
                    {
                        api.prevent_close();
                        commands::hide_main_window(&tauri::Manager::app_handle(window));
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_display_settings,
            commands::set_tray_display_mode,

            // Account management
            list_accounts,
            add_account_from_file,
            add_account_from_cookie,

            delete_account,
            rename_account,
                    export_accounts_full_encrypted_file,
            import_accounts_full_encrypted_file,
            // OAuth
            start_login,
            complete_login,
            cancel_login,
            // Usage
            get_usage,
            refresh_account_metadata,

            // Tray window
            hide_tray_window,
            open_main_window,
            quit_app,
            get_cached_usage,
            commands::get_codex_auth_path,
            commands::get_floating_usage_options,
            commands::set_usage_refresh_interval,
            commands::open_usage_log,
            commands::set_floating_usage_options,
            commands::resize_floating_usage,
            commands::wait_for_floating_drag_release,
            get_floating_usage_enabled,
            set_floating_usage_enabled,
            get_dock_display_mode,
            set_dock_display_mode,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                commands::restore_main_window(_app);
            }
        });
}
