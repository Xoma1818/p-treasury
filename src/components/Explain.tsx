import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAccounts, useCurrencies, useSettings } from "../lib/queries";
import { formatRate, rateSource } from "../lib/rates";
import { useUi } from "../lib/store";
import { Modal } from "./Modal";
import { BaseMoney, Money } from "./Money";
import { addDays, formatDate, today } from "../lib/dates";

export type ExplainKind = "balance" | "income" | "expense" | "saldo" | "free";

const TITLE: Record<ExplainKind, string> = {
  balance: "Как посчитан общий баланс",
  income: "Из чего сложились доходы",
  expense: "Из чего сложились расходы",
  saldo: "Как посчитано сальдо месяца",
  free: "Как посчитан свободный остаток",
};

/** «Как посчитано»: составляющие итога Главной и что в него не вошло. */
export function ExplainDialog({ kind, on, from, to, onClose }: { kind: ExplainKind; on: string; from: string; to: string; onClose: () => void }) {
  return (
    <Modal title={TITLE[kind]} onClose={onClose} wide>
      <div data-testid="explain" data-kind={kind}>
        {kind === "free" ? <FreeParts /> : kind === "balance" ? <BalanceParts on={on} onClose={onClose} /> : kind === "saldo" ? <Saldo from={from} to={to} onClose={onClose} /> : <PeriodParts kind={kind} from={from} to={to} onClose={onClose} />}
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

/** Какими курсами пересчитано: «1 $ = 90,50 ₽ (ЦБ РФ, с 05.11.2026)». */
function RatesUsed({ codes, on, lead }: { codes: string[]; on: string; lead: string }) {
  const overview = useQuery({ queryKey: ["ratesOverview", on], queryFn: () => api.ratesOverview(on), enabled: codes.length > 0 }).data;
  const currencies = useCurrencies().data ?? [];
  if (codes.length === 0 || !overview) return null;
  const sym = (code: string) => currencies.find((c) => c.code === code)?.symbol ?? code;
  const parts = codes
    .map((code) => overview.rates.find((r) => r.code === code))
    .filter((r): r is NonNullable<typeof r> => !!r?.rate && !!r.date)
    .map((r) => `1 ${sym(r.code)} = ${formatRate(r.rate)} ${sym(overview.base)} (${rateSource(r.source ?? "")}, с ${formatDate(r.date!)})`);
  if (parts.length === 0) return null;
  return (
    <p className="hint" data-testid="explain-rates">
      {lead} {parts.join("; ")}.
    </p>
  );
}

function BalanceParts({ on, onClose }: { on: string; onClose: () => void }) {
  const data = useQuery({ queryKey: ["explainBalance", on], queryFn: () => api.explainBalance(on) }).data;
  const showTransactions = useUi((s) => s.showTransactions);
  if (!data) return null;
  const why = { in: "", excluded: "не учитывается в общем балансе (настройка счёта)", no_rate: "нет курса валюты — не вошёл" };
  return (
    <>
      <p className="muted">Сумма остатков всех счетов на сегодня в основной валюте по курсу на эту дату. Брокерские счета — по последней оценке.</p>
      <table className="table explain-table">
        <tbody>
          {data.accounts.map((a) => (
            <tr key={a.id} className={a.status === "in" ? undefined : "dup"} data-testid="explain-row" data-status={a.status}>
              <td>
                <button className="link" onClick={() => (showTransactions({ accountId: a.id }), onClose())}>
                  {a.name}
                </button>
                {a.status !== "in" && <div className="hint">{why[a.status]}</div>}
              </td>
              <td className="num">{a.currency !== data.baseCurrency && <BaseMoney amount={a.balance} currencyCode={a.currency} />}</td>
              <td className="num">{a.converted !== null ? <BaseMoney amount={a.converted} currencyCode={data.baseCurrency} /> : "—"}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th>Итого</th>
            <th />
            <th className="num" data-testid="explain-total">
              <BaseMoney amount={data.total} currencyCode={data.baseCurrency} />
            </th>
          </tr>
        </tfoot>
      </table>
      <RatesUsed codes={[...new Set(data.accounts.filter((a) => a.status !== "excluded" && a.currency !== data.baseCurrency).map((a) => a.currency))].sort()} on={on} lead={`Курсы на ${formatDate(on)}:`} />
    </>
  );
}

function PeriodParts({ kind, from, to, onClose }: { kind: "income" | "expense"; from: string; to: string; onClose: () => void }) {
  const data = useQuery({ queryKey: ["explainPeriod", from, to, kind], queryFn: () => api.explainPeriod(from, to, kind) }).data;
  const showTransactions = useUi((s) => s.showTransactions);
  const outside = (useAccounts().data ?? []).filter((a) => !a.includeInTotal).map((a) => `«${a.name}»`);
  const startDay = useSettings().data?.month_start_day ?? "1";
  if (!data) return null;
  const openRelated = (categoryId?: string) => {
    showTransactions({ dateFrom: from, dateTo: to, types: [kind], counted: true, categoryId });
    onClose();
  };
  const notes: string[] = [];
  if (startDay !== "1") notes.push(`Месяц считается с ${startDay}-го числа (Настройки → «Бюджет и валюта» → «Начало бюджетного месяца»).`);
  if (outside.length > 0) notes.push(`Счета вне общего баланса (${outside.join(", ")}) здесь учтены: их ${kind === "income" ? "доходы" : "расходы"} тоже ваши.`);
  if (data.spreadParts > 0) notes.push(`В итог вошли части трат «по месяцам» (${data.spreadParts}). В «Операциях» видны исходные суммы и даты, поэтому список может отличаться.`);
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
                {c.categoryId ? (
                  <button type="button" className="link" title="Открыть операции категории и её подкатегорий" onClick={() => openRelated(c.categoryId)}>
                    {c.name}
                  </button>
                ) : c.name || "Без категории"}
              </td>
              <td className="num muted">{c.count}</td>
              <td className="num">
                <BaseMoney amount={c.amount} currencyCode={data.baseCurrency} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th>Итого</th>
            <th />
            <th className="num" data-testid="explain-total">
              <BaseMoney amount={data.total} currencyCode={data.baseCurrency} />
            </th>
          </tr>
        </tfoot>
      </table>
      <button type="button" className="btn" onClick={() => openRelated()}>
        {kind === "income" ? "Открыть доходы за период" : "Открыть расходы и возвраты за период"}
      </button>
      {notes.length > 0 && (
        <ul className="explain-notes" data-testid="explain-notes">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <RatesUsed codes={data.currencies} on={to < today() ? to : today()} lead={`Операции в ${data.currencies.join(", ")} пересчитаны по курсу своего дня. Последний курс:`} />
    </>
  );
}

function Saldo({ from, to, onClose }: { from: string; to: string; onClose: () => void }) {
  const inc = useQuery({ queryKey: ["explainPeriod", from, to, "income"], queryFn: () => api.explainPeriod(from, to, "income") }).data;
  const exp = useQuery({ queryKey: ["explainPeriod", from, to, "expense"], queryFn: () => api.explainPeriod(from, to, "expense") }).data;
  const showTransactions = useUi((s) => s.showTransactions);
  if (!inc || !exp) return null;
  return (
    <>
      <p className="muted">Сальдо — доходы минус расходы за месяц. Переводы между своими счетами и корректировки баланса в него не входят.</p>
      <table className="table explain-table">
        <tbody>
          <tr data-testid="explain-row">
            <td>
              <button className="link" onClick={() => (showTransactions({ dateFrom: from, dateTo: to, types: ["income"], counted: true }), onClose())}>
                Доходы
              </button>
            </td>
            <td className="num">
              <BaseMoney amount={inc.total} currencyCode={inc.baseCurrency} signed />
            </td>
          </tr>
          <tr data-testid="explain-row">
            <td>
              <button className="link" title="Открыть расходы и возвраты за период" onClick={() => (showTransactions({ dateFrom: from, dateTo: to, types: ["expense"], counted: true }), onClose())}>
                Расходы
              </button>
            </td>
            <td className="num">
              <BaseMoney amount={-exp.total} currencyCode={inc.baseCurrency} />
            </td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <th>Сальдо</th>
            <th className="num" data-testid="explain-total">
              <BaseMoney amount={inc.total - exp.total} currencyCode={inc.baseCurrency} signed />
            </th>
          </tr>
        </tfoot>
      </table>
    </>
  );
}

function FreeParts() {
  const data = useQuery({ queryKey: ["freeUntilIncome", today()], queryFn: api.freeUntilIncome }).data;
  const currency = useCurrencies().data?.find((c) => c.code === data?.baseCurrency);
  if (!data) return null;
  if (!currency) return <p className="muted">Загружаем данные валюты…</p>;
  const money = { symbol: currency.symbol, currencyCode: data.baseCurrency, minorUnits: currency.minorUnits };
  const end = addDays(data.until, -1);
  return (
    <>
      <p className="muted">
        {data.income ? `Ближайший доход «${data.income.title}» ожидается ${formatDate(data.until)}.` : "Ближайшего дохода в планах на два месяца нет. Расчёт заканчивается в последний день бюджетного месяца."}{" "}
        С {formatDate(data.today)} по {formatDate(end)} включительно к деньгам на счетах прогноза прибавлены ожидаемые поступления и вычтены платежи и резервы.
      </p>
      <table className="table explain-table">
        <tbody>
          <tr data-testid="explain-row">
            <td>Деньги сегодня</td>
            <td className="num">
              <Money amount={data.liquid} {...money} />
            </td>
          </tr>
          {data.payments.map((p, i) => (
            <tr key={`p${i}`} data-testid="explain-row" data-kind="payment">
              <td>
                {p.title} <span className="muted">{formatDate(p.date)}</span>
              </td>
              <td className="num">
                <Money amount={-p.amount} {...money} />
              </td>
            </tr>
          ))}
          {data.inflowTotal > 0 && (
            <tr data-testid="explain-row">
              <td>Ожидаемые поступления за период</td>
              <td className="num">
                <Money amount={data.inflowTotal} {...money} signed />
              </td>
            </tr>
          )}
          {data.reserves.map((r) => (
            <tr key={r.goalId} data-testid="explain-row" data-kind="reserve">
              <td>
                Резерв «{r.name}» <span className="muted">на «{r.account}»</span>
              </td>
              <td className="num">
                <Money amount={-r.amount} {...money} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th>Свободно</th>
            <th className="num" data-testid="explain-total">
              <Money amount={data.free} {...money} />
            </th>
          </tr>
          <tr>
            <td className="muted">
              В среднем на день за период ({data.days} дн.)
            </td>
            <td className="num">
              <Money amount={data.perDay} {...money} />
            </td>
          </tr>
        </tfoot>
      </table>
      {data.missingRates.length > 0 && <p className="hint warn">Расчёт включает только суммы, для которых есть курс. Отсутствует курс для {data.missingRates.join(", ")}.</p>}
    </>
  );
}
