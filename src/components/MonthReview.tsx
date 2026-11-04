import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { formatDate, monthGenitive, monthTitle } from "../lib/dates";
import { useCurrencies } from "../lib/queries";
import { useUi } from "../lib/store";
import { useAction } from "../lib/useAction";
import { ErrorText, Modal } from "./Modal";
import { Money } from "./Money";

/** 0.29: «Итоги месяца» — что получилось, прогноз против факта, что осталось
 *  проверить, и отметка «Месяц завершён». */
export function MonthReviewDialog({ month, onClose }: { month: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ["monthReview", month], queryFn: () => api.monthReview(month) });
  const currencies = useCurrencies().data ?? [];
  const { showTransactions, go } = useUi();
  const [note, setNote] = useState<string | null>(null);
  const close = useAction(() => api.closeMonth(month, (note ?? r?.note ?? "").trim() || null));
  const reopen = useAction(() => api.reopenMonth(month));
  const r = q.data;
  const cur = currencies.find((c) => c.code === r?.baseCurrency);
  const m = (v: number, signed?: boolean) => <Money amount={v} symbol={cur?.symbol ?? "₽"} minorUnits={cur?.minorUnits ?? 2} signed={signed} />;

  return (
    <Modal title={`Итоги: ${monthTitle(`${month}-01`).toLowerCase()}`} onClose={onClose} wide>
      {!r ? (
        <p className="hint">{q.error ? String(q.error) : "Загрузка…"}</p>
      ) : (
        <div className="month-review" data-testid="month-review">
          <p className="sub">
            {formatDate(r.start)} – {formatDate(r.end)}
            {r.closedAt && <> · месяц завершён {formatDate(r.closedAt.slice(0, 10))}</>}
          </p>
          <table className="explain">
            <tbody>
              <tr>
                <td>Доходы</td>
                <td className="num" data-testid="review-income">{m(r.income)}</td>
              </tr>
              <tr>
                <td>Расходы{r.refunds > 0 && <span className="muted"> (с учётом возвратов {m(r.refunds)})</span>}</td>
                <td className="num" data-testid="review-expense">{m(r.expense)}</td>
              </tr>
              <tr className="total">
                <td>{r.saved >= 0 ? "Отложено" : "Потрачено больше, чем пришло"}</td>
                <td className="num" data-testid="review-saved">
                  {m(r.saved, true)}
                  {r.savingsRate !== null && <span className="muted"> · {r.savingsRate} %</span>}
                </td>
              </tr>
            </tbody>
          </table>

          <h3>Прогноз и факт</h3>
          {r.forecast ? (
            <table className="explain" data-testid="review-forecast">
              <thead>
                <tr>
                  <th />
                  <th className="num">Прогноз</th>
                  <th className="num">Факт</th>
                  <th className="num">Разница</th>
                </tr>
              </thead>
              <tbody>
                <tr data-kind="income">
                  <td>Доходы</td>
                  <td className="num">{m(r.forecast.income)}</td>
                  <td className="num">{m(r.income)}</td>
                  <td className="num">{m(r.forecast.incomeDiff, true)}</td>
                </tr>
                <tr data-kind="expense">
                  <td>Расходы</td>
                  <td className="num">{m(r.forecast.expense)}</td>
                  <td className="num">{m(r.expense)}</td>
                  <td className="num">{m(r.forecast.expenseDiff, true)}</td>
                </tr>
              </tbody>
            </table>
          ) : (
            <p className="hint">Прогноз на этот месяц не запоминался: он появится для следующих месяцев сам.</p>
          )}
          {r.forecast && (
            <p className="hint" data-testid="review-forecast-verdict">
              {verdict(r.forecast.expenseDiff, r.forecast.expense)}
              {r.forecast.partial && " Прогноз запомнен, когда месяц уже шёл, поэтому часть суммы — уже случившееся."}
            </p>
          )}

          {r.over.length > 0 && (
            <>
              <h3>Больше лимита</h3>
              <ul className="plain" data-testid="review-over">
                {r.over.map((l) => (
                  <li key={l.categoryId}>
                    <button className="link" onClick={() => (onClose(), showTransactions({ categoryId: l.categoryId, dateFrom: r.start, dateTo: r.end }))}>
                      {l.categoryName}
                    </button>{" "}
                    — {m(l.actual)} при лимите {m(l.limit)}, на {m(l.actual - l.limit)} больше
                  </li>
                ))}
              </ul>
            </>
          )}

          {(r.openMatches > 0 || r.plannedLeft > 0 || r.missingRates.length > 0 || !r.hasBudget) && (
            <>
              <h3>Перед завершением</h3>
              <ul className="plain" data-testid="review-todo">
                {r.openMatches > 0 && (
                  <li>
                    Совпадения выписки ждут ответа: {r.openMatches}.{" "}
                    <button className="link" onClick={() => (onClose(), go("home"))}>
                      Проверить
                    </button>
                  </li>
                )}
                {r.plannedLeft > 0 && <li>Запланированные операции этого месяца, которые так и не случились: {r.plannedLeft}.</li>}
                {r.missingRates.length > 0 && <li>Нет курса для {r.missingRates.join(", ")}: такие операции в итоги не вошли.</li>}
                {!r.hasBudget && <li>Бюджета на этот месяц не было: лимиты сравнить не с чем.</li>}
              </ul>
            </>
          )}

          {r.ended && !r.closedAt && (
            <label className="field">
              Заметка о месяце
              <input name="reviewNote" value={note ?? r.note ?? ""} onChange={(e) => setNote(e.target.value)} placeholder="Например, отпуск, ремонт" />
            </label>
          )}
          {r.closedAt && r.note && <p className="sub">Заметка: {r.note}</p>}
          <ErrorText error={close.error ?? reopen.error} />
          <div className="actions">
            {r.closedAt && (
              <button type="button" className="btn" onClick={() => reopen.run()} disabled={reopen.busy}>
                Открыть снова
              </button>
            )}
            <span className="spacer" />
            <button type="button" className="btn" onClick={onClose}>
              Закрыть
            </button>
            {r.ended && !r.closedAt && (
              <button type="button" className="btn primary" data-testid="review-close" onClick={() => close.run()} disabled={close.busy} aria-busy={close.busy}>
                Месяц завершён
              </button>
            )}
          </div>
          {!r.ended && <p className="hint">Месяц ещё идёт: завершить его можно после {formatDate(r.end)}. Итоги {monthGenitive(month)} уже можно смотреть.</p>}
        </div>
      )}
    </Modal>
  );
}

/** Одна фраза о расходах против прогноза. */
function verdict(diff: number, planned: number): string {
  if (planned === 0) return "Прогноза расходов не было.";
  const pct = Math.round((Math.abs(diff) / planned) * 100);
  if (pct <= 5) return "Расходы почти совпали с прогнозом.";
  return diff > 0 ? `Потратили на ${pct} % больше прогноза.` : `Потратили на ${pct} % меньше прогноза.`;
}

/** Карточка на Главной в первые дни нового месяца: «Подвести итоги октября». */
export function MonthReviewBanner() {
  const q = useQuery({ queryKey: ["suggestedMonthReview"], queryFn: api.suggestedMonthReview });
  const [open, setOpen] = useState(false);
  const month = q.data;
  if (!month) return null;
  return (
    <>
      <div className="card banner" data-testid="month-review-banner">
        <span>Месяц закончился: посмотрите, сколько отложено и как сработал прогноз.</span>
        <button className="btn primary" onClick={() => setOpen(true)}>
          Итоги {monthGenitive(month)}
        </button>
      </div>
      {open && <MonthReviewDialog month={month} onClose={() => setOpen(false)} />}
    </>
  );
}
