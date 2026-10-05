//! Read and import Codex credentials without changing the Codex login

use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};

use crate::types::{
    parse_chatgpt_id_token_claims, AuthDotJson, StoredAccount,
};

/// Get the official Codex home directory
pub fn get_codex_home() -> Result<PathBuf> {
    // Check for CODEX_HOME environment variable first
    if let Ok(codex_home) = std::env::var("CODEX_HOME") {
        return Ok(PathBuf::from(codex_home));
    }

    let home = dirs::home_dir().context("Could not find home directory")?;
    Ok(home.join(".codex"))
}

/// Get the path to the official auth.json file
pub fn get_codex_auth_file() -> Result<PathBuf> {
    Ok(get_codex_home()?.join("auth.json"))
}

/// Import an account from an existing auth.json file
pub fn import_from_auth_json(path: &str, account_name: String) -> Result<StoredAccount> {
    let content =
        fs::read_to_string(path).with_context(|| format!("Failed to read auth.json: {path}"))?;

    import_from_auth_json_contents(&content, account_name)
        .with_context(|| format!("Failed to parse auth.json: {path}"))
}

/// Import an account from auth.json file contents.
pub fn import_from_auth_json_contents(
    content: &str,
    account_name: String,
) -> Result<StoredAccount> {
    let auth: AuthDotJson =
        serde_json::from_str(&content).context("Failed to parse auth.json contents")?;
    let account_name = account_name.trim().to_string();

    // Determine auth mode and create account
    if let Some(api_key) = auth.openai_api_key {
        Ok(StoredAccount::new_api_key(account_name, api_key))
    } else if let Some(tokens) = auth.tokens {
        let claims = parse_chatgpt_id_token_claims(&tokens.id_token);

        Ok(StoredAccount::new_chatgpt(
            account_name,
            claims.email,
            claims.plan_type,
            claims.subscription_expires_at,
            tokens.id_token,
            tokens.access_token,
            tokens.refresh_token,
            claims.account_id.or(tokens.account_id),
        ))
    } else {
        anyhow::bail!("auth.json contains neither API key nor tokens");
    }
}

/// Read the current auth.json file if it exists
pub fn read_current_auth() -> Result<Option<AuthDotJson>> {
    let path = get_codex_auth_file()?;

    if !path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(&path)
        .with_context(|| format!("Failed to read auth.json: {}", path.display()))?;

    let auth: AuthDotJson = serde_json::from_str(&content)
        .with_context(|| format!("Failed to parse auth.json: {}", path.display()))?;

    Ok(Some(auth))
}

#[cfg(test)]
mod tests {
    use super::import_from_auth_json_contents;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use serde_json::json;

    fn auth_json(payload: serde_json::Value, account_id: &str) -> String {
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        serde_json::json!({
            "tokens": {
                "id_token": format!("header.{payload}.signature"),
                "access_token": "access",
                "refresh_token": "refresh",
                "account_id": account_id
            }
        })
        .to_string()
    }

    #[test]
    fn import_blank_name_uses_email() {
        let account = import_from_auth_json_contents(
            &auth_json(json!({"email": "imported@example.com"}), "acct-import"),
            "".into(),
        )
        .unwrap();
        assert_eq!(account.name, "imported@example.com");
    }

    #[test]
    fn import_explicit_name_is_trimmed() {
        let account = import_from_auth_json_contents(
            &auth_json(json!({"email": "imported@example.com"}), "acct-import"),
            "  Imported Account  ".into(),
        )
        .unwrap();
        assert_eq!(account.name, "Imported Account");
    }

    #[test]
    fn import_without_email_uses_account_id_fallback() {
        let account =
            import_from_auth_json_contents(&auth_json(json!({}), "acct-87654321"), "".into())
                .unwrap();
        assert_eq!(account.name, "ChatGPT account (87654321)");
    }
}
