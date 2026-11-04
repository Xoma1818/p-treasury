import { useQuery } from "@tanstack/react-query";
import { api, type Txn } from "../lib/api";
import { formatDate } from "../lib/dates";
import { useUi } from "../lib/store";
import { Money } from "./Money";

/** Р4: в панели операции — последние похожие (тот же получатель, а без него — та же категория).
 *  Щелчок открывает похожую операцию, «Все» — список в «Операциях» с тем же отбором. */
export function SimilarTxns({ txn }: { txn: Txn }) {
  const { openTxnForm, showTransactions } = useUi();
  const by = txn.payee ? { search: txn.payee } : txn.categoryId ? { categoryId: txn.categoryId } : null;
  const q = useQuery({
    queryKey: ["transactions", "similar", txn.id, by],
    queryFn: () => api.listTransactions({ ...by, limit: 6 }),
    enabled: !!by,
  });
  const items = (q.data?.items ?? []).filter((t) => t.id !== txn.id).slice(0, 5);
  if (!by || items.length === 0) return null;
  return (
    <div className="similar" data-testid="similar-txns">
      <h3>
        {txn.payee ? `Ещё с «${txn.payee}»` : `Ещё в «${txn.categoryName ?? "категории"}»`}
        <button
          type="button"
          className="link"
          onClick={() => {
            openTxnForm(null);
            showTransactions(by);
          }}
        >
          Все →
        </button>
      </h3>
      <ul>
        {items.map((t) => (
          <li key={t.id} onClick={() => openTxnForm({ mode: "edit", txn: t })}>
            <span>
              <span className="when">{formatDate(t.date)}</span>
              {t.payee || t.categoryName || t.note || "Без названия"}
            </span>
            <Money amount={t.type === "expense" ? -t.amount : t.amount} symbol={t.currencySymbol} minorUnits={t.minorUnits} signed={t.type !== "transfer"} />
          </li>
        ))}
      </ul>
    </div>
  );
}
