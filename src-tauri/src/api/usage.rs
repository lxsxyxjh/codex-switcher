//! Usage API client for fetching rate limits and credits

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, COOKIE, USER_AGENT},
    StatusCode,
};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
};

use crate::auth::{ensure_chatgpt_tokens_fresh, refresh_chatgpt_tokens};
use crate::types::{
    AuthData, CreditStatusDetails, RateLimitDetails, RateLimitStatusPayload, RateLimitWindow,
    StoredAccount, UsageInfo,
};

const CHATGPT_BACKEND_API: &str = "https://chatgpt.com/backend-api";
const CHATGPT_WEB_SESSION_API: &str = "https://chatgpt.com/api/auth/session";
const CHATGPT_ACCOUNTS_CHECK_API: &str =
    "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27";
const CHATGPT_ORIGIN: &str = "https://chatgpt.com";

/// A browser-like User-Agent to avoid Cloudflare bot detection.
/// Matches a recent Chrome on Windows, the same platform Codex CLI runs from.
const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
     AppleWebKit/537.36 (KHTML, like Gecko) \
     Chrome/136.0.0.0 Safari/537.36";
const SESSION_WINDOW_SECONDS: i32 = 5 * 60 * 60;
const WEEKLY_WINDOW_SECONDS: i32 = 7 * 24 * 60 * 60;
const COOKIE_TOKEN_CACHE_SECONDS: i64 = 60 * 30;

pub struct ChatGptCookieSession {
    pub access_token: String,
    pub email: Option<String>,
    pub plan_type: Option<String>,
    pub account_id: Option<String>,
    expires_at: i64,
}

#[derive(Clone)]
struct CachedCookieSession {
    access_token: String,
    account_id: Option<String>,
    expires_at: i64,
}

static COOKIE_SESSION_CACHE: LazyLock<Mutex<HashMap<String, CachedCookieSession>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static USAGE_LOG_LOCK: Mutex<()> = Mutex::new(());

pub fn write_usage_log(message: &str) {
    use std::io::Write;
    let Ok(_guard) = USAGE_LOG_LOCK.lock() else { return; };
    let Ok(directory) = crate::auth::get_config_dir() else { return; };
    if std::fs::create_dir_all(&directory).is_err() { return; }
    let path = directory.join("usage.log");
    if std::fs::metadata(&path).map(|metadata| metadata.len() > 5 * 1024 * 1024).unwrap_or(false) {
        let backup = directory.join("usage.previous.log");
        if backup.exists() && std::fs::remove_file(&backup).is_err() { return; }
        if std::fs::rename(&path, backup).is_err() { return; }
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let line = message.replace(['\r', '\n'], " ");
        let _ = writeln!(file, "{} {line}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"));
    }
}

pub(crate) async fn log_http_failure(account_id: &str, response: reqwest::Response) -> String {
    let status = response.status();
    let header = |name: &str| response.headers().get(name).and_then(|value| value.to_str().ok()).unwrap_or("--").to_string();
    let request_id = header("x-request-id");
    let ray = header("cf-ray");
    let retry_after = header("retry-after");
    let content_type = header("content-type");
    let endpoint = response.url().path().to_string();
    let body = response.text().await;
    // Only structured error codes are recorded; response bodies may contain credentials or account data.
    let details = match body {
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(value) => {
                let error = value.get("error").unwrap_or(&value);
                format!("error_code={} error_type={} message={}", error.get("code").and_then(Value::as_str).unwrap_or("--"), error.get("type").and_then(Value::as_str).unwrap_or("--"), diagnostic_text(error.get("message").or_else(|| value.get("detail")).and_then(Value::as_str).unwrap_or("--")))
            }
            Err(_) => {
                let lower = text.to_lowercase();
                let title = lower.find("<title>").and_then(|start| lower[start + 7..].find("</title>").map(|end| &text[start + 7..start + 7 + end])).unwrap_or("--");
                format!("response={} title={} bytes={} blocked={} challenge={}", "non-JSON", diagnostic_text(title), text.len(), lower.contains("blocked") || lower.contains("access denied"), lower.contains("just a moment") || lower.contains("cf-chl-"))
            },
        },
        Err(error) => format!("response_read_error={error}"),
    };
    write_usage_log(&format!("HTTP失败 account={account_id} endpoint={endpoint} status={status} request_id={request_id} cf_ray={ray} retry_after={retry_after} content_type={content_type} {details}"));
    format!("API error: {status}")
}

fn diagnostic_text(text: &str) -> String {
    text.split_whitespace().take(60).map(|part| {
        if part.len() > 100 || part.contains("eyJ") || part.contains("access_token") || part.contains("refresh_token") || part.contains("session-token") { "[redacted]" } else { part }
    }).collect::<Vec<_>>().join(" ").chars().take(600).collect()
}

#[derive(Debug, Clone)]
pub struct ChatGptAccountMetadata {
    pub plan_type: Option<String>,
    pub subscription_expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
struct AccountsCheckResponse {
    #[serde(default)]
    accounts: HashMap<String, AccountsCheckEntry>,
}

#[derive(Debug, Deserialize)]
struct AccountsCheckEntry {
    #[serde(default)]
    account: Option<AccountsCheckAccount>,
    #[serde(default)]
    entitlement: Option<AccountsCheckEntitlement>,
}

#[derive(Debug, Deserialize)]
struct AccountsCheckAccount {
    #[serde(default)]
    plan_type: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AccountsCheckEntitlement {
    #[serde(default)]
    expires_at: Option<DateTime<Utc>>,
}

/// Get usage information for an account
pub async fn get_account_usage(account: &StoredAccount) -> Result<UsageInfo> {
    let started = std::time::Instant::now();
    let method = match &account.auth_data { AuthData::Cookie { .. } => "Cookie", AuthData::ChatGPT { .. } => "Codex", AuthData::ApiKey { .. } => "API key" };
    let proxies = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"].into_iter().filter_map(|key| {
        std::env::var(key).ok().map(|value| {
            let endpoint = reqwest::Url::parse(&value).ok().map(|url| format!("{}://{}:{}", url.scheme(), url.host_str().unwrap_or("--"), url.port_or_known_default().unwrap_or(0))).unwrap_or_else(|| "已配置，格式无法解析".to_string());
            format!("{key}={endpoint}")
        })
    }).collect::<Vec<_>>().join(" ");
    write_usage_log(&format!("请求开始 account={} name={} method={method} proxy_config=自动读取环境变量及系统代理（不是实际连接路径证明） {proxies} no_proxy_configured={}", account.id, account.name, std::env::var_os("NO_PROXY").or_else(|| std::env::var_os("no_proxy")).is_some()));
    let result = match &account.auth_data {
        AuthData::ApiKey { .. } => Ok(UsageInfo {
            fetched_at: None,
            account_id: account.id.clone(),
            plan_type: Some("api_key".to_string()),
            primary_used_percent: None,
            primary_window_minutes: None,
            primary_resets_at: None,
            secondary_used_percent: None,
            secondary_window_minutes: None,
            secondary_resets_at: None,
            has_credits: None,
            unlimited_credits: None,
            credits_balance: None,
            error: Some("Usage info not available for API key accounts".to_string()),
        }),
        AuthData::ChatGPT { .. } => get_usage_with_chatgpt_auth(account).await,
        AuthData::Cookie { .. } => get_usage_with_cookie_auth(account).await,
    };
    let error = match &result { Ok(usage) => usage.error.clone(), Err(error) => Some(diagnostic_text(&format!("{error:#}"))) };
    write_usage_log(&format!("刷新结束 account={} method={method} duration_ms={} result={}", account.id, started.elapsed().as_millis(), error.as_deref().unwrap_or("成功")));
    result
}

pub async fn fetch_chatgpt_account_metadata(
    account: &StoredAccount,
) -> Result<ChatGptAccountMetadata> {
    let (access_token, chatgpt_account_id) = extract_chatgpt_auth(account)?;
    let response =
        send_chatgpt_get_request(CHATGPT_ACCOUNTS_CHECK_API, access_token, chatgpt_account_id)
            .await?;

    let status = response.status();
    if !status.is_success() {
        let error = log_http_failure(&account.id, response).await;
        anyhow::bail!("Accounts check failed: {error}");
    }

    let payload: AccountsCheckResponse = response
        .json()
        .await
        .context("Failed to parse accounts check response")?;

    let selected_entry = chatgpt_account_id
        .and_then(|account_id| payload.accounts.get(account_id))
        .or_else(|| payload.accounts.get("default"))
        .or_else(|| payload.accounts.values().next())
        .context("Accounts check response did not include an account entry")?;

    Ok(ChatGptAccountMetadata {
        plan_type: selected_entry
            .account
            .as_ref()
            .and_then(|account| account.plan_type.clone()),
        subscription_expires_at: selected_entry
            .entitlement
            .as_ref()
            .and_then(|entitlement| entitlement.expires_at),
    })
}

async fn get_usage_with_chatgpt_auth(account: &StoredAccount) -> Result<UsageInfo> {
    let fresh_account = ensure_chatgpt_tokens_fresh(account).await?;
    let (access_token, chatgpt_account_id) = extract_chatgpt_auth(&fresh_account)?;

    let response = send_chatgpt_usage_request(access_token, chatgpt_account_id).await?;

    // 401 means the token is genuinely expired — refresh and retry once.
    // 403 is a Cloudflare challenge or permissions error; refreshing the token
    // would burn the refresh token unnecessarily (refresh_token_reused error).
    if response.status() == StatusCode::UNAUTHORIZED {
        println!(
            "[Usage] Unauthorized for account {}, refreshing token and retrying once",
            fresh_account.name
        );
        let refreshed_account = refresh_chatgpt_tokens(&fresh_account).await?;
        let (retry_token, retry_account_id) = extract_chatgpt_auth(&refreshed_account)?;
        let retry_response = send_chatgpt_usage_request(retry_token, retry_account_id).await?;
        return parse_usage_response(
            &refreshed_account.id,
            &refreshed_account.name,
            retry_response,
        )
        .await;
    }

    parse_usage_response(&fresh_account.id, &fresh_account.name, response).await
}

pub fn normalize_chatgpt_cookie(input: &str) -> Result<String> {
    let value = input.trim();
    let cookie = if value
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("cookie:"))
    {
        &value[7..]
    } else {
        value
    }
    .trim();

    if cookie.is_empty() {
        anyhow::bail!("Paste a ChatGPT Cookie header.");
    }
    if cookie.starts_with("dpapi:") {
        anyhow::bail!("This Cookie is protected for a different Windows user");
    }
    if cookie.len() > 32 * 1024 {
        anyhow::bail!("The Cookie header is too large.");
    }
    HeaderValue::from_str(cookie).context("The Cookie header contains invalid characters")?;
    Ok(cookie.to_string())
}

pub async fn fetch_chatgpt_cookie_session(cookie: &str) -> Result<ChatGptCookieSession> {
    let cookie = normalize_chatgpt_cookie(cookie)?;
    write_usage_log("HTTP请求 GET /api/auth/session");
    let response = reqwest::Client::new()
        .get(CHATGPT_WEB_SESSION_API)
        .timeout(std::time::Duration::from_secs(30))
        .header(COOKIE, HeaderValue::from_str(&cookie)?)
        .header(USER_AGENT, BROWSER_USER_AGENT)
        .header("accept", "application/json")
        .header("origin", CHATGPT_ORIGIN)
        .header("referer", CHATGPT_ORIGIN)
        .send()
        .await
        .context("Failed to check the ChatGPT browser session")?;
    write_usage_log(&format!("HTTP响应 GET /api/auth/session status={}", response.status()));

    if !response.status().is_success() {
        let error = log_http_failure("Cookie session", response).await;
        anyhow::bail!("ChatGPT browser session failed: {error}");
    }

    let payload: Value = response
        .json()
        .await
        .context("Failed to parse the ChatGPT browser session response")?;
    let access_token = payload
        .get("accessToken")
        .or_else(|| payload.get("access_token"))
        .or_else(|| payload.pointer("/data/accessToken"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .context("The ChatGPT session did not provide an access token")?
        .to_string();

    let claims = crate::types::parse_chatgpt_id_token_claims(&access_token);
    let email = payload
        .pointer("/user/email")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or(claims.email);
    let account_id = payload
        .get("account_id")
        .or_else(|| payload.pointer("/account/id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or(claims.account_id);

    Ok(ChatGptCookieSession {
        access_token,
        email,
        plan_type: claims.plan_type,
        account_id,
        expires_at: Utc::now().timestamp() + COOKIE_TOKEN_CACHE_SECONDS,
    })
}

async fn get_cookie_session(account: &StoredAccount) -> Result<CachedCookieSession> {
    let AuthData::Cookie {
        session_cookie,
        account_id,
    } = &account.auth_data
    else {
        anyhow::bail!("Account is not using Cookie authentication");
    };

    let now = Utc::now().timestamp();
    if let Some(cached) = COOKIE_SESSION_CACHE
        .lock()
        .ok()
        .and_then(|cache| cache.get(&account.id).cloned())
        .filter(|cached| cached.expires_at > now)
    {
        return Ok(cached);
    }

    let session = fetch_chatgpt_cookie_session(session_cookie).await?;
    let cached = CachedCookieSession {
        access_token: session.access_token,
        account_id: session.account_id.or_else(|| account_id.clone()),
        expires_at: session.expires_at,
    };
    if let Ok(mut cache) = COOKIE_SESSION_CACHE.lock() {
        cache.insert(account.id.clone(), cached.clone());
    }
    Ok(cached)
}

pub fn cache_chatgpt_cookie_session(account_id: &str, session: ChatGptCookieSession) {
    if let Ok(mut cache) = COOKIE_SESSION_CACHE.lock() {
        cache.insert(
            account_id.to_string(),
            CachedCookieSession {
                access_token: session.access_token,
                account_id: session.account_id,
                expires_at: session.expires_at,
            },
        );
    }
}

pub fn clear_chatgpt_cookie_session(account_id: &str) {
    if let Ok(mut cache) = COOKIE_SESSION_CACHE.lock() {
        cache.remove(account_id);
    }
}

pub fn move_cookie_session_cache(previous_id: &str, stored_id: &str) {
    if previous_id == stored_id { return; }
    if let Ok(mut cache) = COOKIE_SESSION_CACHE.lock() {
        if let Some(session) = cache.remove(previous_id) {
            cache.insert(stored_id.to_string(), session);
        }
    }
}

async fn get_usage_with_cookie_auth(account: &StoredAccount) -> Result<UsageInfo> {
    let session = get_cookie_session(account).await?;
    let mut response = send_chatgpt_usage_request(
        &session.access_token,
        session.account_id.as_deref(),
    )
    .await?;

    if response.status() == StatusCode::UNAUTHORIZED {
        clear_chatgpt_cookie_session(&account.id);
        let refreshed_session = get_cookie_session(account).await?;
        response = send_chatgpt_usage_request(
            &refreshed_session.access_token,
            refreshed_session.account_id.as_deref(),
        )
        .await?;
    }

    parse_usage_response(&account.id, &account.name, response).await
}

async fn parse_usage_response(
    account_id: &str,
    account_name: &str,
    response: reqwest::Response,
) -> Result<UsageInfo> {
    let status = response.status();

    if !status.is_success() {
        let error = log_http_failure(account_id, response).await;
        return Ok(UsageInfo::error(
            account_id.to_string(),
            error,
        ));
    }

    let body_text = response
        .text()
        .await
        .context("Failed to read response body")?;

    let payload: RateLimitStatusPayload =
        serde_json::from_str(&body_text).context("Failed to parse usage response")?;

    let usage = convert_payload_to_usage_info(account_id, payload);
    println!("[Usage] Refreshed account: {account_name}");

    Ok(usage)
}

fn build_chatgpt_headers(
    access_token: &str,
    chatgpt_account_id: Option<&str>,
) -> Result<HeaderMap> {
    use reqwest::header::{ACCEPT, ACCEPT_LANGUAGE, ORIGIN, REFERER};

    let mut headers = HeaderMap::new();

    // Use a real browser User-Agent so Cloudflare does not flag the request as
    // a bot.  The codex-cli/1.0.0 string was the previous value and it
    // reliably triggers the CF "Enable JavaScript and cookies" challenge.
    headers.insert(USER_AGENT, HeaderValue::from_static(BROWSER_USER_AGENT));

    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {access_token}")).context("Invalid access token")?,
    );

    // Browser-like headers that Cloudflare uses to distinguish real browsers
    // from automated HTTP clients.
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("application/json, text/plain, */*"),
    );
    headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.9"));
    headers.insert(ORIGIN, HeaderValue::from_static(CHATGPT_ORIGIN));
    headers.insert(REFERER, HeaderValue::from_static(CHATGPT_ORIGIN));

    // Fetch metadata headers sent by the browser
    if let Ok(name) = HeaderName::from_bytes(b"sec-fetch-dest") {
        headers.insert(name, HeaderValue::from_static("empty"));
    }
    if let Ok(name) = HeaderName::from_bytes(b"sec-fetch-mode") {
        headers.insert(name, HeaderValue::from_static("cors"));
    }
    if let Ok(name) = HeaderName::from_bytes(b"sec-fetch-site") {
        headers.insert(name, HeaderValue::from_static("same-origin"));
    }

    if let Some(acc_id) = chatgpt_account_id {
        if let Ok(header_name) = HeaderName::from_bytes(b"chatgpt-account-id") {
            if let Ok(header_value) = HeaderValue::from_str(acc_id) {
                headers.insert(header_name, header_value);
            }
        }
    }

    Ok(headers)
}

fn extract_chatgpt_auth(account: &StoredAccount) -> Result<(&str, Option<&str>)> {
    match &account.auth_data {
        AuthData::ChatGPT {
            access_token,
            account_id,
            ..
        } => Ok((access_token.as_str(), account_id.as_deref())),
        AuthData::ApiKey { .. } | AuthData::Cookie { .. } => {
            anyhow::bail!("Account is not using ChatGPT OAuth")
        }
    }
}

async fn send_chatgpt_usage_request(
    access_token: &str,
    chatgpt_account_id: Option<&str>,
) -> Result<reqwest::Response> {
    send_chatgpt_get_request(
        &format!("{CHATGPT_BACKEND_API}/wham/usage"),
        access_token,
        chatgpt_account_id,
    )
    .await
}

async fn send_chatgpt_get_request(
    url: &str,
    access_token: &str,
    chatgpt_account_id: Option<&str>,
) -> Result<reqwest::Response> {
    let client = reqwest::Client::new();
    let headers = build_chatgpt_headers(access_token, chatgpt_account_id)?;

    write_usage_log(&format!("HTTP请求 GET {url}"));
    let response = client
        .get(url)
        .timeout(std::time::Duration::from_secs(30))
        .headers(headers)
        .send()
        .await
        .with_context(|| format!("Failed to send GET request to {url}"))?;
    write_usage_log(&format!("HTTP响应 GET {url} status={}", response.status()));
    Ok(response)
}

/// Convert API response to UsageInfo
fn convert_payload_to_usage_info(account_id: &str, payload: RateLimitStatusPayload) -> UsageInfo {
    let (primary, secondary) = extract_rate_limits(payload.rate_limit);
    let credits = extract_credits(payload.credits);

    UsageInfo {
        fetched_at: Some(Utc::now()),
        account_id: account_id.to_string(),
        plan_type: Some(payload.plan_type),
        primary_used_percent: primary.as_ref().map(|w| w.used_percent),
        primary_window_minutes: primary
            .as_ref()
            .and_then(|w| w.limit_window_seconds)
            .map(|s| (i64::from(s) + 59) / 60),
        primary_resets_at: primary.as_ref().and_then(|w| w.reset_at),
        secondary_used_percent: secondary.as_ref().map(|w| w.used_percent),
        secondary_window_minutes: secondary
            .as_ref()
            .and_then(|w| w.limit_window_seconds)
            .map(|s| (i64::from(s) + 59) / 60),
        secondary_resets_at: secondary.as_ref().and_then(|w| w.reset_at),
        has_credits: credits.as_ref().map(|c| c.has_credits),
        unlimited_credits: credits.as_ref().map(|c| c.unlimited),
        credits_balance: credits.and_then(|c| c.balance),
        error: None,
    }
}

fn extract_rate_limits(
    rate_limit: Option<RateLimitDetails>,
) -> (Option<RateLimitWindow>, Option<RateLimitWindow>) {
    let Some(details) = rate_limit else {
        return (None, None);
    };

    match (details.primary_window, details.secondary_window) {
        // The backend can temporarily omit the 5-hour window and promote the
        // weekly window into primary_window. Keep UsageInfo semantic so every
        // consumer still treats primary as session and secondary as weekly.
        (Some(primary), None) if is_weekly_window(&primary) => (None, Some(primary)),
        (None, Some(secondary)) if is_session_window(&secondary) => (Some(secondary), None),
        (Some(primary), Some(secondary))
            if is_weekly_window(&primary) && is_session_window(&secondary) =>
        {
            (Some(secondary), Some(primary))
        }
        (primary, secondary) => (primary, secondary),
    }
}

fn is_session_window(window: &RateLimitWindow) -> bool {
    window.limit_window_seconds == Some(SESSION_WINDOW_SECONDS)
}

fn is_weekly_window(window: &RateLimitWindow) -> bool {
    window.limit_window_seconds == Some(WEEKLY_WINDOW_SECONDS)
}

fn extract_credits(credits: Option<CreditStatusDetails>) -> Option<CreditStatusDetails> {
    credits
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_a_cookie_header_prefix() {
        assert_eq!(normalize_chatgpt_cookie("  cOoKiE: a=b; x=y  ").unwrap(), "a=b; x=y");
    }

    #[test]
    fn rejects_empty_and_multiline_cookie_headers() {
        assert!(normalize_chatgpt_cookie("  ").is_err());
        assert!(normalize_chatgpt_cookie("a=b\r\nAuthorization: x").is_err());
    }

    fn rate_limit_window(used_percent: f64, window_seconds: i32) -> RateLimitWindow {
        RateLimitWindow {
            used_percent,
            limit_window_seconds: Some(window_seconds),
            reset_at: Some(1_800_000_000),
        }
    }

    #[test]
    fn keeps_legacy_session_and_weekly_windows_in_place() {
        let (session, weekly) = extract_rate_limits(Some(RateLimitDetails {
            primary_window: Some(rate_limit_window(27.0, SESSION_WINDOW_SECONDS)),
            secondary_window: Some(rate_limit_window(82.0, WEEKLY_WINDOW_SECONDS)),
        }));

        assert_eq!(
            session.and_then(|window| window.limit_window_seconds),
            Some(SESSION_WINDOW_SECONDS)
        );
        assert_eq!(
            weekly.and_then(|window| window.limit_window_seconds),
            Some(WEEKLY_WINDOW_SECONDS)
        );
    }

    #[test]
    fn moves_weekly_only_primary_window_to_weekly_slot() {
        let (session, weekly) = extract_rate_limits(Some(RateLimitDetails {
            primary_window: Some(rate_limit_window(35.0, WEEKLY_WINDOW_SECONDS)),
            secondary_window: None,
        }));

        assert!(session.is_none());
        assert_eq!(weekly.map(|window| window.used_percent), Some(35.0));
    }

    #[test]
    fn restores_semantic_order_if_backend_reverses_windows() {
        let (session, weekly) = extract_rate_limits(Some(RateLimitDetails {
            primary_window: Some(rate_limit_window(82.0, WEEKLY_WINDOW_SECONDS)),
            secondary_window: Some(rate_limit_window(27.0, SESSION_WINDOW_SECONDS)),
        }));

        assert_eq!(session.map(|window| window.used_percent), Some(27.0));
        assert_eq!(weekly.map(|window| window.used_percent), Some(82.0));
    }

    #[test]
    fn preserves_unknown_windows_by_backend_position() {
        let (primary, secondary) = extract_rate_limits(Some(RateLimitDetails {
            primary_window: Some(rate_limit_window(11.0, 60 * 60)),
            secondary_window: Some(rate_limit_window(22.0, 30 * 24 * 60 * 60)),
        }));

        assert_eq!(primary.map(|window| window.used_percent), Some(11.0));
        assert_eq!(secondary.map(|window| window.used_percent), Some(22.0));
    }
}
