import { useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight } from "lucide-react";
import { api, type Txn } from "../lib/api";
import { useAction } from "../lib/useAction";
import { openContextMenu, type CtxItem } from "./ContextMenu";
import { formatDate } from "../lib/dates";
import { receiptTitle, rowIds, type TxnRow } from "../lib/receipt";
import { COL_LABEL, COL_SORT, COMPACT_COLS, DEFAULT_TABLE, groupRows, type Col, type SortBy, type TxnTableLayout } from "../lib/txnTable";
import { isRowSelected, type SelState } from "../lib/selection";
import { useUi } from "../lib/store";
import { Money } from "./Money";
import { ErrorText } from "./Modal";

/** Тип данных перетаскивания операции (на другой день календаря). */
export const TXN_DRAG = "application/x-p-treasury-txn";

/** Выделение строк (Г1): что выделено и что делать при щелчке с клавишей. */
export interface TableSelection {
  sel: SelState;
  onToggle: (key: string, mods: { shift: boolean; ctrl: boolean }) => void;
}

/** Список операций; нажатие на строку открывает операцию. `draggable` — строку можно перетащить.
 *  Части разбитого чека показаны одной строкой «Ашан, 3 категории» с раскрытием. */
export function TxnTable({
  items,
  compact,
  draggable,
  selection,
  layout,
  onSort,
}: {
  items: Txn[];
  compact?: boolean;
  draggable?: boolean;
  selection?: TableSelection;
  /** Г8: столбцы, группы и порядок; без него — как всегда. */
  layout?: TxnTableLayout;
  /** Заголовки столбцов нажимаются и сортируют. */
  onSort?: (by: SortBy) => void;
}) {
  const open = useUi((s) => s.openTxnForm);
  const showTransactions = useUi((s) => s.showTransactions);
  const openDebt = useUi((s) => s.openDebt);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const remove = useAction((t: Txn) => (t.splitId ? api.deleteReceipt(t.splitId) : api.deleteTransaction(t.id)));
  // Г2: правая кнопка — все действия с операцией в одном меню.
  const menuFor = (t: Txn): CtxItem[] => {
    const items: CtxItem[] = [{ text: "Открыть", onClick: () => open({ mode: "edit", txn: t }) }];
    if (t.type !== "adjustment" && !t.refund && !t.splitId)
      items.push({
        text: "Повторить сегодня",
        onClick: () =>
          open({
            mode: "new",
            type: t.type,
            prefill: { amount: t.amount, accountId: t.accountId, toAccountId: t.toAccountId, categoryId: t.categoryId, payee: t.payee, note: t.note, tags: t.tags },
          }),
      });
    if (t.type === "expense" && !t.debtId && !t.spreadMonths && !t.refund) items.push({ text: "Вернуть…", onClick: () => open({ mode: "refund", purchase: t }) });
    if (t.payee) items.push({ text: `Все с «${t.payee}»`, onClick: () => showTransactions({ search: t.payee! }) });
    // Платёж по долгу удаляется в карточке долга (ядро здесь откажет): вместо «Удалить» — «Открыть долг».
    if (t.debtId) items.push({ text: "Открыть долг", onClick: () => openDebt(t.debtId!) });
    else if (t.type !== "adjustment") items.push({ text: t.splitId ? "Удалить чек" : "Удалить", hint: "Ctrl+Z — отменить", danger: true, onClick: () => remove.run(t) });
    return items;
  };
  if (items.length === 0) return <p className="muted">Операций нет.</p>;
  const view = layout ?? DEFAULT_TABLE;
  // По дням дата уже в заголовке группы — в строках она не повторяется.
  const cols: Col[] = compact ? COMPACT_COLS : view.group === "day" ? view.cols.filter((c) => c !== "date") : view.cols;
  const groups = groupRows(items, compact ? "none" : view.group);
  const toggleOpen = (key: string) =>
    setExpanded((cur) => {
      const n = new Set(cur);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  const renderRow = (r: TxnRow) => {
    const t = r.kind === "txn" ? r.txn : r.parts[0];
    const movable = draggable && canMove(t);
    const selected = selection ? isRowSelected(selection.sel, { key: r.key, ids: rowIds(r) }) : false;
    const isOpen = r.kind === "receipt" && expanded.has(r.key);
    const main = (
      <tr
        key={r.key}
        onClick={(e) => {
          // С Ctrl или Shift щелчок выделяет строку, без клавиш — открывает операцию.
          if (selection && (e.ctrlKey || e.metaKey || e.shiftKey)) return selection.onToggle(r.key, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });
          open({ mode: "edit", txn: t });
        }}
        onMouseDown={(e) => selection && e.shiftKey && e.preventDefault()}
        onContextMenu={(e) => openContextMenu(e, menuFor(t))}
        className={["clickable", movable && "draggable", selected && "selected", r.kind === "receipt" && "receipt"].filter(Boolean).join(" ")}
        data-testid="txn-row"
        data-receipt={r.kind === "receipt" ? r.parts.length : undefined}
        aria-selected={selection ? selected : undefined}
        draggable={movable}
        onDragStart={(e) => {
          e.dataTransfer.setData(TXN_DRAG, t.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        title={movable ? "Перетащите на другой день, чтобы перенести" : undefined}
      >
        {selection && (
          <td className="sel" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              aria-label="Выделить операцию"
              data-testid="txn-select"
              checked={selected}
              onChange={() => {}}
              onClick={(e) => selection.onToggle(r.key, { shift: e.shiftKey, ctrl: true })}
            />
          </td>
        )}
        {cols.map((c) => {
          switch (c) {
            case "date":
              return <td key={c} className="date">{formatDate(t.date)}</td>;
            case "what":
              return (
                <td key={c}>
                  <div className="main">
                    {r.kind === "receipt" ? (
                      <>
                        <button
                          className="icon-btn small receipt-toggle"
                          aria-label={isOpen ? "Свернуть чек" : "Раскрыть чек"}
                          aria-expanded={isOpen}
                          onClick={(e) => (e.stopPropagation(), toggleOpen(r.key))}
                        >
                          {isOpen ? <ChevronDown size={14} strokeWidth={2} aria-hidden="true" /> : <ChevronRight size={14} strokeWidth={2} aria-hidden="true" />}
                        </button>
                        <span data-testid="receipt-title">{receiptTitle(r.parts)}</span>
                      </>
                    ) : (
                      describe(t)
                    )}
                    {t.refund && (
                      <span className="event-tag" title={t.countDate ? "Учтён в месяце покупки" : "Учтён в месяце возврата"} data-testid="txn-refund-tag">
                        возврат
                      </span>
                    )}
                    {t.spreadMonths != null && (
                      <span className="spread-tag" title={`Учитывается по месяцам: ${t.spreadMonths}`} data-testid="txn-spread">
                        ÷ {t.spreadMonths} мес.
                      </span>
                    )}
                    {t.eventName && (
                      <span className="event-tag" data-testid="txn-event">
                        {t.eventName}
                      </span>
                    )}
                    {(t.tags ?? []).map((g) => (
                      <span key={g} className="tag-chip" data-testid="txn-tag">
                        #{g}
                      </span>
                    ))}
                  </div>
                  {!compact && r.kind === "txn" && subLine(t, cols) && <div className="sub">{subLine(t, cols)}</div>}
                  {!compact && r.kind === "receipt" && <div className="sub">{r.parts.map((p) => p.categoryName).join(", ")}</div>}
                </td>
              );
            case "payee":
              return <td key={c} className="sub" data-col="payee">{t.payee}</td>;
            case "note":
              return <td key={c} className="sub" data-col="note">{t.note}</td>;
            case "account":
              return <td key={c} className="sub">{t.type === "transfer" ? `${t.accountName} → ${t.toAccountName}` : t.accountName}</td>;
            case "amount":
              return (
                <td key={c} className="num">
                  {r.kind === "receipt" ? <Money amount={-r.total} symbol={t.currencySymbol} minorUnits={t.minorUnits} signed /> : <Amount t={t} />}
                </td>
              );
          }
        })}
      </tr>
    );
    if (!isOpen || r.kind !== "receipt") return main;
    return [
      main,
      ...r.parts.map((p) => (
        <tr key={`${r.key}-${p.id}`} className={selected ? "receipt-part clickable selected" : "receipt-part clickable"} data-testid="receipt-part" onClick={() => open({ mode: "edit", txn: t })}>
          {selection && <td className="sel" />}
          {cols.map((c) =>
            c === "what" ? (
              <td key={c}>
                <div className="main">{p.categoryName}</div>
                {!compact && p.note && p.note !== t.note && <div className="sub">{p.note}</div>}
              </td>
            ) : c === "amount" ? (
              <td key={c} className="num">
                <Money amount={-p.amount} symbol={p.currencySymbol} minorUnits={p.minorUnits} signed />
              </td>
            ) : (
              <td key={c} />
            ),
          )}
        </tr>
      )),
    ];
  };

  return (
    <>
      {/* Отказ удаления из меню правой кнопки виден, а не теряется молча. */}
      <ErrorText error={remove.error} />
      <table className={selection ? "table txn-table selectable" : "table txn-table"}>
        {onSort && !compact && (
          <thead>
            <tr>
              {selection && <th className="sel" />}
              {cols.map((c) => {
                const by = COL_SORT[c];
                const on = by !== null && view.sort.by === by;
                const label = COL_LABEL[c];
                return (
                  <th key={c} className={c === "amount" ? "num" : c === "date" ? "date" : undefined} aria-sort={on ? (view.sort.desc ? "descending" : "ascending") : undefined}>
                    {by ? (
                      <button type="button" className={on ? "th-sort active" : "th-sort"} data-sort={by} onClick={() => onSort(by)} title="Сортировать по этому столбцу">
                        {label}
                        {on && (view.sort.desc ? <ArrowDown size={12} aria-hidden /> : <ArrowUp size={12} aria-hidden />)}
                      </button>
                    ) : (
                      label
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
        )}
        {groups.map((g) => (
          <tbody key={g.key} data-testid={g.label ? "txn-group" : undefined}>
            {g.label && (
              <tr className="group-row">
                <td colSpan={cols.length + (selection ? 1 : 0)}>
                  <span className="group-label" data-testid="txn-group-label">{g.label}</span>
                  <span className="muted group-count">{g.rows.length}</span>
                  {g.total && g.total.amount !== 0 && (
                    <span className="group-total">
                      <Money amount={g.total.amount} symbol={g.total.symbol} minorUnits={g.total.minorUnits} signed />
                    </span>
                  )}
                </td>
              </tr>
            )}
            {g.rows.map(renderRow)}
          </tbody>
        ))}
      </table>
    </>
  );
}

const canMove = (t: Txn) => !t.debtId && t.type !== "adjustment";

/** Строка под категорией: получатель и комментарий, если у них нет своего столбца. */
function subLine(t: Txn, cols: Col[]): string {
  return [!cols.includes("payee") && t.payee, !cols.includes("note") && t.note].filter(Boolean).join(" · ");
}

function describe(t: Txn): string {
  switch (t.type) {
    case "transfer":
      return "Перевод";
    case "adjustment":
      return "Корректировка";
    default:
      return t.categoryName ?? "";
  }
}

function Amount({ t }: { t: Txn }) {
  if (t.type === "transfer") {
    const same = t.toCurrencySymbol === t.currencySymbol;
    return (
      <span className="transfer">
        <Money amount={t.amount} symbol={t.currencySymbol} minorUnits={t.minorUnits} />
        {!same && t.toAmount != null && (
          <>
            {" → "}
            <Money amount={t.toAmount} symbol={t.toCurrencySymbol ?? ""} minorUnits={t.toMinorUnits ?? 2} />
          </>
        )}
      </span>
    );
  }
  const signed = t.type === "expense" ? -t.amount : t.amount;
  return <Money amount={signed} symbol={t.currencySymbol} minorUnits={t.minorUnits} signed className={signed > 0 ? "plus" : ""} />;
}
