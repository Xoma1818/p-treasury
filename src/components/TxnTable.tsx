import type { Txn } from "../lib/api";
import { formatDate } from "../lib/dates";
import { useUi } from "../lib/store";
import { Money } from "./Money";

/** Тип данных перетаскивания операции (на другой день календаря). */
export const TXN_DRAG = "application/x-p-treasury-txn";

/** Список операций; нажатие на строку открывает операцию. `draggable` — строку можно перетащить. */
export function TxnTable({ items, compact, draggable }: { items: Txn[]; compact?: boolean; draggable?: boolean }) {
  const open = useUi((s) => s.openTxnForm);
  if (items.length === 0) return <p className="muted">Операций нет.</p>;
  return (
    <table className="table txn-table">
      <tbody>
        {items.map((t) => (
          <tr
            key={t.id}
            onClick={() => open({ mode: "edit", txn: t })}
            className={draggable && canMove(t) ? "clickable draggable" : "clickable"}
            data-testid="txn-row"
            draggable={draggable && canMove(t)}
            onDragStart={(e) => {
              e.dataTransfer.setData(TXN_DRAG, t.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            title={draggable && canMove(t) ? "Перетащите на другой день, чтобы перенести" : undefined}
          >
            <td className="date">{formatDate(t.date)}</td>
            <td>
              <div className="main">
                {describe(t)}
                {t.eventName && (
                  <span className="event-tag" data-testid="txn-event">
                    {t.eventName}
                  </span>
                )}
              </div>
              {!compact && (t.payee || t.note) && <div className="sub">{[t.payee, t.note].filter(Boolean).join(" · ")}</div>}
            </td>
            {!compact && <td className="sub">{t.type === "transfer" ? `${t.accountName} → ${t.toAccountName}` : t.accountName}</td>}
            <td className="num">
              <Amount t={t} />
            </td>
          </tr>
        ))}
      </tbody>
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
