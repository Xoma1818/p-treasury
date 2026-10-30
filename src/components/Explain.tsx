import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAccounts, useCurrencies } from "../lib/queries";
import { useUi } from "../lib/store";
import { Modal } from "./Modal";
import { Money } from "./Money";

export type ExplainKind = "balance" | "income" | "expense" | "saldo";

const TITLE: Record<ExplainKind, string> = {
  balance: "Как посчитан общий баланс",
  income: "Из чего сложились доходы",
  expense: "Из чего сложились расходы",
  saldo: "Как посчитано сальдо месяца",
};

/** «Как посчитано»: составляющие итога Главной и что в него не вошло. */
export function ExplainDialog({ kind, on, from, to, onClose }: { kind: ExplainKind; on: string; from: string; to: string; onClose: () => void }) {
  return (
    <Modal title={TITLE[kind]} onClose={onClose} wide>
      <div data-testid="explain" data-kind={kind}>
        {kind === "balance" ? <BalanceParts on={on} onClose={onClose} /> : kind === "saldo" ? <Saldo from={from} to={to} onClose={onClose} /> : <PeriodParts kind={kind} from={from} to={to} onClose={onClose} />}
      </div>
      <div className="actions">
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </Modal>
  );
}

function useBaseSymbol(code?: string) {
  return useCurrencies().data?.find((c) => c.code === code)?.symbol ?? "₽";
}

function BalanceParts({ on, onClose }: { on: string; onClose: () => void }) {
  const data = useQuery({ queryKey: ["explainBalance", on], queryFn: () => api.explainBalance(on) }).data;
  const accounts = useAccounts().data ?? [];
  const base = useBaseSymbol(data?.baseCurrency);
  const showTransactions = useUi((s) => s.showTransactions);
  if (!data) return null;
  const why = { in: "", excluded: "не учитывается в общем балансе (настройка счёта)", no_rate: "нет курса валюты — не вошёл" };
  return (
    <>
      <p className="muted">Сумма остатков всех счетов на сегодня в основной валюте по курсу на эту дату. Брокерские счета — по последней оценке.</p>
      <table className="table explain-table">
        <tbody>
          {data.accounts.map((a) => {
            const acc = accounts.find((x) => x.id === a.id);
            return (
              <tr key={a.id} className={a.status === "in" ? undefined : "dup"} data-testid="explain-row" data-status={a.status}>
                <td>
                  <button className="link" onClick={() => (showTransactions({ accountId: a.id }), onClose())}>
                    {a.name}
                  </button>
                  {a.status !== "in" && <div className="hint">{why[a.status]}</div>}
                </td>
                <td className="num">{a.currency !== data.baseCurrency && <Money amount={a.balance} symbol={acc?.currencySymbol} minorUnits={acc?.minorUnits} />}</td>
                <td className="num">{a.converted !== null ? <Money amount={a.converted} symbol={base} /> : "—"}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <th>Итого</th>
            <th />
            <th className="num" data-testid="explain-total">
              <Money amount={data.total} symbol={base} />
            </th>
          </tr>
        </tfoot>
      </table>
    </>
  );
}

function PeriodParts({ kind, from, to, onClose }: { kind: "income" | "expense"; from: string; to: string; onClose: () => void }) {
  const data = useQuery({ queryKey: ["explainPeriod", from, to, kind], queryFn: () => api.explainPeriod(from, to, kind) }).data;
  const base = useBaseSymbol(data?.baseCurrency);
  const showTransactions = useUi((s) => s.showTransactions);
  if (!data) return null;
  const notes: string[] = [];
  if (data.spreadParts > 0) notes.push(`Траты «по месяцам»: в этот месяц вошли их части (${data.spreadParts}), а не полные суммы.`);
  if (data.splitParts > 0) notes.push(`Разбитые чеки: каждая часть (${data.splitParts}) — в своей категории.`);
  if (data.transfers > 0) notes.push(`Переводы между своими счетами (${data.transfers}) не доход и не расход — не вошли.`);
  if (data.planned > 0) notes.push(`Запланированные, ещё не проведённые операции (${data.planned}) не вошли.`);
  if (data.adjustments !== 0) notes.push("Корректировки при сверке баланса не входят в доходы и расходы.");
  if (data.missingRates.length > 0) notes.push(`Нет курса для ${data.missingRates.join(", ")}: такие операции не вошли.`);
  return (
    <>
      <p className="muted">
        Проведённые {kind === "income" ? "доходы" : "расходы"} с {from.split("-").reverse().join(".")} по {to.split("-").reverse().join(".")} в основной валюте по курсу дня операции: {data.count} операций.
      </p>
      <table className="table explain-table">
        <tbody>
          {data.categories.map((c) => (
            <tr key={c.categoryId} data-testid="explain-row">
              <td>
                <button className="link" onClick={() => (showTransactions({ categoryId: c.categoryId, dateFrom: from, dateTo: to, types: [kind] }), onClose())}>
                  {c.name}
                </button>
              </td>
              <td className="num muted">{c.count}</td>
              <td className="num">
                <Money amount={c.amount} symbol={base} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th>Итого</th>
            <th />
            <th className="num" data-testid="explain-total">
              <Money amount={data.total} symbol={base} />
            </th>
          </tr>
        </tfoot>
      </table>
      {notes.length > 0 && (
        <ul className="explain-notes" data-testid="explain-notes">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </>
  );
}

function Saldo({ from, to, onClose }: { from: string; to: string; onClose: () => void }) {
  const inc = useQuery({ queryKey: ["explainPeriod", from, to, "income"], queryFn: () => api.explainPeriod(from, to, "income") }).data;
  const exp = useQuery({ queryKey: ["explainPeriod", from, to, "expense"], queryFn: () => api.explainPeriod(from, to, "expense") }).data;
  const base = useBaseSymbol(inc?.baseCurrency);
  const showTransactions = useUi((s) => s.showTransactions);
  if (!inc || !exp) return null;
  return (
    <>
      <p className="muted">Сальдо — доходы минус расходы за месяц. Переводы между своими счетами и корректировки баланса в него не входят.</p>
      <table className="table explain-table">
        <tbody>
          <tr data-testid="explain-row">
            <td>
              <button className="link" onClick={() => (showTransactions({ dateFrom: from, dateTo: to, types: ["income"] }), onClose())}>
                Доходы
              </button>
            </td>
            <td className="num">
              <Money amount={inc.total} symbol={base} signed />
            </td>
          </tr>
          <tr data-testid="explain-row">
            <td>
              <button className="link" onClick={() => (showTransactions({ dateFrom: from, dateTo: to, types: ["expense"] }), onClose())}>
                Расходы
              </button>
            </td>
            <td className="num">
              <Money amount={-exp.total} symbol={base} />
            </td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <th>Сальдо</th>
            <th className="num" data-testid="explain-total">
              <Money amount={inc.total - exp.total} symbol={base} signed />
            </th>
          </tr>
        </tfoot>
      </table>
    </>
  );
}
