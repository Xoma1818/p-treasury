// Р7 вид «Год»: раскладка тепловой карты трат — столбцы-недели, строки-дни недели.
import { weekdayIndex } from "./fine";
import type { Fine } from "./fine";

export interface HeatCell {
  date: string;
  expense: number;
  /** 0 — трат нет, 1–4 — от светлого к тёмному. */
  level: number;
}

/** Оттенок по корню из доли от самого дорогого дня: один крупный день не гасит остальные. */
export function heatLevel(expense: number, max: number): number {
  if (expense <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil(4 * Math.sqrt(expense / max))));
}

/** Недели года: в каждой 7 мест, пустые места до 1 января и после 31 декабря — null. */
export function heatWeeks(days: { date: string; expense: number }[], max: number, f: Fine): (HeatCell | null)[][] {
  const weeks: (HeatCell | null)[][] = [];
  let week: (HeatCell | null)[] = [];
  for (const d of days) {
    const [y, m, dd] = d.date.split("-").map(Number);
    const wd = weekdayIndex(new Date(y, m - 1, dd).getDay(), f);
    if (week.length === 0) for (let i = 0; i < wd; i++) week.push(null);
    week.push({ ...d, level: heatLevel(d.expense, max) });
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }
  if (week.length) {
    while (week.length < 7) week.push(null);
    weeks.push(week);
  }
  return weeks;
}
