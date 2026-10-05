//! Codex Switcher - Multi-account manager for Codex CLI

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
    ack_close_behavior_prompt, add_account_from_cookie, add_account_from_file, cancel_login,
    check_codex_processes,
    complete_close_behavior, complete_login, delete_account, export_accounts_full_encrypted_file,
    export_accounts_slim_text, get_account_usage_stats, get_active_account_info,
    get_dock_display_mode, get_usage, hide_tray_window,
    import_accounts_full_encrypted_file, import_accounts_slim_text, kill_codex_processes,
    get_cached_usage, get_floating_usage_enabled, list_accounts, open_main_window, quit_app,
    refresh_account_metadata,
    refresh_all_accounts_usage, rename_account, set_dock_display_mode,
    set_floating_usage_enabled, start_login,
    switch_account, warmup_account, warmup_all_accounts,
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
                        #[cfg(target_os = "macos")]
                        if commands::should_prompt_for_close_behavior() {
                            let payload = commands::window::next_close_behavior_prompt_payload();
                            let app_handle = tauri::Manager::app_handle(window);
                            commands::window::schedule_close_behavior_prompt_fallback(
                                app_handle.clone(),
                                payload.request_id,
                            );
                            let _ = window.emit(
                                commands::window::CLOSE_BEHAVIOR_REQUESTED_EVENT,
                                payload,
                            );
                            return;
                        }
                        commands::hide_main_window(&tauri::Manager::app_handle(window));
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_display_settings,
            commands::set_tray_display_mode,
            commands::open_codex_app,
            commands::get_codex_reopen_info,
            commands::reopen_closed_codex_desktop,
            // Account management
            list_accounts,
            get_active_account_info,
            add_account_from_file,
            add_account_from_cookie,
            switch_account,
            delete_account,
            rename_account,
            export_accounts_slim_text,
            import_accounts_slim_text,
            export_accounts_full_encrypted_file,
            import_accounts_full_encrypted_file,
            // OAuth
            start_login,
            complete_login,
            cancel_login,
            // Usage
            get_usage,
            get_account_usage_stats,
            refresh_account_metadata,
            refresh_all_accounts_usage,
            warmup_account,
            warmup_all_accounts,
            // Process detection
            check_codex_processes,
            kill_codex_processes,
            // Tray window
            hide_tray_window,
            open_main_window,
            quit_app,
            get_cached_usage,
            commands::get_codex_auth_path,
            commands::get_floating_usage_options,
            commands::set_usage_refresh_interval,
            commands::set_floating_usage_options,
            commands::resize_floating_usage,
            commands::wait_for_floating_drag_release,
            get_floating_usage_enabled,
            set_floating_usage_enabled,
            get_dock_display_mode,
            set_dock_display_mode,
            complete_close_behavior,
            ack_close_behavior_prompt,
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
