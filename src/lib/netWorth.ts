// График «Чистые активы» (В3): шкала, которая выдерживает и минус.

/** Округлённое «красивое» число не меньше v: 1, 2, 2,5, 5 × 10ⁿ. */
export function niceStep(v: number): number {
  if (v <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  for (const k of [1, 2, 2.5, 5, 10]) if (k * exp >= v) return k * exp;
  return 10 * exp;
}

/** Шкала оси: от min до max с шагом step, ноль всегда на оси. */
export function netWorthScale(values: number[], ticks = 4): { min: number; max: number; step: number } {
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const step = niceStep((hi - lo || 1) / ticks);
  return { min: Math.floor(lo / step) * step, max: Math.ceil(hi / step) * step || step, step };
}

/** Изменение к прошлому месяцу в процентах; null — сравнивать не с чем. */
export function changePercent(cur: number, change: number | null): number | null {
  if (change == null) return null;
  const prev = cur - change;
  if (prev === 0) return null;
  return Math.round((change / Math.abs(prev)) * 100);
}

const axisFmt = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });

/** Короткая подпись оси: «15 млн», «850 тыс.», «2,5 тыс.»; `v` — в минимальных единицах. */
export function axisLabel(v: number, minorUnits = 2): string {
  const units = v / 10 ** minorUnits;
  const abs = Math.abs(units);
  const [n, suffix] = abs >= 1e6 ? [units / 1e6, " млн"] : abs >= 1e3 ? [units / 1e3, " тыс."] : [Math.round(units), ""];
  if (n === 0) return "0";
  return (axisFmt.format(n) + suffix).replace("-", "−");
}

/** Левый отступ графика под самую длинную подпись оси (шрифт 11 px). */
export function axisPad(labels: string[]): number {
  const longest = Math.max(1, ...labels.map((l) => l.length));
  return Math.ceil(longest * 6.6) + 14;
}
