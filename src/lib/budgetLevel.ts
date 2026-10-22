// Цвет полосы бюджета (А1): жёлтая от 80 %, красная от 100 %.
export type BarLevel = "ok" | "warn" | "over";

export const WARN_PERCENT = 80;

export function barLevel(percent: number): BarLevel {
  if (percent >= 100) return "over";
  if (percent >= WARN_PERCENT) return "warn";
  return "ok";
}

/** Класс полосы: «bar», «bar warn», «bar over». */
export const barClass = (percent: number) => {
  const l = barLevel(percent);
  return l === "ok" ? "bar" : `bar ${l}`;
};

/** Пометка «+34 % к обычному» / «−40 % к обычному». */
export function usualLabel(percent: number | null): string | null {
  if (percent == null || percent === 0) return null;
  return `${percent > 0 ? "+" : "−"}${Math.abs(percent)} % к обычному`;
}
