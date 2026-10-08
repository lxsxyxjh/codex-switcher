import React from "react";
import ReactDOM from "react-dom/client";
import FloatingUsage from "./FloatingUsage";
import { syncThemeFromStorage } from "./lib/theme";
import "./App.css";

syncThemeFromStorage();

function UsageHint() {
  const [text, setText] = React.useState("");
  const contentRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      void import("./lib/platform").then(({ invokeBackend }) => invokeBackend("resize_usage_hint", { height: content.getBoundingClientRect().height })).catch(console.error);
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);
  React.useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    let received = false;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const { invokeBackend } = await import("./lib/platform");
      stop = await listen<string>("usage-hint-updated", ({ payload }) => { received = true; syncThemeFromStorage(); setText(payload); });
      if (disposed) { stop(); return; }
      const initial = await invokeBackend<string>("get_usage_hint");
      if (!disposed && !received) setText(initial);
    })().catch(console.error);
    return () => { disposed = true; stop?.(); };
  }, []);
  return <div ref={contentRef} className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs leading-5 whitespace-pre-wrap text-slate-600 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200">{text}</div>;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {"__CODEX_USAGE_HINT__" in window ? <UsageHint /> : <FloatingUsage />}
  </React.StrictMode>
);
