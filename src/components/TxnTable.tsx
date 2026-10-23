import { useState } from "react";
import type { Txn } from "../lib/api";
import { formatDate } from "../lib/dates";
import { groupReceipts, receiptTitle, rowIds, type TxnRow } from "../lib/receipt";
import { isRowSelected, type SelState } from "../lib/selection";
import { useUi } from "../lib/store";
import { Money } from "./Money";

/** Тип данных перетаскивания операции (на другой день календаря). */
export const TXN_DRAG = "application/x-p-treasury-txn";

/** Выделение строк (Г1): что выделено и что делать при щелчке с клавишей. */
export interface TableSelection {
  sel: SelState;
  onToggle: (key: string, mods: { shift: boolean; ctrl: boolean }) => void;
}

/** Список операций; нажатие на строку открывает операцию. `draggable` — строку можно перетащить.
 *  Части разбитого чека показаны одной строкой «Ашан, 3 категории» с раскрытием. */
export function TxnTable({ items, compact, draggable, selection }: { items: Txn[]; compact?: boolean; draggable?: boolean; selection?: TableSelection }) {
  const open = useUi((s) => s.openTxnForm);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  if (items.length === 0) return <p className="muted">Операций нет.</p>;
  const rows = groupReceipts(items);
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
        <td className="date">{formatDate(t.date)}</td>
        <td>
          <div className="main">
            {r.kind === "receipt" ? (
              <>
                <button
                  className="icon-btn small receipt-toggle"
                  aria-label={isOpen ? "Свернуть чек" : "Раскрыть чек"}
                  aria-expanded={isOpen}
                  onClick={(e) => (e.stopPropagation(), toggleOpen(r.key))}
                >
                  {isOpen ? "▾" : "▸"}
                </button>
                <span data-testid="receipt-title">{receiptTitle(r.parts)}</span>
              </>
            ) : (
              describe(t)
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
          {!compact && r.kind === "txn" && (t.payee || t.note) && <div className="sub">{[t.payee, t.note].filter(Boolean).join(" · ")}</div>}
          {!compact && r.kind === "receipt" && <div className="sub">{r.parts.map((p) => p.categoryName).join(", ")}</div>}
        </td>
        {!compact && <td className="sub">{t.type === "transfer" ? `${t.accountName} → ${t.toAccountName}` : t.accountName}</td>}
        <td className="num">{r.kind === "receipt" ? <Money amount={-r.total} symbol={t.currencySymbol} minorUnits={t.minorUnits} signed /> : <Amount t={t} />}</td>
      </tr>
    );
    if (!isOpen || r.kind !== "receipt") return main;
    return [
      main,
      ...r.parts.map((p) => (
        <tr key={`${r.key}-${p.id}`} className={selected ? "receipt-part clickable selected" : "receipt-part clickable"} data-testid="receipt-part" onClick={() => open({ mode: "edit", txn: t })}>
          {selection && <td className="sel" />}
          <td />
          <td>
            <div className="main">{p.categoryName}</div>
            {!compact && p.note && p.note !== t.note && <div className="sub">{p.note}</div>}
          </td>
          {!compact && <td />}
          <td className="num">
            <Money amount={-p.amount} symbol={p.currencySymbol} minorUnits={p.minorUnits} signed />
          </td>
        </tr>
      )),
    ];
  };

  return (
    <table className={selection ? "table txn-table selectable" : "table txn-table"}>
      <tbody>{rows.map(renderRow)}</tbody>
    </table>
  );
}

const canMove = (t: Txn) => !t.debtId && t.type !== "adjustment";

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
