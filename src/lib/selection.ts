// Выделение строк в «Операциях» (Г1): флажок, Shift — диапазон, Ctrl — по одной.
// Строка — это операция или весь разбитый чек, поэтому у строки может быть
// несколько идентификаторов; выделение хранит идентификаторы операций.

export interface SelRow {
  key: string;
  ids: string[];
}

export interface SelState {
  ids: Set<string>;
  /** Строка, от которой считается диапазон по Shift. */
  anchor: string | null;
}

export const EMPTY_SEL: SelState = { ids: new Set(), anchor: null };

/** Строка выделена целиком. */
export const isRowSelected = (sel: SelState, row: SelRow) => row.ids.length > 0 && row.ids.every((id) => sel.ids.has(id));

/**
 * Нажатие на флажок строки или на строку с клавишей.
 * - без клавиш и с Ctrl — строка добавляется или снимается, она становится началом диапазона;
 * - Shift — выделяются строки от начала диапазона до этой (прежнее выделение заменяется);
 * - Ctrl+Shift — диапазон добавляется к прежнему выделению.
 */
export function clickRow(sel: SelState, rows: SelRow[], key: string, mods: { shift?: boolean; ctrl?: boolean } = {}): SelState {
  const at = rows.findIndex((r) => r.key === key);
  if (at < 0) return sel;
  const from = sel.anchor ? rows.findIndex((r) => r.key === sel.anchor) : -1;
  if (mods.shift && from >= 0) {
    const [a, b] = from < at ? [from, at] : [at, from];
    const ids = new Set(mods.ctrl ? sel.ids : []);
    for (const r of rows.slice(a, b + 1)) r.ids.forEach((id) => ids.add(id));
    // Начало диапазона остаётся: следующий Shift-щелчок меняет его конец.
    return { ids, anchor: sel.anchor };
  }
  const row = rows[at];
  const ids = new Set(sel.ids);
  if (isRowSelected(sel, row)) row.ids.forEach((id) => ids.delete(id));
  else row.ids.forEach((id) => ids.add(id));
  return { ids, anchor: key };
}

/** Выделить всё (Ctrl+A): все идентификаторы отфильтрованных операций. */
export const selectAll = (ids: string[]): SelState => ({ ids: new Set(ids), anchor: null });

/** Оставить в выделении только операции, которые ещё есть в списке. */
export function keepExisting(sel: SelState, known: Set<string>): SelState {
  const ids = new Set([...sel.ids].filter((id) => known.has(id)));
  return ids.size === sel.ids.size ? sel : { ids, anchor: sel.anchor };
}

/** «Выбрано 12: расходы 18 450 ₽, доходы 0 ₽, итог −18 450 ₽». */
export function selectionTitle(count: number, selected: boolean) {
  return selected ? `Выбрано ${count}` : `Найдено ${count}`;
}
