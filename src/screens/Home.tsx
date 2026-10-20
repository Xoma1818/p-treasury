import { useQuery } from "@tanstack/react-query";
import { Money } from "../components/Money";
import { TxnTable } from "../components/TxnTable";
import { api } from "../lib/api";
import { monthBounds, monthTitle, today } from "../lib/dates";
import { useAccounts } from "../lib/queries";
import { useUi } from "../lib/store";

export function Home() {
  const date = today();
  const [from, to] = monthBounds(date);
  const totals = useQuery({ queryKey: ["totals", date], queryFn: () => api.totals(date) });
  const month = useQuery({ queryKey: ["summary", from, to], queryFn: () => api.periodSummary(from, to) });
  const recent = useQuery({ queryKey: ["transactions", "recent"], queryFn: () => api.listTransactions({ limit: 8 }) });
  const accounts = useAccounts().data ?? [];
  const { openTxnForm, showTransactions } = useUi();
  const symbol = totals.data?.baseSymbol ?? "₽";

  return (
    <section className="screen wide">
      <div className="screen-head">
        <h1>Главная</h1>
        <div className="btn-group">
          <button className="btn" onClick={() => openTxnForm({ mode: "new", type: "income" })}>
            + Доход
          </button>
          <button className="btn" onClick={() => openTxnForm({ mode: "new", type: "transfer" })}>
            Перевод
          </button>
          <button className="btn primary" onClick={() => openTxnForm({ mode: "new", type: "expense" })} title="Ctrl+N">
            + Расход
          </button>
        </div>
      </div>

      <div className="tiles">
        <div className="card tile" data-testid="total-balance">
          <div className="tile-label">Общий баланс</div>
          <div className="tile-value">{totals.data && <Money amount={totals.data.total} symbol={symbol} />}</div>
          {totals.data && totals.data.missingRates.length > 0 && (
            <div className="hint warn">Нет курса для {totals.data.missingRates.join(", ")}: такие счета не вошли. Курс вводится в Настройках.</div>
          )}
        </div>
        <div className="card tile" data-testid="month-income">
          <div className="tile-label">Доходы, {monthTitle(date).toLowerCase()}</div>
          <div className="tile-value plus">{month.data && <Money amount={month.data.income} symbol={symbol} />}</div>
        </div>
        <div className="card tile" data-testid="month-expense">
          <div className="tile-label">Расходы, {monthTitle(date).toLowerCase()}</div>
          <div className="tile-value">{month.data && <Money amount={month.data.expense} symbol={symbol} />}</div>
        </div>
        <div className="card tile">
          <div className="tile-label">Сальдо месяца</div>
          <div className="tile-value">{month.data && <Money amount={month.data.income - month.data.expense} symbol={symbol} signed />}</div>
        </div>
      </div>

      <div className="columns home">
        <div className="card">
          <h2>Счета</h2>
          {accounts.length === 0 && <p className="muted">Счетов нет.</p>}
          <ul className="account-list">
            {accounts.map((a) => (
              <li key={a.id} onClick={() => showTransactions({ accountId: a.id })} className="clickable">
                <span>{a.name}</span>
                <Money amount={a.balance} symbol={a.currencySymbol} minorUnits={a.minorUnits} />
              </li>
            ))}
          </ul>
        </div>
        <div className="card">
          <h2>Последние операции</h2>
          {recent.data && <TxnTable items={recent.data.items} compact />}
        </div>
      </div>
      <div className="card empty small">Бюджет месяца появится здесь на этапе 2, ближайшие платежи по долгам на этапе 4.</div>
    </section>
  );
}
