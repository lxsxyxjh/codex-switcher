import { useState } from "react";
import {
  describeFileSource,
  isTauriRuntime,
  isWindowsPlatform,
  openExternalUrl,
  pickAuthJsonFile,
  type FileSource,
} from "../lib/platform";

interface AddAccountModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImportFile: (source: FileSource, name: string) => Promise<void>;
  onImportCookie: (cookie: string, name: string) => Promise<void>;
  onStartOAuth: (name: string) => Promise<{ auth_url: string }>;
  onCompleteOAuth: () => Promise<unknown>;
  onCancelOAuth: () => Promise<void>;
}

type Tab = "oauth" | "import" | "cookie";

export function AddAccountModal({
  isOpen,
  onClose,
  onImportFile,
  onImportCookie,
  onStartOAuth,
  onCompleteOAuth,
  onCancelOAuth,
}: AddAccountModalProps) {
  const [activeTab, setActiveTab] = useState<Tab>("import");
  const [fileSource, setFileSource] = useState<FileSource | null>(null);
  const [cookie, setCookie] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [oauthPending, setOauthPending] = useState(false);
  const [authUrl, setAuthUrl] = useState<string>("");
  const [copied, setCopied] = useState<boolean>(false);
  const isPrimaryDisabled = loading || (activeTab === "oauth" && oauthPending);
  const tauriRuntime = isTauriRuntime();
  const windowsPlatform = tauriRuntime && isWindowsPlatform();
  const tabs: Tab[] = windowsPlatform ? ["import", "oauth", "cookie"] : ["import", "oauth"];

  const resetForm = () => {
    setFileSource(null);
    setCookie("");
    setError(null);
    setLoading(false);
    setOauthPending(false);
    setAuthUrl("");
  };

  const handleClose = () => {
    if (oauthPending) {
      onCancelOAuth();
    }
    resetForm();
    onClose();
  };

  const handleOAuthLogin = async () => {
    try {
      setLoading(true);
      setError(null);
      const info = await onStartOAuth("");
      setAuthUrl(info.auth_url);
      setOauthPending(true);
      setLoading(false);

      // Wait for completion
      await onCompleteOAuth();
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
      setOauthPending(false);
    }
  };

  const handleSelectFile = async () => {
    try {
      const selected = await pickAuthJsonFile();
      if (selected) setFileSource(selected);
    } catch (err) {
      console.error("Failed to open file dialog:", err);
    }
  };

  const handleImportFile = async () => {
    if (!fileSource) {
      setError("请选择 auth.json 文件");
      return;
    }

    try {
      setLoading(true);
      setError(null);
      await onImportFile(fileSource, "");
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  };

  const handleImportCookie = async () => {
    if (!cookie.trim()) {
      setError("请粘贴 ChatGPT Cookie 请求头。");
      return;
    }

    try {
      setLoading(true);
      setError(null);
      await onImportCookie(cookie, "");
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
      <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl w-full max-w-md mx-4 shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-100 dark:border-gray-800">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">添加账户</h2>
          <button
            onClick={handleClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-100 dark:border-gray-800">
          {tabs.map((tab) => (
            <button
              key={tab}
              onClick={() => {
                if (tab !== "oauth" && oauthPending) {
                  void onCancelOAuth().catch((err) => {
                    console.error("Failed to cancel login:", err);
                  });
                  setOauthPending(false);
                  setLoading(false);
                }
                setActiveTab(tab);
                setError(null);
              }}
              className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${activeTab === tab
                  ? "text-gray-900 dark:text-gray-100 border-b-2 border-gray-900 dark:border-gray-100 -mb-px"
                  : "text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
                }`}
            >
              {tab === "oauth" ? "ChatGPT 登录" : tab === "import" ? "导入文件" : "Cookie"}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="p-5 space-y-4">
          {/* Tab-specific content */}
          {activeTab === "oauth" && (
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {oauthPending ? (
                <div className="text-center py-4">
                  <div className="animate-spin h-8 w-8 border-2 border-gray-900 dark:border-gray-100 border-t-transparent rounded-full mx-auto mb-3"></div>
                  <p className="text-gray-700 dark:text-gray-300 font-medium mb-2">等待浏览器登录…</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
                    请在浏览器中打开以下链接继续：
                  </p>
                  <div className="flex items-center gap-2 mb-2 bg-gray-50 dark:bg-gray-800 p-2 rounded-lg border border-gray-200 dark:border-gray-700">
                    <input
                      type="text"
                      readOnly
                      value={authUrl}
                      className="flex-1 bg-transparent border-none text-xs text-gray-600 dark:text-gray-300 focus:outline-none focus:ring-0 truncate"
                    />
                    <button
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(authUrl)
                          .then(() => {
                            setCopied(true);
                            setTimeout(() => setCopied(false), 2000);
                          })
                          .catch(() => {
                            setError("无法访问剪贴板，请手动复制链接。");
                          });
                      }}
                      className={`px-3 py-1.5 border rounded text-xs font-medium transition-colors shrink-0 
                        ${copied
                          ? "bg-green-50 dark:bg-green-900/30 border-green-200 dark:border-green-700 text-green-700 dark:text-green-300"
                          : "bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800"
                        }`}
                    >
                      {copied ? "已复制" : "复制"}
                    </button>
                    <button
                      onClick={() => {
                        void openExternalUrl(authUrl);
                      }}
                      className="px-3 py-1.5 bg-gray-900 hover:bg-gray-800 dark:bg-gray-100 dark:hover:bg-gray-200 border border-gray-900 dark:border-gray-100 rounded text-xs font-medium text-white dark:text-gray-900 transition-colors shrink-0"
                    >
                      打开
                    </button>
                  </div>
                  {!tauriRuntime && (
                    <p className="text-xs text-amber-600">
                      OAuth 登录必须在本机完成，因为登录回调会跳转到 `localhost`。
                    </p>
                  )}
                </div>
              ) : (
                <p>
                  点击下方按钮生成登录链接，然后在浏览器中完成验证。
                </p>
              )}
            </div>
          )}

          {activeTab === "import" && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              选择 auth.json 文件
              </label>
              <div className="flex gap-2">
                <div className="flex-1 px-4 py-2.5 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-600 dark:text-gray-300 truncate">
                  {describeFileSource(fileSource)}
                </div>
                <button
                  onClick={handleSelectFile}
                  className="px-4 py-2.5 bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-700 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-200 transition-colors whitespace-nowrap"
                >
                  浏览…
                </button>
              </div>
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">
                从现有 Codex auth.json 文件导入凭证
              </p>
            </div>
          )}

          {activeTab === "cookie" && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                ChatGPT Cookie 请求头
              </label>
              <input
                type="password"
                value={cookie}
                onChange={(event) => setCookie(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder="粘贴从 chatgpt.com 复制的 Cookie 请求头"
                className="w-full px-3 py-2.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-xs text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-gray-400 dark:focus:border-gray-500 focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
              />
              <p className="text-xs text-amber-600 dark:text-amber-400 mt-2">
                使用浏览器会话查看额度，添加后自动识别邮箱。
              </p>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded-lg text-red-600 dark:text-red-300 text-sm">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-3 p-5 border-t border-gray-100 dark:border-gray-800">
          <button
            onClick={handleClose}
            className="flex-1 px-4 py-2.5 text-sm font-medium rounded-lg bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 transition-colors"
          >
            取消
          </button>
          <button
            onClick={activeTab === "oauth" ? handleOAuthLogin : activeTab === "import" ? handleImportFile : handleImportCookie}
            disabled={isPrimaryDisabled}
            className="flex-1 px-4 py-2.5 text-sm font-medium rounded-lg bg-gray-900 hover:bg-gray-800 dark:bg-gray-100 dark:hover:bg-gray-200 text-white dark:text-gray-900 transition-colors disabled:opacity-50"
          >
            {loading
              ? "正在添加…"
              : activeTab === "oauth"
                ? "生成登录链接"
                : activeTab === "import" ? "导入" : "验证并添加"}
          </button>
        </div>
      </div>
    </div>
  );
}
