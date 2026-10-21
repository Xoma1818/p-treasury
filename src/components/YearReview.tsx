import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { formatDate, monthTitle } from "../lib/dates";
import { change, Delta, plural, Ring } from "./Dashboard";
import { Hint } from "./Hint";
import { BaseMoney } from "./Money";
import { MonthsChart } from "../screens/Reports";

/** «Итоги года»: главное о годе в нескольких карточках. */
export function YearReviewReport() {
  const now = new Date().getFullYear();
  const [year, setYear] = useState(now);
  const q = useQuery({ queryKey: ["yearReview", year], queryFn: () => api.yearReview(year) });
  const r = q.data;
  const saved = r ? r.income - r.expense : 0;
  // Средние — по месяцам, где были операции (год мог начаться с середины).
  const active = Math.max(1, r?.months.filter((m) => m.income !== 0 || m.expense !== 0).length ?? 1);
  return (
    <div className="card" data-testid="year-review">
      <div className="screen-head">
        <div className="year-head">
          <button className="icon-btn" aria-label="Прошлый год" onClick={() => setYear(year - 1)}>
            ‹
          </button>
          <h2 data-testid="year-title">Итоги {year} года</h2>
          <button className="icon-btn" aria-label="Следующий год" onClick={() => setYear(year + 1)} disabled={year >= now}>
            ›
          </button>
          <Hint title="Итоги года" example="«Лучший месяц — май: осталось 42 000 ₽»">
            Год в нескольких цифрах: сколько заработали, потратили и отложили, лучший и самый дорогой месяц, крупнейшая покупка и любимый магазин. Текущий год считается по сегодня и сравнивается с тем же отрезком прошлого.
          </Hint>
        </div>
      </div>
      {q.error && <p className="error">{String(q.error)}</p>}
      {r && r.transactionCount === 0 && <p className="muted">За {year} год операций нет.</p>}
      {r && r.transactionCount > 0 && (
        <>
          <div className="year-hero">
            <div className="card tile">
              <div className="tile-label">
                Заработали
                <Delta pct={r.prevIncome ? change(r.income, r.prevIncome) : null} hint="к тому же времени прошлого года" />
              </div>
              <span className="year-big" data-testid="year-income">
                <BaseMoney amount={r.income} />
              </span>
              <div className="hint">
                в среднем <BaseMoney amount={Math.round(r.income / active)} /> в месяц
              </div>
            </div>
            <div className="card tile">
              <div className="tile-label">
                Потратили
                <Delta pct={r.prevExpense ? change(r.expense, r.prevExpense) : null} hint="к тому же времени прошлого года" lowerIsBetter />
              </div>
              <span className="year-big" data-testid="year-expense">
                <BaseMoney amount={r.expense} />
              </span>
              <div className="hint">
                в среднем <BaseMoney amount={Math.round(r.expense / active)} /> в месяц, <BaseMoney amount={Math.round(r.expense / r.days)} /> в день
              </div>
            </div>
            <div className="card tile summary-ring">
              <Ring percent={Math.max(0, r.savingsRate ?? 0)} size={104} label={`Отложено ${r.savingsRate ?? 0} % доходов`}>
                <b>{r.savingsRate ?? 0} %</b>
                <span>отложено</span>
              </Ring>
              <span className="muted">
                <BaseMoney amount={saved} signed />
              </span>
            </div>
          </div>
          {r.months.length > 1 && <MonthsChart r={{ months: r.months, income: r.income, expense: r.expense, balance: saved, savingsRate: r.savingsRate, missingRates: r.missingRates, baseCurrency: r.baseCurrency }} />}
          <div className="year-facts">
            {r.bestMonth && (
              <Fact eyebrow="Лучший месяц" title={monthTitle(r.bestMonth)}>
                осталось <BaseMoney amount={r.months.find((m) => m.period.month === r.bestMonth)?.balance ?? 0} />
              </Fact>
            )}
            {r.costliestMonth && (
              <Fact eyebrow="Самый дорогой месяц" title={monthTitle(r.costliestMonth)}>
                потрачено <BaseMoney amount={r.months.find((m) => m.period.month === r.costliestMonth)?.expense ?? 0} />
              </Fact>
            )}
            {r.topCategories[0] && (
              <Fact eyebrow="Больше всего ушло на" title={r.topCategories[0].name}>
                <BaseMoney amount={r.topCategories[0].amount} /> · {r.topCategories[0].percent} % расходов
                {r.topCategories.length > 1 && <> · затем {r.topCategories.slice(1, 3).map((c) => c.name).join(", ")}</>}
              </Fact>
            )}
            {r.biggestPurchase && (
              <Fact eyebrow="Самая крупная покупка" title={r.biggestPurchase.payee ?? r.biggestPurchase.categoryName ?? "Без названия"}>
                <BaseMoney amount={r.biggestPurchase.amount} /> · {formatDate(r.biggestPurchase.date)}
              </Fact>
            )}
            {r.topPayee && (
              <Fact eyebrow="Чаще всего платили" title={r.topPayee.name}>
                {r.topPayee.count} {plural(r.topPayee.count, "раз", "раза", "раз")} · <BaseMoney amount={r.topPayee.amount} />
              </Fact>
            )}
            <Fact eyebrow="Дни без трат" title={`${r.noSpendDays} ${plural(r.noSpendDays, "день", "дня", "дней")}`}>
              из {r.days} {plural(r.days, "дня", "дней", "дней")} учёта · {r.days ? Math.round((r.noSpendDays / r.days) * 100) : 0} %
            </Fact>
          </div>
          {r.missingRates.length > 0 && <p className="hint warn">Нет курса для {r.missingRates.join(", ")}: такие операции не вошли.</p>}
        </>
      )}
    </div>
  );
}

function Fact({ eyebrow, title, children }: { eyebrow: string; title: string; children: React.ReactNode }) {
  return (
    <div className="year-fact fade-up" data-testid="year-fact">
      <span className="eyebrow">{eyebrow}</span>
      <b>{title}</b>
      <span>{children}</span>
    </div>
  );
}
