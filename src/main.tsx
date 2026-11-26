import { getCurrentWindow } from "@tauri-apps/api/window";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { QuickWindow } from "./components/QuickWindow";
import { CrashGuard } from "./components/Crash";
import { isTauri } from "./lib/api";
import { installSeenSections } from "./lib/motion";
import { budgetQueryDefaults } from "./lib/queryPolicy";
import { listenForAmountPrivacy } from "./lib/queries";
import { installScale } from "./lib/scale";
import { applyTheme, savedTheme } from "./lib/theme";
import { savedLook, showLook } from "./lib/look";
import "./styles.css";
import "./features.css";
import "./invest.css";
import "./loans.css";
import "./forecast.css";
import "./graphite.css";
import "./components/sidebar-navigation.css";
import "./pulse-shell.css";
import "./pulse-screens.css";

applyTheme(savedTheme());
showLook(savedLook());

// Одна и та же страница служит главному окну и окну быстрого ввода.
const quick = isTauri() && /^quick(?:-\d+)?$/.test(getCurrentWindow().label);
if (!quick) {
  installScale();
  installSeenSections();
}

const queryClient = new QueryClient({ defaultOptions: budgetQueryDefaults });
listenForAmountPrivacy(queryClient);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <CrashGuard>{quick ? <QuickWindow /> : <App />}</CrashGuard>
    </QueryClientProvider>
  </StrictMode>,
);
