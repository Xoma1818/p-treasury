// «Состояние данных» (п. 6 плана 06.11): копия, курсы и операции без категории
// одной строкой каждое — что в порядке, а что требует внимания.
import type { BackupStatus, CurrentRate, VaultStatus } from "./api";

export type StatusLevel = "ok" | "warn";

export interface StatusRow {
  key: "backup" | "rates" | "uncategorized";
  level: StatusLevel;
  text: string;
}

/** Курс старше стольких дней считается давним: ЦБ публикует курсы каждый рабочий день. */
export const STALE_RATE_DAYS = 7;

/** Дата `YYYY-MM-DD` местного времени из метки ISO (UTC с `Z`) или `YYYY-MM-DDTHH:MM`. */
function localParts(at: string): { date: string; time: string } | null {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** «сегодня в 14:02», «вчера в 09:10», «05.11.2026 в 18:00». */
export function when(at: string, today: string, formatDate: (d: string) => string): string {
  const p = localParts(at);
  if (!p) return at;
  const ago = daysBetween(p.date, today);
  const day = ago === 0 ? "сегодня" : ago === 1 ? "вчера" : formatDate(p.date);
  return `${day} в ${p.time}`;
}

/** Самая свежая из меток (сравнение по времени, пустые пропускаются). */
function latest(...at: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const a of at) {
    if (!a || Number.isNaN(Date.parse(a))) continue;
    if (!best || Date.parse(a) > Date.parse(best)) best = a;
  }
  return best;
}

/** Метка `at` не раньше `copy`: проверка была уже после этой копии. */
function notBefore(at: string | null | undefined, copy: string): boolean {
  return !!at && !Number.isNaN(Date.parse(at)) && Date.parse(at) >= Date.parse(copy);
}

/**
 * Итог проверки восстановления относится к самой свежей копии, только если проверка
 * была после неё: иначе новую копию ещё никто не проверял, а старый успех или старая
 * ошибка говорят о прежнем файле.
 */
export function backupRow(backup: BackupStatus | undefined, vault: VaultStatus | undefined, today: string, formatDate: (d: string) => string): StatusRow | null {
  if (!backup || !vault) return null;
  const last = latest(backup.lastBackupAt, vault.on ? vault.syncedAt : null);
  if (!last) return { key: "backup", level: "warn", text: "Копия: ещё не делалась" };
  const lastText = `Копия: ${when(last, today, formatDate)}`;
  const failed = !!vault.verifyError && notBefore(vault.verifyFailedAt, last);
  const checked = !failed && notBefore(vault.verified?.checkedAt, last);
  if (failed) return { key: "backup", level: "warn", text: `${lastText}; проверка восстановления не прошла` };
  if (backup.reminderDue) return { key: "backup", level: "warn", text: `${lastText}, больше месяца назад` };
  if (vault.on && vault.error) return { key: "backup", level: "warn", text: `${lastText}; папка сохранности не обновляется` };
  if (!vault.on) return { key: "backup", level: "ok", text: `${lastText}; папка сохранности выключена` };
  return { key: "backup", level: "ok", text: checked ? `${lastText}, восстановление проверено` : `${lastText}, восстановление ещё не проверялось` };
}

/**
 * Курсы только тех валют, что есть на счетах: каких нет вовсе (такие счета не входят
 * в итоги) и какие давно не обновлялись; иначе — когда последний раз отвечал ЦБ.
 */
export function ratesRow(
  used: string[],
  rates: CurrentRate[] | undefined,
  checkedAt: string | null | undefined,
  auto: boolean,
  today: string,
  formatDate: (d: string) => string,
): StatusRow | null {
  if (used.length === 0) return { key: "rates", level: "ok", text: "Курсы: счетов в других валютах нет" };
  if (!rates) return null;
  const of = (code: string) => rates.find((r) => r.code === code);
  const missing = used.filter((c) => !of(c)?.rate);
  if (missing.length > 0) return { key: "rates", level: "warn", text: `Нет курса: ${missing.join(", ")} — такие счета и операции не входят в итоги` };
  const stale = used.filter((c) => {
    const d = of(c)?.date;
    return !!d && daysBetween(d, today) > STALE_RATE_DAYS;
  });
  if (stale.length > 0) {
    const oldest = stale.map((c) => of(c)!.date!).sort()[0];
    return { key: "rates", level: "warn", text: `Курс ${stale.join(", ")} от ${formatDate(oldest)} — давно не обновлялся` };
  }
  if (auto && checkedAt) return { key: "rates", level: "ok", text: `Курсы ЦБ: проверены ${when(checkedAt, today, formatDate)}` };
  const newest = used.map((c) => of(c)!.date!).sort().reverse()[0];
  return { key: "rates", level: "ok", text: `Курсы: ${auto ? "" : "вводятся вручную, "}последний от ${formatDate(newest)}` };
}

export function uncategorizedRow(count: number | undefined): StatusRow | null {
  if (count === undefined) return null;
  if (count === 0) return { key: "uncategorized", level: "ok", text: "Без категории в этом месяце: нет" };
  return { key: "uncategorized", level: "warn", text: `Без категории в этом месяце: ${count}` };
}
