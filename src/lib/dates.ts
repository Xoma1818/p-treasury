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

const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

/** «октября»: месяц в родительном падеже («скопировать из октября»). */
export const monthGenitive = (month: string) => MONTHS_GEN[Number(month.split("-")[1]) - 1];

/** «Октябрь 2026» */
export function monthTitle(date: string): string {
  const [y, m] = date.split("-").map(Number);
  const name = MONTHS[m - 1];
  return `${name[0].toUpperCase()}${name.slice(1)} ${y}`;
}

/** Сдвиг месяца «2026-11» на delta месяцев. */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const i = y * 12 + (m - 1) + delta;
  return `${Math.floor(i / 12)}-${pad((i % 12) + 1)}`;
}

/** Местные дата и время «2026-10-20T14:05», как у напоминаний в ядре. */
export function isoDateTime(d: Date): string {
  return `${isoDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const nowLocal = () => isoDateTime(new Date());

/** Сдвиг даты «2026-10-20» на delta дней. */
export function addDays(date: string, delta: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return isoDate(new Date(y, m - 1, d + delta));
}

/** Понедельник недели, в которую попадает дата. */
export function weekStart(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const wd = (new Date(y, m - 1, d).getDay() + 6) % 7;
  return addDays(date, -wd);
}

/** «20.10.2026 9:00» для «2026-10-20T09:00». */
export function formatDateTime(dt: string): string {
  const [date, time = ""] = dt.split("T");
  return `${formatDate(date)} ${time.replace(/^0(\d)/, "$1")}`.trim();
}

export const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
