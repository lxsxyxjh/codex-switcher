//! Usage query Tauri commands

use crate::api::usage::{
    fetch_chatgpt_account_metadata, get_account_usage,
    ChatGptAccountMetadata,
};
use crate::auth::{
    ensure_chatgpt_tokens_fresh, get_account, load_accounts, update_account_metadata,
};
use crate::types::{AccountInfo, AuthData, UsageInfo};
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
};

static ACCOUNT_METADATA_CACHE: LazyLock<Mutex<HashMap<String, ChatGptAccountMetadata>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub(crate) fn retain_account_metadata(account_ids: &std::collections::HashSet<String>) {
    if let Ok(mut cache) = ACCOUNT_METADATA_CACHE.lock() {
        cache.retain(|id, _| account_ids.contains(id));
    }
}

pub(crate) fn apply_cached_account_metadata(account: &mut AccountInfo) {
    let Ok(cache) = ACCOUNT_METADATA_CACHE.lock() else {
        return;
    };
    let Some(metadata) = cache.get(&account.id) else {
        return;
    };

    if metadata.plan_type.is_some() {
        account.plan_type = metadata.plan_type.clone();
    }
    account.subscription_expires_at = metadata.subscription_expires_at;
}

/// Fetch usage info for a specific account (shared by the Tauri command and web mode).
pub async fn fetch_usage(account_id: &str) -> Result<UsageInfo, String> {
    let account = get_account(account_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Account not found: {account_id}"))?;

    get_account_usage(&account).await.map_err(|e| e.to_string())
}

/// Get usage info for a specific account
#[tauri::command]
pub async fn get_usage(app: tauri::AppHandle, account_id: String, source: Option<String>) -> Result<UsageInfo, String> {
    #[cfg(desktop)]
    let _refresh_guard = crate::tray::USAGE_REFRESH_LOCK.lock().await;
    crate::api::usage::write_usage_log(&format!("刷新触发 account={account_id} source={}", source.as_deref().unwrap_or("账户按钮")));
    let result = fetch_usage(&account_id).await;

    // Keep the tray menu/title in sync with whichever UI fetched fresh usage.
    #[cfg(desktop)]
    crate::tray::ingest_usage(&app, vec![match &result {
        Ok(usage) => usage.clone(),
        Err(error) => UsageInfo::error(account_id, error.clone()),
    }]);
    #[cfg(not(desktop))]
    let _ = app;

    result
}

/// Refresh account metadata for a specific account.
/// For ChatGPT accounts this ensures OAuth tokens are valid and pulls live subscription metadata.
/// For API key accounts this is a no-op.
#[tauri::command]
pub async fn refresh_account_metadata(account_id: String) -> Result<AccountInfo, String> {
    #[cfg(desktop)]
    let _refresh_guard = crate::tray::USAGE_REFRESH_LOCK.lock().await;
    crate::api::usage::write_usage_log(&format!("订阅信息刷新开始 account={account_id}"));
    let account = get_account(&account_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Account not found: {account_id}"))?;

    let (updated, live_metadata) = match &account.auth_data {
        AuthData::ApiKey { .. } | AuthData::Cookie { .. } => (account, None),
        AuthData::ChatGPT { .. } => {
            let refreshed = ensure_chatgpt_tokens_fresh(&account)
                .await
                .map_err(|e| e.to_string())?;
            let live_metadata = fetch_chatgpt_account_metadata(&refreshed)
                .await
                .map_err(|e| e.to_string())?;

            update_account_metadata(
                &account_id,
                None,
                None,
                live_metadata.plan_type.clone(),
                None,
            )
            .map_err(|e| e.to_string())?;

            ACCOUNT_METADATA_CACHE
                .lock()
                .map_err(|_| "Account metadata cache is unavailable".to_string())?
                .insert(account_id.clone(), live_metadata.clone());

            (refreshed, Some(live_metadata))
        }
    };

    let store = load_accounts().map_err(|e| e.to_string())?;
    let active_id = store.active_account_id.as_deref();
    let mut info = AccountInfo::from_stored(&updated, active_id);
    if let Some(metadata) = live_metadata {
        if metadata.plan_type.is_some() {
            info.plan_type = metadata.plan_type;
        }
        info.subscription_expires_at = metadata.subscription_expires_at;
    }
    Ok(info)
}

#[tauri::command]
pub fn open_usage_log(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    crate::api::usage::write_usage_log("打开额度刷新日志");
    let path = crate::auth::get_config_dir().map_err(|error| error.to_string())?.join("usage.log");
    app.opener().open_path(path.to_string_lossy(), None::<&str>).map_err(|error| error.to_string())
}
