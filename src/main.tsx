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
import { applyTheme, savedTheme, showTheme, THEME_KEY } from "./lib/theme";
import { LOOK_KEY, savedLook, showLook } from "./lib/look";
import "./styles.css";
import "./features.css";
import "./invest.css";
import "./loans.css";
import "./forecast.css";
import "./graphite.css";
import "./components/sidebar-navigation.css";
import "./pulse-shell.css";
import "./pulse-screens.css";

showLook(savedLook());

// Одна и та же страница служит главному окну и окну быстрого ввода.
const quick = isTauri() && /^quick(?:-\d+)?$/.test(getCurrentWindow().label);
if (quick) {
  showTheme(savedTheme());
  // Окно может оставаться скрытым между вызовами горячей клавишей.
  // Оно следует за изменениями главного окна, включая восстановление настроек.
  window.addEventListener("storage", (event) => {
    if (event.storageArea !== localStorage) return;
    if (event.key === LOOK_KEY || event.key === null) showLook(savedLook());
    if (event.key === THEME_KEY || event.key === null) showTheme(savedTheme());
  });
} else {
  applyTheme(savedTheme());
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
