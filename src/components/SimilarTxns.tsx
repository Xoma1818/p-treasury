import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Txn } from "../lib/api";
import { formatDate } from "../lib/dates";
import { useUi } from "../lib/store";
import { Money } from "./Money";

const norm = (s: string | null | undefined) => (s ?? "").trim().toLocaleLowerCase("ru");

/** Р4: в панели операции — последние похожие (тот же получатель, а без него — та же категория).
 *  Получатель сравнивается целиком: общий поиск находит и операции, где слово есть только в комментарии.
 *  Щелчок или Enter открывает похожую операцию, «Все» — список в «Операциях» с тем же отбором.
 *  Если в форме есть несохранённые правки, сначала спрашиваем. */
export function SimilarTxns({ txn, dirty }: { txn: Txn; dirty: boolean }) {
  const { openTxnForm, showTransactions } = useUi();
  const [pending, setPending] = useState<(() => void) | null>(null);
  const by = txn.payee ? { search: txn.payee } : txn.categoryId ? { categoryId: txn.categoryId } : null;
  const q = useQuery({
    queryKey: ["transactions", "similar", txn.id, by],
    queryFn: () => api.listTransactions({ ...by, limit: 40 }),
    enabled: !!by,
  });
  const items = (q.data?.items ?? [])
    .filter((t) => t.id !== txn.id && (!txn.payee || norm(t.payee) === norm(txn.payee)))
    .slice(0, 5);
  if (!by || items.length === 0) return null;
  const guard = (act: () => void) => (dirty ? setPending(() => act) : act());
  return (
    <div className="similar" data-testid="similar-txns">
      <h3>
        {txn.payee ? `Ещё с «${txn.payee}»` : `Ещё в «${txn.categoryName ?? "категории"}»`}
        <button
          type="button"
          className="link"
          onClick={() =>
            guard(() => {
              openTxnForm(null);
              showTransactions(by);
            })
          }
        >
          Все →
        </button>
      </h3>
      {pending && (
        <div className="hint warn similar-confirm" role="alert" data-testid="similar-confirm">
          Изменения в этой операции не сохранены.{" "}
          <button
            type="button"
            className="link"
            onClick={() => {
              const act = pending;
              setPending(null);
              act();
            }}
          >
            Перейти без сохранения
          </button>
          <button type="button" className="link" autoFocus onClick={() => setPending(null)}>
            Остаться
          </button>
        </div>
      )}
      <ul>
        {items.map((t) => (
          <li key={t.id}>
            <button type="button" className="similar-row" onClick={() => guard(() => openTxnForm({ mode: "edit", txn: t }))}>
              <span>
                <span className="when">{formatDate(t.date)}</span>
                {t.payee || t.categoryName || t.note || "Без названия"}
              </span>
              <Money amount={t.type === "expense" ? -t.amount : t.amount} symbol={t.currencySymbol} minorUnits={t.minorUnits} signed={t.type !== "transfer"} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
