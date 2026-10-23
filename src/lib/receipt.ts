// Разбивка чека по категориям и «Учитывать по месяцам» (Г3): расчёты формы.
import type { Txn } from "./api";

export interface PartDraft {
  categoryId: string;
  /** Сумма в минимальных единицах или null, если поле пустое или с ошибкой. */
  amount: number | null;
}

/** Остаток чека: сумма чека минус заполненные строки. Отрицательный — строки больше чека. */
export function receiptRemainder(total: number | null, parts: PartDraft[]): number {
  return (total ?? 0) - parts.reduce((s, p) => s + (p.amount ?? 0), 0);
}

/** Что мешает сохранить разбивку; null — можно сохранять. */
export function receiptProblem(total: number | null, parts: PartDraft[]): string | null {
  if (total === null || total <= 0) return "Введите сумму чека больше нуля";
  if (parts.length < 2) return "Разбейте чек хотя бы на две категории";
  if (parts.some((p) => !p.categoryId)) return "Выберите категорию в каждой строке";
  if (parts.some((p) => p.amount === null || p.amount <= 0)) return "Сумма каждой строки должна быть больше нуля";
  const left = receiptRemainder(total, parts);
  if (left > 0) return "Распределите остаток по строкам";
  if (left < 0) return "Строки больше суммы чека";
  return null;
}

/** Части траты по месяцам: копейки от деления уходят в первую часть. */
export function spreadParts(amount: number, months: number): number[] {
  if (months < 2 || amount <= 0) return [amount];
  const each = Math.floor(amount / months);
  return [amount - each * (months - 1), ...Array(months - 1).fill(each)];
}

/** Строка списка операций: обычная операция или разбитый чек целиком. */
export type TxnRow = { kind: "txn"; key: string; txn: Txn } | { kind: "receipt"; key: string; splitId: string; parts: Txn[]; total: number };

/** Части разбитого чека собираются в одну строку на месте первой из них. */
export function groupReceipts(items: Txn[]): TxnRow[] {
  const out: TxnRow[] = [];
  const at = new Map<string, number>();
  for (const t of items) {
    if (!t.splitId) {
      out.push({ kind: "txn", key: t.id, txn: t });
      continue;
    }
    const i = at.get(t.splitId);
    if (i === undefined) {
      at.set(t.splitId, out.length);
      out.push({ kind: "receipt", key: `split:${t.splitId}`, splitId: t.splitId, parts: [t], total: t.amount });
    } else {
      const r = out[i] as Extract<TxnRow, { kind: "receipt" }>;
      r.parts.push(t);
      r.total += t.amount;
    }
  }
  return out;
}

/** Идентификаторы операций строки. */
export const rowIds = (r: TxnRow) => (r.kind === "txn" ? [r.txn.id] : r.parts.map((p) => p.id));

/** «Ашан, 3 категории». */
export function receiptTitle(parts: Txn[]) {
  const n = parts.length;
  const name = parts[0]?.payee || "Чек";
  return `${name}, ${n} ${plural(n, "категория", "категории", "категорий")}`;
}

export function plural(n: number, one: string, few: string, many: string) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}
