import { getCurrentWindow } from "@tauri-apps/api/window";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { QuickWindow } from "./components/QuickWindow";
import { isTauri } from "./lib/api";
import { installPressEffect } from "./lib/press";
import { applyTheme, savedTheme } from "./lib/theme";
import "./styles.css";
import "./features.css";
import "./invest.css";

installPressEffect();
applyTheme(savedTheme());

// Одна и та же страница служит главному окну и окну быстрого ввода.
const quick = isTauri() && getCurrentWindow().label === "quick";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {quick ? <QuickWindow /> : <App />}
    </QueryClientProvider>
  </StrictMode>,
);
