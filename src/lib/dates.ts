// Даты операций в формате ядра: 'YYYY-MM-DD' по местному времени.

const pad = (n: number) => String(n).padStart(2, "0");

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const today = () => isoDate(new Date());

/** Первый и последний день месяца, в который попадает дата. */
export function monthBounds(date: string): [string, string] {
  const [y, m] = date.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return [`${y}-${pad(m)}-01`, `${y}-${pad(m)}-${pad(last)}`];
}

/** «20.10.2026» */
export function formatDate(date: string): string {
  const [y, m, d] = date.split("-");
  return `${d}.${m}.${y}`;
}

const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];

/** «Октябрь 2026» */
export function monthTitle(date: string): string {
  const [y, m] = date.split("-").map(Number);
  const name = MONTHS[m - 1];
  return `${name[0].toUpperCase()}${name.slice(1)} ${y}`;
}
