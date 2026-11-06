import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type TxnChange } from "../lib/api";
import { formatDate, formatDateTime, isoDateTime } from "../lib/dates";
import { HIDDEN_AMOUNT } from "../lib/money";
import { useSettings } from "../lib/queries";

/** Метка UTC из базы → местные «05.11.2026 14:02». */
const when = (at: string) => formatDateTime(isoDateTime(new Date(at)));

/** Даты полей приходят как 2026-11-05 — показываем в формате из настроек. */
const value = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? formatDate(v) : v);

function times(n: number) {
  const last = n % 10;
  const teen = n % 100 >= 11 && n % 100 <= 14;
  return `${n} ${!teen && last >= 2 && last <= 4 ? "раза" : "раз"}`;
}

/**
 * История изменений операции внизу карточки: одна строка «Добавлена … · изменена N раз»,
 * по нажатию — когда и что поменялось.
 */
export function TxnHistory({ id, splitId }: { id: string; splitId?: string | null }) {
  const [open, setOpen] = useState(false);
  const hidden = useSettings().data?.hide_amounts === "1";
  const { data } = useQuery({ queryKey: ["txnHistory", id, splitId ?? null], queryFn: () => api.transactionHistory(id, splitId ?? null) });
  if (!data?.createdAt) return null;
  const n = data.changes.length;
  const added = `${data.imported ? "Загружена из выписки" : "Добавлена"} ${when(data.createdAt)}`;
  return (
    <div className="txn-history" data-testid="txn-history">
      {n === 0 ? (
        <span className="muted">{added}</span>
      ) : (
        <button type="button" className="link more-toggle" data-testid="txn-history-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {added} · изменена {times(n)} {open ? "▾" : "▸"}
        </button>
      )}
      {open && n > 0 && (
        <ol className="txn-history-list" data-testid="txn-history-list">
          {data.changes.map((c, i) => (
            <Entry key={i} change={c} hidden={hidden} />
          ))}
        </ol>
      )}
    </div>
  );
}

function Entry({ change, hidden }: { change: TxnChange; hidden: boolean }) {
  // «Скрыть суммы» прячет и прежние, и новые суммы.
  const show = (v: string, money: boolean) => (hidden && money ? HIDDEN_AMOUNT : value(v));
  return (
    <li>
      <span className="muted">{when(change.at)}</span>
      {change.kind === "delete" ? (
        <span> Удалена, потом возвращена</span>
      ) : (
        change.fields.map((f) => (
          <div key={f.field}>
            {f.field}: <s className="muted">{show(f.before, f.money)}</s> → {show(f.after, f.money)}
          </div>
        ))
      )}
    </li>
  );
}
