// Состояние по суммам в минимальных единицах валюты: «100 %» может означать и перерасход.
export type BarLevel = "ok" | "warn" | "used" | "over";

export const WARN_PERCENT = 80;

export function barLevel(actual: number, limit: number): BarLevel {
  if (actual > limit) return "over";
  if (limit > 0 && actual === limit) return "used";
  if (limit > 0 && actual >= limit * (WARN_PERCENT / 100)) return "warn";
  return "ok";
}

/** Пометка «+34 % к обычному» / «−40 % к обычному». */
export function usualLabel(percent: number | null): string | null {
  if (percent == null || percent === 0) return null;
  return `${percent > 0 ? "+" : "−"}${Math.abs(percent)} % к обычному`;
}
