import { useQuery } from "@tanstack/react-query";
import { BaseMoney as M, Money } from "../components/Money";
import { api, type Period } from "../lib/api";
import { formatDate } from "../lib/dates";
import { formatRate } from "../lib/rates";
import { useUi } from "../lib/store";

/** Отчёты → «Курсовая разница»: сколько стоимость валютных счетов изменилась из-за курса. */
export function FxGain({ period }: { period: Period }) {
  const report = useQuery({ queryKey: ["reportFx", period.start, period.end], queryFn: () => api.reportFx(period.start, period.end) });
  const showTransactions = useUi((u) => u.showTransactions);
  const r = report.data;
  return (
    <div className="card" data-testid="fx-report">
      <h2>Курсовая разница</h2>
      <p className="muted">
        Насколько изменилась стоимость валютных счетов в основной валюте из-за курса, без учёта пополнений и трат. Средний курс покупки
        считается по переводам из основной валюты за период.
      </p>
      {report.error && <p className="error">{String(report.error)}</p>}
      {r && r.rows.length === 0 && <p className="muted">Счетов в других валютах нет.</p>}
      {r && r.rows.length > 0 && (
        <>
          <table className="table fx-table" data-testid="fx-table">
            <thead>
              <tr>
                <th>Счёт</th>
                <th className="num">Остаток</th>
                <th className="num">Курс {formatDate(period.start)} → {formatDate(period.end)}</th>
                <th className="num">Средний курс покупки</th>
                <th className="num">Курсовая разница</th>
              </tr>
            </thead>
            <tbody>
              {r.rows.map((a) => (
                <tr
                  key={a.accountId}
                  className="clickable"
                  data-testid="fx-row"
                  data-account={a.name}
                  title="Показать операции счёта за период"
                  onClick={() => showTransactions({ accountId: a.accountId, dateFrom: period.start, dateTo: period.end })}
                >
                  <td className="main">{a.name}</td>
                  <td className="num">
                    <Money amount={a.endBalance} symbol={a.currencySymbol} minorUnits={a.minorUnits} />
                  </td>
                  <td className="num">
                    {formatRate(a.startRate)} → {formatRate(a.endRate)}
                  </td>
                  <td className="num">
                    {a.avgBuyRate ? (
                      <>
                        {formatRate(a.avgBuyRate)}
                        <div className="sub">
                          куплено <Money amount={a.bought} symbol={a.currencySymbol} minorUnits={a.minorUnits} />
                        </div>
                      </>
                    ) : (
                      <span className="muted">покупок не было</span>
                    )}
                  </td>
                  <td className={a.gain != null && a.gain < 0 ? "num over" : "num plus"} data-testid="fx-gain">
                    {a.gain == null ? <span className="muted">нет курса</span> : <M amount={a.gain} signed />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="table-foot" data-testid="fx-total">
            Итого за период: <M amount={r.totalGain} signed />
          </div>
          {r.missingRates.length > 0 && (
            <p className="hint warn">Нет курса для {r.missingRates.join(", ")} на начало или конец периода: курс загружается в Настройках.</p>
          )}
        </>
      )}
    </div>
  );
}
