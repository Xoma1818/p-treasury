// Тема оформления: «Тёмный графит» по умолчанию, светлая — по кнопке в меню.
// Выбор хранится в браузерном хранилище окна: это вид, а не данные учёта.
export type Theme = "dark" | "light";
const KEY = "p-treasury-theme";

export function savedTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Хранилище недоступно: тема продержится до перезапуска.
  }
}
