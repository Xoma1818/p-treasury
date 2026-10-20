import type { CbrImport } from "./api";

/** Текст итога загрузки курсов ЦБ для пользователя. */
export function describeCbrImport(r: CbrImport, formatDate: (d: string) => string): { text: string; ok: boolean } {
  const parts: string[] = [];
  if (r.updated.length > 0) parts.push(`Курсы ЦБ РФ на ${formatDate(r.date)} загружены: ${r.updated.join(", ")}.`);
  if (r.keptManual.length > 0) parts.push(`Курс, введённый вручную на эту дату, оставлен: ${r.keptManual.join(", ")}.`);
  if (r.missing.length > 0) parts.push(`ЦБ РФ не публикует курс: ${r.missing.join(", ")}. Его можно ввести вручную.`);
  if (parts.length === 0) return { text: "Счетов в других валютах нет: загружать нечего.", ok: true };
  return { text: parts.join(" "), ok: r.updated.length > 0 || r.keptManual.length > 0 };
}

/** «ЦБ РФ» или «вручную» для подписи курса. */
export function rateSource(source: string): string {
  return source === "cbr" ? "ЦБ РФ" : "вручную";
}

/** Курс из базы («92.15») так, как его пишут по-русски: «92,15». */
export function formatRate(rate: string | null): string {
  return rate ? rate.replace(".", ",") : "—";
}
