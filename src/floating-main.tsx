import React from "react";
import ReactDOM from "react-dom/client";
import FloatingUsage from "./FloatingUsage";
import { syncThemeFromStorage } from "./lib/theme";
import "./App.css";

syncThemeFromStorage();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <FloatingUsage />
  </React.StrictMode>
);
