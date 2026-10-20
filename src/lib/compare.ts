import type { CategoryKind, CompareRow } from "./api";

/** Строки сравнения по группам: стало больше, стало меньше, без изменений. Порядок внутри — по силе изменения. */
export function splitRows(rows: CompareRow[]) {
  return {
    up: rows.filter((r) => r.diff > 0).sort((x, y) => y.diff - x.diff),
    down: rows.filter((r) => r.diff < 0).sort((x, y) => x.diff - y.diff),
    same: rows.filter((r) => r.diff === 0),
  };
}

/** Изменение в процентах: «+25 %», «−25 %», «0 %»; без первого периода — «новое». */
export function formatChange(percent: number | null): string {
  if (percent == null) return "новое";
  if (percent > 0) return `+${percent} %`;
  if (percent < 0) return `−${Math.abs(percent)} %`;
  return "0 %";
}

/** Хорошее ли это изменение: расходы уменьшились или доходы выросли. */
export function isBetter(kind: CategoryKind, diff: number): boolean {
  return kind === "expense" ? diff < 0 : diff > 0;
}

/** Ширина полоски изменения в процентах половины шкалы (полоска растёт от середины). */
export function barWidth(diff: number, max: number): number {
  if (!max || !diff) return 0;
  return Math.max((Math.abs(diff) / max) * 100, 1.5);
}
