//! Account management Tauri commands

use crate::api::usage::{
    cache_chatgpt_cookie_session, clear_chatgpt_cookie_session, fetch_chatgpt_cookie_session,
    get_account_usage, normalize_chatgpt_cookie,
};
use crate::auth::{
    add_account,
    import_from_auth_json, import_from_auth_json_contents, load_accounts,
    remove_account, save_accounts,
};
use crate::types::{
    AccountInfo, AccountsStore, AuthData, ImportAccountsSummary, StoredAccount, UsageInfo,
};


use anyhow::Context;
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use flate2::{read::ZlibDecoder, write::ZlibEncoder, Compression};
use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use sha2::Sha256;
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};



const FULL_FILE_MAGIC: &[u8; 4] = b"CSWF";
const FULL_FILE_VERSION: u8 = 1;
const FULL_SALT_LEN: usize = 16;
const FULL_NONCE_LEN: usize = 24;
const FULL_KDF_ITERATIONS: u32 = 210_000;
const FULL_PRESET_PASSPHRASE: &str = "gT7kQ9mV2xN4pL8sR1dH6zW3cB5yF0uJ_aE7nK2tP9vM4rX1";

const MAX_IMPORT_JSON_BYTES: u64 = 2 * 1024 * 1024;
const MAX_IMPORT_FILE_BYTES: u64 = 8 * 1024 * 1024;

#[tauri::command]
pub fn get_codex_auth_path() -> Result<String, String> {
    crate::auth::get_codex_auth_file().map(|path| path.to_string_lossy().into_owned()).map_err(|error| error.to_string())
}

/// List all accounts with their info
#[tauri::command]
pub async fn list_accounts() -> Result<Vec<AccountInfo>, String> {
    let store = load_accounts().map_err(|e| e.to_string())?;
    let active_id = store.active_account_id.as_deref();

    let accounts: Vec<AccountInfo> = store
        .accounts
        .iter()
        .map(|a| {
            let mut info = AccountInfo::from_stored(a, active_id);
            super::usage::apply_cached_account_metadata(&mut info);
            info
        })
        .collect();

    Ok(accounts)
}

/// Add an account from an auth.json file
#[tauri::command]
pub async fn add_account_from_file(path: String, name: String) -> Result<AccountInfo, String> {
    // Import from the file
    let account = import_from_auth_json(&path, name).map_err(|e| e.to_string())?;

    // Add to storage
    let stored = add_account(account).map_err(|e| e.to_string())?;

    let store = load_accounts().map_err(|e| e.to_string())?;
    let active_id = store.active_account_id.as_deref();

    Ok(AccountInfo::from_stored(&stored, active_id))
}

/// Add an account from uploaded auth.json contents.
pub async fn add_account_from_auth_json_text(
    name: String,
    contents: String,
) -> Result<AccountInfo, String> {
    let account = import_from_auth_json_contents(&contents, name).map_err(|e| e.to_string())?;
    let stored = add_account(account).map_err(|e| e.to_string())?;

    let store = load_accounts().map_err(|e| e.to_string())?;
    let active_id = store.active_account_id.as_deref();

    Ok(AccountInfo::from_stored(&stored, active_id))
}

#[derive(serde::Serialize)]
pub struct AddedCookieAccount {
    account: AccountInfo,
    usage: UsageInfo,
}

/// Add a usage-only account from a ChatGPT browser session cookie.
#[tauri::command]
pub async fn add_account_from_cookie(
    app: tauri::AppHandle,
    name: String,
    cookie: String,
) -> Result<AddedCookieAccount, String> {
    #[cfg(not(windows))]
    {
        let _ = (app, name, cookie);
        return Err("Cookie usage accounts are only supported on Windows".into());
    }

    #[cfg(windows)]
    {
        #[cfg(desktop)]
        let _refresh_guard = crate::tray::USAGE_REFRESH_LOCK.lock().await;
        let cookie = normalize_chatgpt_cookie(&cookie).map_err(|error| error.to_string())?;
        let session = fetch_chatgpt_cookie_session(&cookie)
            .await
            .map_err(|error| error.to_string())?;
        let mut account = StoredAccount::new_cookie(
            name,
            session.email.clone(),
            session.plan_type.clone(),
            session.account_id.clone(),
            cookie,
        );
        cache_chatgpt_cookie_session(&account.id, session);

        let mut usage = match get_account_usage(&account).await {
            Ok(usage) => usage,
            Err(error) => {
                clear_chatgpt_cookie_session(&account.id);
                return Err(error.to_string());
            }
        };
        if let Some(error) = usage.error.clone() {
            clear_chatgpt_cookie_session(&account.id);
            return Err(error);
        }
        account.plan_type = usage.plan_type.clone();

        let stored = match add_account(account) {
            Ok(stored) => stored,
            Err(error) => {
                clear_chatgpt_cookie_session(&usage.account_id);
                return Err(error.to_string());
            }
        };
        crate::api::usage::move_cookie_session_cache(&usage.account_id, &stored.id);
        usage.account_id = stored.id.clone();
        let store = load_accounts().map_err(|error| error.to_string())?;
        let active_id = store.active_account_id.as_deref();
        #[cfg(desktop)]
        crate::tray::ingest_usage(&app, vec![usage.clone()]);
        #[cfg(not(desktop))]
        let _ = app;

        Ok(AddedCookieAccount {
            account: AccountInfo::from_stored(&stored, active_id),
            usage,
        })
    }
}

/// Remove an account
#[tauri::command]
pub async fn delete_account(account_id: String) -> Result<(), String> {
    clear_chatgpt_cookie_session(&account_id);
    remove_account(&account_id).map_err(|e| e.to_string())?;
    Ok(())
}

/// Rename an account
#[tauri::command]
pub async fn rename_account(account_id: String, new_name: String) -> Result<(), String> {
    crate::auth::storage::update_account_metadata(&account_id, Some(new_name), None, None, None)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Export full account config as an encrypted file.
#[tauri::command]
pub async fn export_accounts_full_encrypted_file(path: String) -> Result<(), String> {
    let store = load_accounts().map_err(|e| e.to_string())?;
    let encrypted =
        encode_full_encrypted_store(&store, FULL_PRESET_PASSPHRASE).map_err(|e| e.to_string())?;
    write_encrypted_file(&path, &encrypted).map_err(|e| e.to_string())?;
    Ok(())
}

/// Export full account config as encrypted bytes for browser clients.
pub async fn export_accounts_full_encrypted_bytes() -> Result<Vec<u8>, String> {
    let store = load_accounts().map_err(|e| e.to_string())?;
    encode_full_encrypted_store(&store, FULL_PRESET_PASSPHRASE).map_err(|e| e.to_string())
}

/// Import full account config from an encrypted file, skipping existing accounts.
#[tauri::command]
pub async fn import_accounts_full_encrypted_file(
    path: String,
) -> Result<ImportAccountsSummary, String> {
    let encrypted = read_encrypted_file(&path).map_err(|e| e.to_string())?;
    let imported = decode_full_encrypted_store(&encrypted, FULL_PRESET_PASSPHRASE)
        .map_err(|e| e.to_string())?;
    validate_imported_store(&imported).map_err(|e| e.to_string())?;

    let current = load_accounts().map_err(|e| e.to_string())?;
    let (merged, summary) = merge_accounts_store(current, imported);
    save_accounts(&merged).map_err(|e| e.to_string())?;
    Ok(summary)
}

/// Import full account config from encrypted bytes uploaded through the browser UI.
pub async fn import_accounts_full_encrypted_bytes(
    bytes: Vec<u8>,
) -> Result<ImportAccountsSummary, String> {
    let imported =
        decode_full_encrypted_store(&bytes, FULL_PRESET_PASSPHRASE).map_err(|e| e.to_string())?;
    validate_imported_store(&imported).map_err(|e| e.to_string())?;

    let current = load_accounts().map_err(|e| e.to_string())?;
    let (merged, summary) = merge_accounts_store(current, imported);
    save_accounts(&merged).map_err(|e| e.to_string())?;
    Ok(summary)
}

fn encode_full_encrypted_store(store: &AccountsStore, passphrase: &str) -> anyhow::Result<Vec<u8>> {
    let mut payload = serde_json::to_value(store).context("Failed to serialize account store")?;
    let serialized_accounts = payload
        .get_mut("accounts")
        .and_then(serde_json::Value::as_array_mut)
        .context("Serialized account store has no account list")?;
    for (index, account) in store.accounts.iter().enumerate() {
        if let AuthData::Cookie { session_cookie, .. } = &account.auth_data {
            let auth_data = serialized_accounts[index]
                .get_mut("auth_data")
                .and_then(serde_json::Value::as_object_mut)
                .context("Serialized Cookie account has no auth data")?;
            auth_data.insert(
                "session_cookie".to_string(),
                serde_json::Value::String(session_cookie.clone()),
            );
        }
    }
    let json = serde_json::to_vec(&payload).context("Failed to serialize account store")?;
    let compressed = compress_bytes(&json).context("Failed to compress account store")?;

    let mut salt = [0u8; FULL_SALT_LEN];
    rand::rng().fill_bytes(&mut salt);

    let mut nonce = [0u8; FULL_NONCE_LEN];
    rand::rng().fill_bytes(&mut nonce);

    let key = derive_encryption_key(passphrase, &salt);
    let cipher = XChaCha20Poly1305::new((&key).into());
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), compressed.as_slice())
        .map_err(|_| anyhow::anyhow!("Failed to encrypt account store"))?;

    let mut out = Vec::with_capacity(4 + 1 + FULL_SALT_LEN + FULL_NONCE_LEN + ciphertext.len());
    out.extend_from_slice(FULL_FILE_MAGIC);
    out.push(FULL_FILE_VERSION);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);

    Ok(out)
}

fn decode_full_encrypted_store(
    file_bytes: &[u8],
    passphrase: &str,
) -> anyhow::Result<AccountsStore> {
    if file_bytes.len() as u64 > MAX_IMPORT_FILE_BYTES {
        anyhow::bail!("Encrypted file is too large");
    }

    let header_len = 4 + 1 + FULL_SALT_LEN + FULL_NONCE_LEN;
    if file_bytes.len() <= header_len {
        anyhow::bail!("Encrypted file is invalid or truncated");
    }

    if &file_bytes[..4] != FULL_FILE_MAGIC {
        anyhow::bail!("Encrypted file header is invalid");
    }

    let version = file_bytes[4];
    if version != FULL_FILE_VERSION {
        anyhow::bail!("Unsupported encrypted file version: {version}");
    }

    let salt_start = 5;
    let nonce_start = salt_start + FULL_SALT_LEN;
    let ciphertext_start = nonce_start + FULL_NONCE_LEN;

    let salt = &file_bytes[salt_start..nonce_start];
    let nonce = &file_bytes[nonce_start..ciphertext_start];
    let ciphertext = &file_bytes[ciphertext_start..];

    let key = derive_encryption_key(passphrase, salt);
    let cipher = XChaCha20Poly1305::new((&key).into());
    let compressed = cipher
        .decrypt(XNonce::from_slice(nonce), ciphertext)
        .map_err(|_| {
            anyhow::anyhow!("Failed to decrypt file (wrong passphrase or corrupted file)")
        })?;

    let json = decompress_bytes_with_limit(&compressed, MAX_IMPORT_JSON_BYTES)
        .context("Failed to decompress decrypted payload")?;

    let store: AccountsStore =
        serde_json::from_slice(&json).context("Failed to parse decrypted account payload")?;

    Ok(store)
}

fn derive_encryption_key(passphrase: &str, salt: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(passphrase.as_bytes(), salt, FULL_KDF_ITERATIONS, &mut key);
    key
}

fn compress_bytes(input: &[u8]) -> anyhow::Result<Vec<u8>> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::best());
    encoder.write_all(input)?;
    encoder.finish().context("Failed to finalize compression")
}

fn decompress_bytes_with_limit(input: &[u8], max_bytes: u64) -> anyhow::Result<Vec<u8>> {
    let mut decoder = ZlibDecoder::new(input);
    let mut limited = decoder.by_ref().take(max_bytes + 1);
    let mut decompressed = Vec::new();
    limited.read_to_end(&mut decompressed)?;

    if decompressed.len() as u64 > max_bytes {
        anyhow::bail!("Import data is too large");
    }

    Ok(decompressed)
}

fn write_encrypted_file(path: &str, bytes: &[u8]) -> anyhow::Result<()> {
    fs::write(path, bytes).with_context(|| format!("Failed to write file: {path}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .with_context(|| format!("Failed to set file permissions: {path}"))?;
    }

    Ok(())
}

fn read_encrypted_file(path: &str) -> anyhow::Result<Vec<u8>> {
    let metadata =
        fs::metadata(path).with_context(|| format!("Failed to read file metadata: {path}"))?;
    if metadata.len() > MAX_IMPORT_FILE_BYTES {
        anyhow::bail!("Encrypted file is too large");
    }

    fs::read(path).with_context(|| format!("Failed to read file: {path}"))
}

fn validate_imported_store(store: &AccountsStore) -> anyhow::Result<()> {
    #[cfg(not(windows))]
    if store
        .accounts
        .iter()
        .any(|account| matches!(&account.auth_data, AuthData::Cookie { .. }))
    {
        anyhow::bail!("Cookie usage accounts are only supported on Windows");
    }

    let mut ids = HashSet::new();

    for account in &store.accounts {
        if account.id.trim().is_empty() {
            anyhow::bail!("Import contains an account with empty id");
        }
        if account.name.trim().is_empty() {
            anyhow::bail!("Import contains an account with empty name");
        }
        if !ids.insert(account.id.clone()) {
            anyhow::bail!("Import contains duplicate account id: {}", account.id);
        }
    }

    if let Some(active_id) = &store.active_account_id {
        if !ids.contains(active_id) {
            anyhow::bail!("Import references a missing active account: {active_id}");
        }
    }

    Ok(())
}

fn merge_accounts_store(
    mut current: AccountsStore,
    imported: AccountsStore,
) -> (AccountsStore, ImportAccountsSummary) {
    let imported_version = imported.version;
    let imported_active_id = imported.active_account_id;
    let total_in_payload = imported.accounts.len();
    let mut imported_count = 0usize;
    let mut existing_ids: HashSet<String> = current.accounts.iter().map(|a| a.id.clone()).collect();
    for account in imported.accounts {
        if existing_ids.contains(&account.id) || current.accounts.iter().any(|existing| crate::auth::same_account_credentials(existing, &account)) {
            continue;
        }
        existing_ids.insert(account.id.clone());
        current.accounts.push(account);
        imported_count += 1;
    }

    current.version = current.version.max(imported_version).max(1);

    let is_codex_account = |account: &StoredAccount| {
        !matches!(&account.auth_data, AuthData::Cookie { .. })
    };
    let current_active_is_valid = current
        .active_account_id
        .as_ref()
        .and_then(|id| current.accounts.iter().find(|account| &account.id == id))
        .is_some_and(is_codex_account);

    if !current_active_is_valid {
        current.active_account_id = imported_active_id
            .filter(|id| {
                current
                    .accounts
                    .iter()
                    .find(|account| &account.id == id)
                    .is_some_and(is_codex_account)
            })
            .or_else(|| {
                current
                    .accounts
                    .iter()
                    .find(|account| is_codex_account(account))
                    .map(|account| account.id.clone())
            });
    }

    (
        current,
        ImportAccountsSummary {
            total_in_payload,
            imported_count,
            skipped_count: total_in_payload.saturating_sub(imported_count),
        },
    )
}

#[cfg(test)]
mod account_merge_tests {
    use super::merge_accounts_store;
    use crate::types::{AccountsStore, StoredAccount};

    fn cookie_account(name: &str) -> StoredAccount {
        StoredAccount::new_cookie(name.into(), None, None, None, "session=sample".into())
    }

    fn codex_account(name: &str) -> StoredAccount {
        StoredAccount::new_api_key(name.into(), "key-sample".into())
    }

    fn store(accounts: Vec<StoredAccount>, active_account_id: Option<String>) -> AccountsStore {
        AccountsStore {
            accounts,
            active_account_id,
            ..AccountsStore::default()
        }
    }

    #[test]
    fn same_name_different_login_sources_import_together() {
        let imported = store(vec![cookie_account("same@example.com"), codex_account("same@example.com")], None);
        super::validate_imported_store(&imported).unwrap();
        let (merged, summary) = merge_accounts_store(AccountsStore::default(), imported);
        assert_eq!(merged.accounts.len(), 2);
        assert_eq!(summary.imported_count, 2);
    }

    #[test]
    fn cookie_only_import_does_not_create_an_active_codex_account() {
        let imported = store(vec![cookie_account("Cookie")], None);

        let (merged, _) = merge_accounts_store(AccountsStore::default(), imported);

        assert_eq!(merged.active_account_id, None);
    }

    #[test]
    fn import_fallback_skips_cookie_accounts() {
        let cookie = cookie_account("Cookie");
        let codex = codex_account("Codex");
        let codex_id = codex.id.clone();
        let imported = store(vec![cookie, codex], None);

        let (merged, _) = merge_accounts_store(AccountsStore::default(), imported);

        assert_eq!(merged.active_account_id.as_deref(), Some(codex_id.as_str()));
    }

    #[test]
    fn imported_cookie_active_id_is_ignored() {
        let cookie = cookie_account("Cookie");
        let cookie_id = cookie.id.clone();
        let codex = codex_account("Codex");
        let codex_id = codex.id.clone();
        let imported = store(vec![cookie, codex], Some(cookie_id));

        let (merged, _) = merge_accounts_store(AccountsStore::default(), imported);

        assert_eq!(merged.active_account_id.as_deref(), Some(codex_id.as_str()));
    }
}
