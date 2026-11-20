import { pushPref } from "./uiPrefs";

export type Theme = "dark" | "light" | "system";
const KEY = "p-treasury-theme";
/** Событие смены темы: переключатель в меню следит за ним (тема меняется и из Ctrl+K). */
export const THEME_EVENT = "kazna:theme";
let currentTheme: Theme = "dark";
let systemDark: MediaQueryList | undefined;

export function savedTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === "light" || saved === "dark" || saved === "system" ? saved : currentTheme;
  } catch {
    return currentTheme;
  }
}

function renderTheme() {
  document.documentElement.dataset.theme =
    currentTheme === "system" ? (systemDark?.matches ? "dark" : "light") : currentTheme;
}

export function applyTheme(theme: Theme) {
  currentTheme = theme;
  if (theme === "system" && !systemDark) {
    systemDark = window.matchMedia?.("(prefers-color-scheme: dark)");
    systemDark?.addEventListener("change", () => {
      if (currentTheme === "system") renderTheme();
    });
  }
  renderTheme();
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: theme }));
  pushPref(KEY, theme);
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Хранилище недоступно: тема продержится до перезапуска.
  }
}
