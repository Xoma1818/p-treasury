import { useQuery } from "@tanstack/react-query";
import { Money } from "../components/Money";
import { TxnTable } from "../components/TxnTable";
import { api } from "../lib/api";
import { formatDate, monthTitle, today } from "../lib/dates";
import { useAccounts, useBudget, useMonthOf } from "../lib/queries";
import { useUi } from "../lib/store";

export function Home() {
  const date = today();
  // Месяц считается от настройки «первый день месяца», как в бюджете.
  const period = useMonthOf(date).data;
  const totals = useQuery({ queryKey: ["totals", date], queryFn: () => api.totals(date) });
  const month = useQuery({
    queryKey: ["summary", period?.start, period?.end],
    queryFn: () => api.periodSummary(period!.start, period!.end),
    enabled: !!period,
  });
  const budget = useBudget(period?.month).data;
  const debts = useQuery({ queryKey: ["debtSummary"], queryFn: api.debtSummary }).data;
  const recent = useQuery({ queryKey: ["transactions", "recent"], queryFn: () => api.listTransactions({ limit: 8 }) });
  const accounts = useAccounts().data ?? [];
  const { openTxnForm, showTransactions, go } = useUi();
  const monthName = period ? monthTitle(period.month).toLowerCase() : "";
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
          {debts && (debts.owedToMe !== 0 || debts.iOwe !== 0) && (
            <div className="hint" data-testid="home-net-worth">
              Чистые активы с долгами: <Money amount={debts.netWorth} symbol={symbol} />
            </div>
          )}
        </div>
        <div className="card tile" data-testid="month-income">
          <div className="tile-label">Доходы, {monthName}</div>
          <div className="tile-value plus">{month.data && <Money amount={month.data.income} symbol={symbol} />}</div>
          {month.data?.savingsRate != null && (
            <div className="hint" data-testid="home-savings-rate">
              Норма сбережений {month.data.savingsRate} %
            </div>
          )}
        </div>
        <div className="card tile" data-testid="month-expense">
          <div className="tile-label">Расходы, {monthName}</div>
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
      <div className="columns home-bottom">
      <div className="card clickable" data-testid="home-budget" onClick={() => go("budget")}>
        <h2>Бюджет, {monthName}</h2>
        {budget && !budget.id && <p className="muted">Бюджета на этот месяц нет. Нажмите, чтобы составить.</p>}
        {budget?.id && (
          <>
            <p>
              Можно тратить сегодня:{" "}
              <b data-testid="home-safe-to-spend">
                {budget.safeToSpendToday != null ? <Money amount={Math.max(budget.safeToSpendToday, 0)} symbol={budget.currencySymbol} /> : "—"}
              </b>
            </p>
            <ul className="budget-brief">
              {budget.lines
                .filter((l) => l.kind === "expense" && !l.parentId)
                .sort((a, b) => b.percent - a.percent)
                .slice(0, 5)
                .map((l) => (
                  <li key={l.categoryId} className={l.over ? "over" : undefined}>
                    <span>{l.categoryName}</span>
                    <div className={l.over ? "bar over" : "bar"}>
                      <span style={{ width: `${Math.min(l.percent, 100)}%` }} />
                    </div>
                    <span className="percent">{l.percent} %</span>
                  </li>
                ))}
            </ul>
          </>
        )}
      </div>
      <div className="card clickable" data-testid="home-upcoming" onClick={() => go("debts")}>
        <h2>Ближайшие платежи по долгам</h2>
        {debts && debts.upcoming.length === 0 && <p className="muted">Платежей нет.</p>}
        <ul className="account-list">
          {debts?.upcoming.slice(0, 4).map((u) => (
            <li key={u.scheduleId} className={u.overdue ? "over" : undefined}>
              <span>
                {formatDate(u.dueDate)} · {u.counterparty}
              </span>
              <Money amount={u.payment} symbol={u.currencySymbol} minorUnits={u.minorUnits} />
            </li>
          ))}
        </ul>
      </div>
      </div>
    </section>
  );
}
