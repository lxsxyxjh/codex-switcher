//! Core types for Codex Switcher

use base64::Engine;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// The main storage structure for all accounts
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountsStore {
    /// Schema version for future migrations
    pub version: u32,
    /// List of all stored accounts
    pub accounts: Vec<StoredAccount>,
    /// Currently active account ID
    pub active_account_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrayDisplayMode {
    IconAndSession,
    #[default]
    ActiveUsageText,
    Hidden,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DockDisplayMode {
    #[default]
    ShowInDock,
    MenuBarOnly,
}

fn default_floating_usage_scale() -> u16 {
    100
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    pub account_usage_refresh_intervals: std::collections::HashMap<String, u64>,
    pub tray_display_mode: TrayDisplayMode,
    pub dock_display_mode: DockDisplayMode,
    #[serde(default)]
    pub floating_usage_enabled: bool,
    #[serde(default)]
    pub floating_usage_position: Option<FloatingUsagePosition>,
    #[serde(default = "default_floating_usage_scale")]
    pub floating_usage_scale: u16,
    #[serde(default)]
    pub floating_usage_account_id: Option<String>,
    #[serde(default)]
    pub floating_usage_show_used: bool,
    pub floating_usage_vertical: bool,
    pub floating_usage_edge_hide: bool,
    pub floating_usage_edge: Option<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            account_usage_refresh_intervals: std::collections::HashMap::new(),
            tray_display_mode: TrayDisplayMode::default(),
            dock_display_mode: DockDisplayMode::default(),
            floating_usage_enabled: false,
            floating_usage_position: None,
            floating_usage_scale: 100,
            floating_usage_account_id: None,
            floating_usage_show_used: false,
            floating_usage_vertical: false,
            floating_usage_edge_hide: false,
            floating_usage_edge: None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct FloatingUsagePosition {
    pub x: i32,
    pub y: i32,
}

impl Default for AccountsStore {
    fn default() -> Self {
        Self {
            version: 1,
            accounts: Vec::new(),
            active_account_id: None,
        }
    }
}

/// A stored account with all its metadata and credentials
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredAccount {
    /// Unique identifier (UUID)
    pub id: String,
    /// User-defined display name
    pub name: String,
    /// Email extracted from ID token (for ChatGPT auth)
    pub email: Option<String>,
    /// Plan type: free, plus, pro, team, business, enterprise, edu
    pub plan_type: Option<String>,
    /// Subscription expiration extracted from ChatGPT ID token, when available
    #[serde(default)]
    pub subscription_expires_at: Option<DateTime<Utc>>,
    /// Authentication mode
    pub auth_mode: AuthMode,
    /// Authentication credentials
    pub auth_data: AuthData,
    /// When the account was added
    pub created_at: DateTime<Utc>,
    /// Last time this account was used
    pub last_used_at: Option<DateTime<Utc>>,
}

impl StoredAccount {
    fn resolved_name(
        name: String,
        email: Option<&String>,
        account_id: Option<&String>,
        kind: &str,
    ) -> String {
        if !name.trim().is_empty() {
            return name;
        }
        if let Some(email) = email.filter(|email| !email.trim().is_empty()) {
            return email.clone();
        }
        if let Some(account_id) = account_id.filter(|id| !id.trim().is_empty()) {
            let suffix: String = account_id
                .chars()
                .rev()
                .take(8)
                .collect::<String>()
                .chars()
                .rev()
                .collect();
            return format!("{kind} account ({suffix})");
        }
        format!("{kind} account")
    }

    /// Create a new account with API key authentication
    pub fn new_api_key(name: String, api_key: String) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            name: Self::resolved_name(name, None, None, "API key"),
            email: None,
            plan_type: None,
            subscription_expires_at: None,
            auth_mode: AuthMode::ApiKey,
            auth_data: AuthData::ApiKey { key: api_key },
            created_at: Utc::now(),
            last_used_at: None,
        }
    }

    /// Create a new account with ChatGPT OAuth authentication
    pub fn new_chatgpt(
        name: String,
        email: Option<String>,
        plan_type: Option<String>,
        subscription_expires_at: Option<DateTime<Utc>>,
        id_token: String,
        access_token: String,
        refresh_token: String,
        account_id: Option<String>,
    ) -> Self {
        let name = Self::resolved_name(name, email.as_ref(), account_id.as_ref(), "ChatGPT");
        Self {
            id: Uuid::new_v4().to_string(),
            name,
            email,
            plan_type,
            subscription_expires_at,
            auth_mode: AuthMode::ChatGPT,
            auth_data: AuthData::ChatGPT {
                id_token,
                access_token,
                refresh_token,
                account_id,
            },
            created_at: Utc::now(),
            last_used_at: None,
        }
    }

    /// Create a usage-only account from a ChatGPT browser session cookie
    pub fn new_cookie(
        name: String,
        email: Option<String>,
        plan_type: Option<String>,
        account_id: Option<String>,
        session_cookie: String,
    ) -> Self {
        let name = Self::resolved_name(name, email.as_ref(), account_id.as_ref(), "Cookie");
        Self {
            id: Uuid::new_v4().to_string(),
            name,
            email,
            plan_type,
            subscription_expires_at: None,
            auth_mode: AuthMode::Cookie,
            auth_data: AuthData::Cookie {
                session_cookie,
                account_id,
            },
            created_at: Utc::now(),
            last_used_at: None,
        }
    }
}

#[cfg(test)]
mod account_name_tests {
    use super::StoredAccount;

    #[test]
    fn blank_name_defaults_to_email() {
        let account = StoredAccount::new_chatgpt(
            "".into(),
            Some("user@example.com".into()),
            None,
            None,
            "id".into(),
            "access".into(),
            "refresh".into(),
            Some("acct-12345678".into()),
        );
        assert_eq!(account.name, "user@example.com");
    }

    #[test]
    fn explicit_name_is_preserved() {
        let account = StoredAccount::new_chatgpt(
            "  My Account  ".into(),
            Some("user@example.com".into()),
            None,
            None,
            "id".into(),
            "access".into(),
            "refresh".into(),
            None,
        );
        assert_eq!(account.name, "  My Account  ");
    }

    #[test]
    fn missing_email_uses_account_id_suffix() {
        let account = StoredAccount::new_chatgpt(
            "".into(),
            None,
            None,
            None,
            "id".into(),
            "access".into(),
            "refresh".into(),
            Some("acct-12345678".into()),
        );
        assert_eq!(account.name, "ChatGPT account (12345678)");
    }

    #[test]
    fn missing_email_and_account_id_use_generic_fallback() {
        let account = StoredAccount::new_chatgpt(
            "".into(),
            None,
            None,
            None,
            "id".into(),
            "access".into(),
            "refresh".into(),
            None,
        );
        assert_eq!(account.name, "ChatGPT account");
    }
}

#[cfg(all(test, windows))]
mod cookie_storage_tests {
    use super::{AuthData, StoredAccount};

    #[test]
    fn cookie_credentials_are_protected_in_serialized_accounts() {
        let account = StoredAccount::new_cookie(
            "Cookie test".into(),
            None,
            None,
            None,
            "session=sample".into(),
        );
        let serialized = serde_json::to_string(&account.auth_data).unwrap();
        assert!(!serialized.contains("session=sample"));
        assert!(serialized.contains("dpapi:"));

        let restored: AuthData = serde_json::from_str(&serialized).unwrap();
        let AuthData::Cookie { session_cookie, .. } = restored else {
            panic!("expected Cookie account data");
        };
        assert_eq!(session_cookie, "session=sample");
    }
}

/// Authentication mode
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthMode {
    /// Using an OpenAI API key
    ApiKey,
    /// Using ChatGPT OAuth tokens
    ChatGPT,
    /// Using a ChatGPT browser session cookie for usage only
    Cookie,
}

/// Authentication data (credentials)
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AuthData {
    /// API key authentication
    ApiKey {
        /// The API key
        key: String,
    },
    /// ChatGPT OAuth authentication
    ChatGPT {
        /// JWT ID token containing user info
        id_token: String,
        /// Access token for API calls
        access_token: String,
        /// Refresh token for token renewal
        refresh_token: String,
        /// ChatGPT account ID
        account_id: Option<String>,
    },
    /// ChatGPT browser session cookie used to read usage without changing Codex login
    Cookie {
        #[serde(with = "protected_cookie")]
        session_cookie: String,
        account_id: Option<String>,
    },
}

impl std::fmt::Debug for AuthData {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ApiKey { .. } => formatter.write_str("ApiKey { key: [REDACTED] }"),
            Self::ChatGPT { account_id, .. } => formatter
                .debug_struct("ChatGPT")
                .field("tokens", &"[REDACTED]")
                .field("account_id", account_id)
                .finish(),
            Self::Cookie { account_id, .. } => formatter
                .debug_struct("Cookie")
                .field("session_cookie", &"[REDACTED]")
                .field("account_id", account_id)
                .finish(),
        }
    }
}

mod protected_cookie {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(value: &String, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let protected = protect(value).map_err(serde::ser::Error::custom)?;
        serializer.serialize_str(&protected)
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<String, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        unprotect(&value).map_err(serde::de::Error::custom)
    }

    #[cfg(windows)]
    fn protect(value: &str) -> Result<String, String> {
        use std::{ffi::c_void, ptr};

        #[repr(C)]
        struct DataBlob {
            size: u32,
            data: *mut u8,
        }

        #[link(name = "Crypt32")]
        unsafe extern "system" {
            fn CryptProtectData(
                input: *const DataBlob,
                description: *const u16,
                entropy: *const DataBlob,
                reserved: *mut c_void,
                prompt: *const c_void,
                flags: u32,
                output: *mut DataBlob,
            ) -> i32;
        }

        #[link(name = "Kernel32")]
        unsafe extern "system" {
            fn LocalFree(memory: *mut c_void) -> *mut c_void;
        }

        let bytes = value.as_bytes();
        let size = u32::try_from(bytes.len()).map_err(|_| "Cookie is too large".to_string())?;
        let input = DataBlob {
            size,
            data: bytes.as_ptr() as *mut u8,
        };
        let mut output = DataBlob {
            size: 0,
            data: ptr::null_mut(),
        };
        let succeeded = unsafe {
            CryptProtectData(
                &input,
                ptr::null(),
                ptr::null(),
                ptr::null_mut(),
                ptr::null(),
                1,
                &mut output,
            )
        };
        if succeeded == 0 {
            return Err("Windows could not protect the Cookie for this user".to_string());
        }

        let protected = unsafe {
            std::slice::from_raw_parts(output.data, output.size as usize).to_vec()
        };
        unsafe {
            LocalFree(output.data.cast());
        }
        Ok(format!("dpapi:{}", URL_SAFE_NO_PAD.encode(protected)))
    }

    #[cfg(not(windows))]
    fn protect(value: &str) -> Result<String, String> {
        Ok(value.to_string())
    }

    #[cfg(windows)]
    fn unprotect(value: &str) -> Result<String, String> {
        use std::{ffi::c_void, ptr};

        #[repr(C)]
        struct DataBlob {
            size: u32,
            data: *mut u8,
        }

        #[link(name = "Crypt32")]
        unsafe extern "system" {
            fn CryptUnprotectData(
                input: *const DataBlob,
                description: *mut *mut u16,
                entropy: *const DataBlob,
                reserved: *mut c_void,
                prompt: *const c_void,
                flags: u32,
                output: *mut DataBlob,
            ) -> i32;
        }

        #[link(name = "Kernel32")]
        unsafe extern "system" {
            fn LocalFree(memory: *mut c_void) -> *mut c_void;
        }

        let Some(encoded) = value.strip_prefix("dpapi:") else {
            return Ok(value.to_string());
        };
        let mut bytes = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| "Protected Cookie data is invalid".to_string())?;
        let size = u32::try_from(bytes.len())
            .map_err(|_| "Protected Cookie data is too large".to_string())?;
        let input = DataBlob {
            size,
            data: bytes.as_mut_ptr(),
        };
        let mut output = DataBlob {
            size: 0,
            data: ptr::null_mut(),
        };
        let succeeded = unsafe {
            CryptUnprotectData(
                &input,
                ptr::null_mut(),
                ptr::null(),
                ptr::null_mut(),
                ptr::null(),
                1,
                &mut output,
            )
        };
        if succeeded == 0 {
            return Err("This Cookie is protected for a different Windows user".to_string());
        }

        let unprotected = unsafe {
            std::slice::from_raw_parts(output.data, output.size as usize).to_vec()
        };
        unsafe {
            LocalFree(output.data.cast());
        }
        String::from_utf8(unprotected).map_err(|_| "Protected Cookie data is not UTF-8".to_string())
    }

    #[cfg(not(windows))]
    fn unprotect(value: &str) -> Result<String, String> {
        Ok(value.to_string())
    }
}

#[derive(Debug, Clone, Default)]
pub struct ChatGptIdTokenClaims {
    pub email: Option<String>,
    pub plan_type: Option<String>,
    pub account_id: Option<String>,
    pub subscription_expires_at: Option<DateTime<Utc>>,
}

pub fn parse_chatgpt_id_token_claims(id_token: &str) -> ChatGptIdTokenClaims {
    let parts: Vec<&str> = id_token.split('.').collect();
    if parts.len() != 3 {
        return ChatGptIdTokenClaims::default();
    }

    let payload = match base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(parts[1]) {
        Ok(bytes) => bytes,
        Err(_) => return ChatGptIdTokenClaims::default(),
    };

    let json: serde_json::Value = match serde_json::from_slice(&payload) {
        Ok(value) => value,
        Err(_) => return ChatGptIdTokenClaims::default(),
    };

    let auth_claims = json.get("https://api.openai.com/auth");

    ChatGptIdTokenClaims {
        email: json.get("email").and_then(|v| v.as_str()).map(String::from),
        plan_type: auth_claims
            .and_then(|auth| auth.get("chatgpt_plan_type"))
            .and_then(|v| v.as_str())
            .map(String::from),
        account_id: auth_claims
            .and_then(|auth| auth.get("chatgpt_account_id"))
            .and_then(|v| v.as_str())
            .map(String::from),
        subscription_expires_at: auth_claims
            .and_then(|auth| auth.get("chatgpt_subscription_active_until"))
            .and_then(|v| v.as_str())
            .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
            .map(|value| value.with_timezone(&Utc)),
    }
}

// ============================================================================
// Types for Codex's auth.json format (for compatibility)
// ============================================================================

/// The official Codex auth.json format
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthDotJson {
    /// OpenAI API key (for API key auth mode)
    #[serde(rename = "OPENAI_API_KEY", skip_serializing_if = "Option::is_none")]
    pub openai_api_key: Option<String>,
    /// OAuth tokens (for ChatGPT auth mode)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<TokenData>,
    /// Last token refresh timestamp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_refresh: Option<DateTime<Utc>>,
}

/// Token data stored in auth.json
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenData {
    /// JWT ID token
    pub id_token: String,
    /// Access token
    pub access_token: String,
    /// Refresh token
    pub refresh_token: String,
    /// Account ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
}

// ============================================================================
// Types for frontend communication
// ============================================================================

/// Account info sent to the frontend (without sensitive data)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountInfo {
    pub id: String,
    pub name: String,
    pub email: Option<String>,
    pub plan_type: Option<String>,
    pub subscription_expires_at: Option<DateTime<Utc>>,
    pub auth_mode: AuthMode,
    pub is_active: bool,
    pub created_at: DateTime<Utc>,
    pub last_used_at: Option<DateTime<Utc>>,
}

impl AccountInfo {
    pub fn from_stored(account: &StoredAccount, active_id: Option<&str>) -> Self {
        Self {
            id: account.id.clone(),
            name: account.name.clone(),
            email: account.email.clone(),
            plan_type: account.plan_type.clone(),
            // Subscription expiry is live account metadata. Stored values and
            // ID-token claims become stale and must not be used for display.
            subscription_expires_at: None,
            auth_mode: account.auth_mode,
            is_active: active_id == Some(&account.id),
            created_at: account.created_at,
            last_used_at: account.last_used_at,
        }
    }
}

/// Usage information for an account
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageInfo {
    #[serde(default)]
    pub fetched_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub attempted_at: Option<DateTime<Utc>>,
    /// Account ID
    pub account_id: String,
    /// Plan type
    pub plan_type: Option<String>,
    /// Primary rate limit window usage (percentage 0-100)
    pub primary_used_percent: Option<f64>,
    /// Primary window duration in minutes
    pub primary_window_minutes: Option<i64>,
    /// Primary window reset timestamp (unix seconds)
    pub primary_resets_at: Option<i64>,
    /// Secondary rate limit window usage (percentage 0-100)
    pub secondary_used_percent: Option<f64>,
    /// Secondary window duration in minutes
    pub secondary_window_minutes: Option<i64>,
    /// Secondary window reset timestamp (unix seconds)
    pub secondary_resets_at: Option<i64>,
    /// Whether the account has credits
    pub has_credits: Option<bool>,
    /// Whether credits are unlimited
    pub unlimited_credits: Option<bool>,
    /// Remaining Codex Credits balance
    pub credits_balance: Option<String>,
    /// Error message if usage fetch failed
    pub error: Option<String>,
}

impl UsageInfo {
    pub fn retain_previous_on_error(self, previous: Option<&Self>) -> Self {
        if self.error.is_some() {
            if let Some(previous) = previous.filter(|previous| previous.account_id == self.account_id) {
                let mut retained = previous.clone();
                retained.attempted_at = self.attempted_at;
                retained.error = self.error;
                return retained;
            }
        }
        self
    }

    pub fn error(account_id: String, error: String) -> Self {
        Self {
            fetched_at: None,
            attempted_at: Some(Utc::now()),
            account_id,
            plan_type: None,
            primary_used_percent: None,
            primary_window_minutes: None,
            primary_resets_at: None,
            secondary_used_percent: None,
            secondary_window_minutes: None,
            secondary_resets_at: None,
            has_credits: None,
            unlimited_credits: None,
            credits_balance: None,
            error: Some(error),
        }
    }
}

/// Import summary for account config import operations.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportAccountsSummary {
    /// Number of accounts found in the imported payload.
    pub total_in_payload: usize,
    /// Number of accounts actually imported.
    pub imported_count: usize,
    /// Number of accounts skipped because they already exist.
    pub skipped_count: usize,
}

/// OAuth login information returned to frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthLoginInfo {
    /// The authorization URL to open in browser
    pub auth_url: String,
    /// The local callback port
    pub callback_port: u16,
}

// ============================================================================
// API Response types (from Codex backend)
// ============================================================================

/// Rate limit status from API
#[derive(Debug, Clone, Deserialize)]
pub struct RateLimitStatusPayload {
    pub plan_type: String,
    #[serde(default)]
    pub rate_limit: Option<RateLimitDetails>,
    #[serde(default)]
    pub credits: Option<CreditStatusDetails>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RateLimitDetails {
    pub primary_window: Option<RateLimitWindow>,
    pub secondary_window: Option<RateLimitWindow>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RateLimitWindow {
    pub used_percent: f64,
    pub limit_window_seconds: Option<i32>,
    pub reset_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreditStatusDetails {
    pub has_credits: bool,
    pub unlimited: bool,
    #[serde(default)]
    pub balance: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::{
        parse_chatgpt_id_token_claims, AccountInfo, AppSettings, DockDisplayMode, StoredAccount,
        TrayDisplayMode,
    };
    use base64::Engine;
    use chrono::{TimeZone, Utc};

    #[test]
    fn usage_failure_preserves_values_and_success_clears_stale_status() {
        let mut previous = super::UsageInfo::error("first".into(), "old".into());
        previous.error = None;
        previous.fetched_at = Some(Utc.with_ymd_and_hms(2026, 10, 6, 1, 0, 0).unwrap());
        previous.attempted_at = previous.fetched_at;
        previous.primary_used_percent = Some(100.0);
        previous.credits_balance = Some("0".into());
        let failed = super::UsageInfo::error("first".into(), "offline".into()).retain_previous_on_error(Some(&previous));
        assert_eq!(failed.primary_used_percent, Some(100.0));
        assert_eq!(failed.credits_balance.as_deref(), Some("0"));
        assert_eq!(failed.error.as_deref(), Some("offline"));
        assert_eq!(failed.fetched_at, previous.fetched_at);
        assert!(failed.attempted_at > previous.attempted_at);
        let healthy = previous.clone().retain_previous_on_error(Some(&failed));
        assert!(healthy.error.is_none());
        let different = super::UsageInfo::error("second".into(), "offline".into()).retain_previous_on_error(Some(&previous));
        assert!(different.credits_balance.is_none());
    }

    #[test]
    fn existing_account_store_loads_after_removing_visibility_settings() {
        let account = StoredAccount::new_api_key("sample".into(), "sample-key".into());
        let payload = serde_json::json!({
            "version": 1,
            "accounts": [account],
            "active_account_id": "sample-id",
            "masked_account_ids": ["sample-id"]
        });
        let store: super::AccountsStore = serde_json::from_value(payload).unwrap();
        assert_eq!(store.accounts.len(), 1);
        assert_eq!(store.active_account_id.as_deref(), Some("sample-id"));
        let saved = serde_json::to_value(store).unwrap();
        assert!(saved.get("masked_account_ids").is_none());
    }

    #[test]
    fn parses_subscription_expiry_from_realistic_id_token_claims() {
        let payload = r#"{"email":"user@example.com","https://api.openai.com/auth":{"chatgpt_plan_type":"plus","chatgpt_account_id":"acc_123","chatgpt_subscription_active_until":"2026-04-23T05:03:38+00:00"}}"#;
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload);
        let token = format!("header.{encoded}.signature");

        let claims = parse_chatgpt_id_token_claims(&token);

        assert_eq!(claims.email.as_deref(), Some("user@example.com"));
        assert_eq!(claims.plan_type.as_deref(), Some("plus"));
        assert_eq!(claims.account_id.as_deref(), Some("acc_123"));
        assert_eq!(
            claims
                .subscription_expires_at
                .map(|value| value.to_rfc3339()),
            Some("2026-04-23T05:03:38+00:00".to_string())
        );
    }

    #[test]
    fn stored_subscription_expiry_is_not_exposed_as_live_metadata() {
        let stored_expiry = Utc.with_ymd_and_hms(2026, 8, 27, 5, 23, 19).unwrap();
        let account = StoredAccount::new_chatgpt(
            "account".into(),
            None,
            Some("plus".into()),
            Some(stored_expiry),
            "header.payload.signature".into(),
            "access".into(),
            "refresh".into(),
            Some("account-id".into()),
        );

        let info = AccountInfo::from_stored(&account, None);

        assert_eq!(info.subscription_expires_at, None);
    }

    #[test]
    fn app_settings_default_missing_dock_display_mode_to_show_in_dock() {
        let settings: AppSettings =
            serde_json::from_str(r#"{"tray_display_mode":"active_usage_text"}"#).unwrap();

        assert_eq!(settings.tray_display_mode, TrayDisplayMode::ActiveUsageText);
        assert_eq!(settings.dock_display_mode, DockDisplayMode::ShowInDock);
    }
}
