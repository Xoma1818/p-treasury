import { getCurrentWindow } from "@tauri-apps/api/window";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { QuickWindow } from "./components/QuickWindow";
import { CrashGuard } from "./components/Crash";
import { isTauri } from "./lib/api";
import { installSeenSections } from "./lib/motion";
import { installScale } from "./lib/scale";
import { applyTheme, savedTheme } from "./lib/theme";
import { savedLook, showLook } from "./lib/look";
import "./styles.css";
import "./features.css";
import "./invest.css";
import "./loans.css";
import "./forecast.css";

applyTheme(savedTheme());
showLook(savedLook());

// Одна и та же страница служит главному окну и окну быстрого ввода.
const quick = isTauri() && getCurrentWindow().label === "quick";
if (!quick) {
  installScale();
  installSeenSections();
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <CrashGuard>{quick ? <QuickWindow /> : <App />}</CrashGuard>
    </QueryClientProvider>
  </StrictMode>,
);
