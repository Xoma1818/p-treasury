// Масштаб интерфейса: «Авто» подстраивает размер под окно (на весь экран крупнее),
// либо выбранный вручную процент. Как и тема, хранится в браузерном хранилище окна.
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { isTauri } from "./api";

export type Scale = "auto" | "90" | "100" | "110" | "125" | "150";
export const SCALES: { value: Scale; label: string }[] = [
  { value: "auto", label: "Авто (по размеру окна)" },
  { value: "90", label: "90 %" },
  { value: "100", label: "100 %" },
  { value: "110", label: "110 %" },
  { value: "125", label: "125 %" },
  { value: "150", label: "150 %" },
];
const KEY = "p-treasury-scale";
/** Окно, под которое нарисован интерфейс: в нём и меньше «Авто» = 100 %. */
const BASE_W = 1440;
const BASE_H = 860;
const MAX_AUTO = 1.3;

let current = 1;
let mode: Scale = "auto";

export function savedScale(): Scale {
  try {
    const v = localStorage.getItem(KEY);
    return SCALES.some((s) => s.value === v) ? (v as Scale) : "auto";
  } catch {
    return "auto";
  }
}

/** Масштаб «Авто» по размеру окна в точках экрана (без учёта текущего масштаба). */
export function autoFactor(width: number, height: number): number {
  const f = Math.min(width / BASE_W, height / BASE_H, MAX_AUTO);
  return Math.max(1, Math.floor(f * 20) / 20);
}

function target(): number {
  if (mode !== "auto") return Number(mode) / 100;
  return autoFactor(window.innerWidth * current, window.innerHeight * current);
}

function apply() {
  const next = target();
  if (Math.abs(next - current) < 0.001) return;
  current = next;
  document.documentElement.style.setProperty("--ui-scale", String(next));
  if (isTauri()) getCurrentWebview().setZoom(next).catch(() => {});
}

export function applyScale(scale: Scale) {
  mode = scale;
  try {
    localStorage.setItem(KEY, scale);
  } catch {
    // Хранилище недоступно: масштаб продержится до перезапуска.
  }
  apply();
}

/** Следить за размером окна: вызывается один раз при запуске главного окна. */
export function installScale() {
  mode = savedScale();
  apply();
  let timer: number | undefined;
  window.addEventListener("resize", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(apply, 150);
  });
}
