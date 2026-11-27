// Палитра, плотность и акцент хранятся в окне и в копии настроек бюджета.
import { create } from "zustand";
import { pushPref } from "./uiPrefs";

export const LOOK_KEY = "kazna.look";

export type Density = "compact" | "normal" | "roomy";
export const PALETTES = [
  { value: "petrol", label: "Петроль и фарфор" },
  { value: "plum", label: "Слива и шампань" },
  { value: "cobalt", label: "Кобальт и мел" },
] as const;
export type UiPalette = typeof PALETTES[number]["value"];
export type Accent = "palette" | "lime" | "mint" | "blue" | "violet" | "amber" | "rose" | "graphite";
export type Look = { palette: UiPalette; density: Density; accent: Accent };

export const DENSITIES: { value: Density; label: string }[] = [
  { value: "compact", label: "Компактно" },
  { value: "normal", label: "Обычно" },
  { value: "roomy", label: "Просторно" },
];

/** Персональные акценты, включая значения из прежних версий Kazna. */
export const ACCENTS: { value: Accent; label: string; color: string }[] = [
  { value: "lime", label: "Лайм", color: "#b9f368" },
  { value: "mint", label: "Мятный", color: "#14b88f" },
  { value: "blue", label: "Синий", color: "#3b82f6" },
  { value: "violet", label: "Фиолетовый", color: "#8b5cf6" },
  { value: "amber", label: "Янтарный", color: "#e0960b" },
  { value: "rose", label: "Малиновый", color: "#f43f5e" },
  { value: "graphite", label: "Графит", color: "#64748b" },
];

export const DEFAULT_LOOK: Look = { palette: "petrol", density: "normal", accent: "palette" };
export const useLook = create<Look>(() => DEFAULT_LOOK);

export function parseLook(raw: string | null | undefined): Look {
  try {
    const v = JSON.parse(raw || "{}");
    if (!v || typeof v !== "object") return DEFAULT_LOOK;
    return {
      palette: PALETTES.find((p) => p.value === v.palette)?.value ?? DEFAULT_LOOK.palette,
      density: DENSITIES.some((d) => d.value === v.density) ? v.density : "normal",
      accent: ACCENTS.some((a) => a.value === v.accent) ? v.accent : DEFAULT_LOOK.accent,
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
  el.dataset.palette = l.palette;
  el.dataset.accent = l.accent;
  useLook.setState(l, true);
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
