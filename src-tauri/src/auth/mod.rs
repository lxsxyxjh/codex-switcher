//! Authentication module

pub mod oauth_server;
pub mod storage;
pub mod switcher;
pub mod token_refresh;

// 凭证更新共用一个锁，避免同时刷新同一份账户凭证。
pub(crate) static AUTH_OPERATION_LOCK: tokio::sync::Mutex<()> =
    tokio::sync::Mutex::const_new(());

pub use oauth_server::*;
pub use storage::*;
pub use switcher::*;
pub use token_refresh::*;
