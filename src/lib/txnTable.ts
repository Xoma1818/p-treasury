// Г8: таблица «Операций» под себя: какие столбцы и в каком порядке, группы по дням,
// категориям или счетам, сортировка по любому столбцу. Хранится в окне, копия — в базе
// (uiPrefs); сохранённый вид запоминает и это.
import { useEffect, useState } from "react";
import type { Txn } from "./api";
import { formatDate } from "./dates";
import { groupReceipts, type TxnRow } from "./receipt";
import { pushPref } from "./uiPrefs";

export const TABLE_KEY = "kazna.txnTable";
const TABLE_EVENT = "kazna:txnTable";

export const TABLE_COLS = ["date", "what", "payee", "note", "account", "amount"] as const;
export type Col = (typeof TABLE_COLS)[number];
export const COL_LABEL: Record<Col, string> = {
  date: "Дата",
  what: "Операция",
  payee: "Получатель",
  note: "Комментарий",
  account: "Счёт",
  amount: "Сумма",
};
/** Без них строка теряет смысл: всегда видны. */
export const FIXED_COLS: readonly Col[] = ["what", "amount"];

export const GROUPS = ["none", "day", "category", "account"] as const;
export type Group = (typeof GROUPS)[number];
export const GROUP_LABEL: Record<Group, string> = { none: "Без групп", day: "По дням", category: "По категориям", account: "По счетам" };

export const SORTS = ["date", "amount", "category", "account", "payee"] as const;
export type SortBy = (typeof SORTS)[number];
/** По какому полю сортирует нажатие на заголовок столбца. */
export const COL_SORT: Record<Col, SortBy | null> = { date: "date", what: "category", payee: "payee", note: null, account: "account", amount: "amount" };

export interface TxnTableLayout {
  cols: Col[];
  group: Group;
  sort: { by: SortBy; desc: boolean };
}

export const DEFAULT_TABLE: TxnTableLayout = { cols: ["date", "what", "account", "amount"], group: "none", sort: { by: "date", desc: true } };
/** Короткий список на Главной и в Календаре. */
export const COMPACT_COLS: Col[] = ["date", "what", "amount"];

const isCol = (x: unknown): x is Col => TABLE_COLS.includes(x as Col);

/** Из окна, базы или сохранённого вида; лишнее отбрасывается, обязательные столбцы возвращаются. */
export function parseTable(raw: unknown): TxnTableLayout {
  let v: unknown = raw;
  if (typeof raw === "string" || raw == null) {
    try {
      v = JSON.parse((raw as string | null) || "null");
    } catch {
      return DEFAULT_TABLE;
    }
  }
  if (!v || typeof v !== "object") return DEFAULT_TABLE;
  const o = v as Record<string, unknown>;
  let cols = Array.isArray(o.cols) ? [...new Set(o.cols.filter(isCol))] : DEFAULT_TABLE.cols;
  for (const c of FIXED_COLS) if (!cols.includes(c)) cols = c === "amount" ? [...cols, c] : [c, ...cols];
  const group = GROUPS.includes(o.group as Group) ? (o.group as Group) : "none";
  const s = o.sort as Record<string, unknown> | undefined;
  const sort = s && SORTS.includes(s.by as SortBy) ? { by: s.by as SortBy, desc: s.desc === true } : DEFAULT_TABLE.sort;
  return { cols, group, sort };
}

export const isDefaultTable = (t: TxnTableLayout) => JSON.stringify(t) === JSON.stringify(DEFAULT_TABLE);

/** Показать или спрятать столбец; новый встаёт перед суммой. */
export function toggleCol(t: TxnTableLayout, c: Col): TxnTableLayout {
  if (FIXED_COLS.includes(c)) return t;
  if (t.cols.includes(c)) return { ...t, cols: t.cols.filter((x) => x !== c) };
  const at = t.cols.indexOf("amount");
  const cols = [...t.cols];
  cols.splice(at < 0 ? cols.length : at, 0, c);
  return { ...t, cols };
}

/** Сдвинуть столбец левее (-1) или правее (+1). */
export function moveCol(t: TxnTableLayout, c: Col, delta: -1 | 1): TxnTableLayout {
  const i = t.cols.indexOf(c);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= t.cols.length) return t;
  const cols = [...t.cols];
  [cols[i], cols[j]] = [cols[j], cols[i]];
  return { ...t, cols };
}

/** Нажатие на заголовок: тот же столбец — обратный порядок; новый — даты и суммы сверху крупные, имена по алфавиту. */
export function clickSort(t: TxnTableLayout, by: SortBy): TxnTableLayout {
  const desc = t.sort.by === by ? !t.sort.desc : by === "date" || by === "amount";
  return { ...t, sort: { by, desc } };
}

/** Порядок для ядра; по умолчанию (новые сверху) — ничего. */
export const sortParam = (t: TxnTableLayout) => (t.sort.by === "date" && t.sort.desc ? undefined : `${t.sort.by}:${t.sort.desc ? "desc" : "asc"}`);

export interface RowGroup {
  key: string;
  label: string;
  rows: TxnRow[];
  /** Итог группы со знаком, если в ней одна валюта; переводы не считаются. */
  total: { amount: number; symbol: string; minorUnits: number } | null;
}

const first = (r: TxnRow) => (r.kind === "txn" ? r.txn : r.parts[0]);

function groupOf(r: TxnRow, g: Group): [string, string] {
  const t = first(r);
  if (g === "day") return [t.date, formatDate(t.date)];
  if (g === "account") return [t.accountId, t.accountName];
  if (r.kind === "receipt") return ["receipt", "Чеки на несколько категорий"];
  if (t.type === "transfer") return ["transfer", "Переводы"];
  if (t.type === "adjustment") return ["adjustment", "Корректировки"];
  return [t.categoryId ?? "none", t.categoryName ?? "Без категории"];
}

function signed(t: Txn): number {
  if (t.type === "transfer") return 0;
  return t.type === "expense" ? -t.amount : t.amount;
}

/** Группы по первому появлению в списке: порядок сортировки сохраняется внутри и между группами. */
export function groupRows(items: Txn[], g: Group): RowGroup[] {
  const rows = groupReceipts(items);
  if (g === "none") return [{ key: "all", label: "", rows, total: null }];
  const out = new Map<string, RowGroup & { symbols: Set<string> }>();
  for (const r of rows) {
    const [key, label] = groupOf(r, g);
    let grp = out.get(key);
    if (!grp) {
      const t = first(r);
      grp = { key, label, rows: [], total: { amount: 0, symbol: t.currencySymbol, minorUnits: t.minorUnits }, symbols: new Set() };
      out.set(key, grp);
    }
    grp.rows.push(r);
    for (const t of r.kind === "txn" ? [r.txn] : r.parts) {
      grp.symbols.add(t.currencySymbol);
      if (grp.total) grp.total.amount += signed(t);
    }
  }
  return [...out.values()].map(({ symbols, ...grp }) => ({ ...grp, total: symbols.size === 1 ? grp.total : null }));
}

/** Строки в том порядке, в котором они на экране (для выделения с Shift). */
export const orderedRows = (items: Txn[], g: Group) => groupRows(items, g).flatMap((x) => x.rows);

function read(): string | null {
  try {
    return localStorage.getItem(TABLE_KEY);
  } catch {
    return null;
  }
}

export const savedTable = () => parseTable(read());

export function saveTable(t: TxnTableLayout) {
  const v = JSON.stringify(t);
  pushPref(TABLE_KEY, v);
  try {
    localStorage.setItem(TABLE_KEY, v);
  } catch {
    /* без запоминания */
  }
  window.dispatchEvent(new Event(TABLE_EVENT));
}

export const notifyTable = () => window.dispatchEvent(new Event(TABLE_EVENT));

export function useTxnTable(): TxnTableLayout {
  const [t, setT] = useState(savedTable);
  useEffect(() => {
    const on = () => setT(savedTable());
    window.addEventListener(TABLE_EVENT, on);
    return () => window.removeEventListener(TABLE_EVENT, on);
  }, []);
  return t;
}
