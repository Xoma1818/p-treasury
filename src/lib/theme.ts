// Тема оформления: «Тёмный графит» по умолчанию, светлая — по кнопке в меню.
// Выбор хранится в браузерном хранилище окна: это вид, а не данные учёта.
import { pushPref } from "./uiPrefs";

export type Theme = "dark" | "light";
const KEY = "p-treasury-theme";
/** Событие смены темы: переключатель в меню следит за ним (тема меняется и из Ctrl+K). */
export const THEME_EVENT = "kazna:theme";

export function savedTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: theme }));
  pushPref(KEY, theme);
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Хранилище недоступно: тема продержится до перезапуска.
  }
}
