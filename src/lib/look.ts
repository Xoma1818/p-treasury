// Г11: вид — плотность и акцентный цвет. Как тема и масштаб: хранится в окне,
// копия уходит в базу (uiPrefs) и возвращается с резервной копией.
import { pushPref } from "./uiPrefs";

export const LOOK_KEY = "kazna.look";

export type Density = "compact" | "normal" | "roomy";
export type Accent = "mint" | "blue" | "violet" | "amber" | "rose" | "graphite";
export type Look = { density: Density; accent: Accent };

export const DENSITIES: { value: Density; label: string }[] = [
  { value: "compact", label: "Компактно" },
  { value: "normal", label: "Обычно" },
  { value: "roomy", label: "Просторно" },
];

/** Акцентные цвета; мятный — фирменный, по умолчанию. */
export const ACCENTS: { value: Accent; label: string; color: string }[] = [
  { value: "mint", label: "Мятный", color: "#14b88f" },
  { value: "blue", label: "Синий", color: "#3b82f6" },
  { value: "violet", label: "Фиолетовый", color: "#8b5cf6" },
  { value: "amber", label: "Янтарный", color: "#e0960b" },
  { value: "rose", label: "Малиновый", color: "#f43f5e" },
  { value: "graphite", label: "Графит", color: "#64748b" },
];

export const DEFAULT_LOOK: Look = { density: "normal", accent: "mint" };

export function parseLook(raw: string | null | undefined): Look {
  try {
    const v = JSON.parse(raw || "{}");
    if (!v || typeof v !== "object") return DEFAULT_LOOK;
    return {
      density: DENSITIES.some((d) => d.value === v.density) ? v.density : "normal",
      accent: ACCENTS.some((a) => a.value === v.accent) ? v.accent : "mint",
    };
  } catch {
    return DEFAULT_LOOK;
  }
}

export function savedLook(): Look {
  try {
    return parseLook(localStorage.getItem(LOOK_KEY));
  } catch {
    return DEFAULT_LOOK;
  }
}

/** Применить к окну: атрибуты на <html>, цвета и отступы задаёт CSS. */
export function showLook(l: Look) {
  const el = document.documentElement;
  if (l.density === "normal") delete el.dataset.density;
  else el.dataset.density = l.density;
  if (l.accent === "mint") delete el.dataset.accent;
  else el.dataset.accent = l.accent;
}

export function applyLook(l: Look) {
  showLook(l);
  const v = JSON.stringify(l);
  pushPref(LOOK_KEY, v);
  try {
    localStorage.setItem(LOOK_KEY, v);
  } catch {
    /* продержится до перезапуска */
  }
}
