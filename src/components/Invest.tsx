import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, INVEST_KINDS, type InvestAccount, type InvestMonth, type InvestOverview, type InvestPlanMode } from "../lib/api";
import { formatDate, monthTitle, today } from "../lib/dates";
import { leftToSave, projectGrowth, tenthsText } from "../lib/invest";
import { parseAmount } from "../lib/money";
import { useAccounts } from "../lib/queries";
import { useUi } from "../lib/store";
import { useAction } from "../lib/useAction";
import { AmountInput, amountText, Field } from "./Fields";
import { ErrorText, Modal } from "./Modal";
import { Money } from "./Money";

const useOverview = () => useQuery({ queryKey: ["investOverview"], queryFn: api.investOverview }).data;

/** «Отложено 15 000 из 20 000 ₽» с полоской; без плана — только сумма. */
function MonthLine({ m, symbol, onPlan }: { m: InvestMonth; symbol: string; onPlan: () => void }) {
  const percent = m.percent ?? 0;
  return (
    <div className="invest-month" data-testid="invest-month">
      <div>
        Отложено <b data-testid="invest-saved"><Money amount={m.saved} symbol={symbol} /></b>
        {m.planned != null ? (
          <>
            {" "}из <Money amount={m.planned} symbol={symbol} />
            {m.plan.mode === "percent" && <span className="hint"> ({m.plan.value} % доходов)</span>}
          </>
        ) : null}{" "}
        <button className="link" onClick={onPlan} data-testid="invest-plan-edit">
          {m.planned != null ? "Изменить план" : "Задать план на месяц"}
        </button>
      </div>
      {m.planned != null && (
        <div className="invest-bar">
          <div className={percent >= 100 ? "bar goal reached" : "bar goal"} title={`${percent} % плана`}>
            <span style={{ width: `${Math.min(percent, 100)}%` }} />
          </div>
          <span className="percent" data-testid="invest-percent">
            {percent} %
          </span>
        </div>
      )}
    </div>
  );
}

/** Вложено · стоит · результат. */
function Totals({ o }: { o: InvestOverview }) {
  const s = o.baseSymbol;
  return (
    <div className="invest-totals" data-testid="invest-totals">
      <div>
        <div className="tile-label">Вложено</div>
        <Money amount={o.invested} symbol={s} />
      </div>
      <div>
        <div className="tile-label">Стоит сейчас</div>
        <b data-testid="invest-value">
          <Money amount={o.value} symbol={s} />
        </b>
      </div>
      <div>
        <div className="tile-label">Результат</div>
        <span className={o.result >= 0 ? "plus" : "minus"} data-testid="invest-result">
          <Money amount={o.result} symbol={s} signed />
          {o.resultTenths != null && <> ({tenthsText(o.resultTenths, true)} %)</>}
        </span>
      </div>
    </div>
  );
}

function TaxLine({ o }: { o: InvestOverview }) {
  const t = o.tax;
  if (!t) return null;
  const month = Number(today().slice(5, 7));
  const percent = Math.min(100, Math.round((t.contributed / t.limit) * 100));
  return (
    <div className="hint invest-tax" data-testid="invest-tax">
      <div>
        ИИС и ПДС: внесено в {t.year} году <Money amount={t.contributed} /> из <Money amount={t.limit} /> → вычет до <b><Money amount={t.deduction} /></b>
      </div>
      <div className="bar goal">
        <span style={{ width: `${percent}%` }} />
      </div>
      {month >= 11 && t.left > 0 && (
        <div className="hint warn" data-testid="invest-tax-left">
          До 31 декабря можно внести ещё <Money amount={t.left} />, чтобы получить полный вычет.
        </div>
      )}
    </div>
  );
}

/** Главная → «Инвестиции»: план месяца, вложено и стоимость, лимит ИИС. */
export function InvestCard() {
  const o = useOverview();
  const go = useUi((s) => s.go);
  const openTxnForm = useUi((s) => s.openTxnForm);
  const [dialog, setDialog] = useState<"plan" | "value" | "calc" | null>(null);
  const accounts = useAccounts().data ?? [];
  // Откуда откладывать: карта, иначе любой счёт, кроме кредитки и брокерского.
  const from = accounts.find((a) => a.type === "debit") ?? accounts.find((a) => a.type !== "investment" && a.type !== "credit");
  if (!o) return null;
  const has = o.accounts.length > 0;
  const save = () =>
    openTxnForm({
      mode: "new",
      type: "transfer",
      prefill: { accountId: from?.id ?? null, toAccountId: o.accounts[0]?.id ?? null, amount: leftToSave(o.month.planned, o.month.saved) || null },
    });
  return (
    <div className="card invest-card" data-testid="home-invest">
      <div className="notes-head">
        <h2>Инвестиции, {monthTitle(o.month.month).toLowerCase()}</h2>
        <button className="link" onClick={() => setDialog("calc")} data-testid="invest-calc-open">
          Калькулятор
        </button>
      </div>
      {!has && o.month.planned == null ? (
        <p className="muted">
          Откладываете на инвестиции? Заведите брокерский счёт или ИИС в «Счетах», задайте план на месяц, и здесь будет видно, сколько отложено и сколько это стоит.{" "}
          <button className="link" onClick={() => go("accounts")}>
            Завести счёт
          </button>
        </p>
      ) : (
        <>
          <MonthLine m={o.month} symbol={o.baseSymbol} onPlan={() => setDialog("plan")} />
          {has && <Totals o={o} />}
          <TaxLine o={o} />
          {o.passiveIncome > 0 && (
            <div className="hint" data-testid="invest-passive">
              Дивиденды и купоны за год: <Money amount={o.passiveIncome} symbol={o.baseSymbol} />
            </div>
          )}
          {o.missingRates.length > 0 && <div className="hint warn">Нет курса для {o.missingRates.join(", ")}: такие суммы не вошли.</div>}
          <div className="btn-group">
            {has ? (
              <>
                <button className="btn primary small" onClick={save} data-testid="invest-save">
                  Отложить
                </button>
                <button className="btn small" onClick={() => setDialog("value")} data-testid="invest-value-open">
                  Обновить стоимость
                </button>
              </>
            ) : (
              <button className="btn small" onClick={() => go("accounts")}>
                Завести брокерский счёт
              </button>
            )}
          </div>
        </>
      )}
      {dialog === "plan" && <PlanForm m={o.month} onClose={() => setDialog(null)} />}
      {dialog === "value" && <ValueForm accounts={o.accounts} onClose={() => setDialog(null)} />}
      {dialog === "calc" && <Calculator o={o} onClose={() => setDialog(null)} />}
    </div>
  );
}

/** Бюджет → строка «Инвестиции» за выбранный месяц. */
export function InvestBudgetCard({ month }: { month: string }) {
  const m = useQuery({ queryKey: ["investMonth", month], queryFn: () => api.investMonth(month) }).data;
  const symbol = useOverview()?.baseSymbol ?? "₽";
  const [planning, setPlanning] = useState(false);
  if (!m) return null;
  return (
    <div className="card" data-testid="budget-invest">
      <h2>Инвестиции</h2>
      <p className="hint">Переводы на брокерский счёт или ИИС — не траты: они не уменьшают «Можно тратить», но видно, выполнен ли план.</p>
      <MonthLine m={m} symbol={symbol} onPlan={() => setPlanning(true)} />
      {planning && <PlanForm m={m} onClose={() => setPlanning(false)} />}
    </div>
  );
}

/** План на инвестиции; с `month` можно задать план только на этот месяц. */
export function PlanForm({ m, month, onClose }: { m: InvestMonth; month?: string; onClose: () => void }) {
  const [mode, setMode] = useState<InvestPlanMode>(m.plan.mode || "amount");
  const [amount, setAmount] = useState(m.plan.mode === "amount" ? amountText(m.plan.value) : "");
  const [percent, setPercent] = useState(m.plan.mode === "percent" ? String(m.plan.value) : "10");
  const [onlyMonth, setOnlyMonth] = useState(!!month && m.plan.onlyMonth);
  const save = useAction(api.setInvestPlan, onClose);
  const reset = useAction(api.clearInvestMonthPlan, onClose);
  const target = onlyMonth ? m.month : null;
  const submit = () => {
    if (mode === "amount") {
      const v = parseAmount(amount, 2);
      if (v === null || v <= 0) return save.setError("Введите сумму, например 20 000");
      return save.run("amount", v, target);
    }
    const p = Number(percent.replace(",", "."));
    if (!Number.isInteger(p) || p < 1 || p > 100) return save.setError("Процент — целое число от 1 до 100");
    save.run("percent", p, target);
  };
  return (
    <Modal title="План на инвестиции" onClose={onClose}>
      <form className="form" onSubmit={(e) => (e.preventDefault(), submit())}>
        <p className="muted">Сколько откладывать каждый месяц. Отложенным считаются переводы на брокерские счета, ИИС и ПДС.</p>
        <div className="tabs small" role="tablist">
          <button type="button" role="tab" className={mode === "amount" ? "tab active" : "tab"} onClick={() => setMode("amount")}>
            Сумма
          </button>
          <button type="button" role="tab" className={mode === "percent" ? "tab active" : "tab"} onClick={() => setMode("percent")} data-testid="invest-plan-percent">
            % от доходов
          </button>
        </div>
        {mode === "amount" ? (
          <Field label="Каждый месяц">{(id) => <AmountInput id={id} name="investPlanAmount" value={amount} onChange={setAmount} autoFocus />}</Field>
        ) : (
          <Field label="Процент от доходов месяца" hint={m.income > 0 ? <>В этом месяце доходы <Money amount={m.income} /></> : undefined}>
            {(id) => <input id={id} name="investPlanPercent" inputMode="numeric" value={percent} onChange={(e) => setPercent(e.target.value)} />}
          </Field>
        )}
        {month && (
          <label className="check">
            <input type="checkbox" name="investOnlyMonth" checked={onlyMonth} onChange={(e) => setOnlyMonth(e.target.checked)} />
            Только на {monthTitle(m.month).toLowerCase()} (например, премия — отложить больше), остальные месяцы по общему плану
          </label>
        )}
        <ErrorText error={save.error ?? reset.error} />
        <div className="actions">
          {m.plan.onlyMonth ? (
            <button type="button" className="btn" onClick={() => reset.run(m.month)}>
              Вернуть общий план
            </button>
          ) : (
            m.plan.mode && (
              <button type="button" className="btn" onClick={() => save.run("", 0, target)}>
                {onlyMonth ? "Не откладывать в этом месяце" : "Убрать план"}
              </button>
            )
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn primary" aria-busy={save.busy} disabled={save.busy}>
            Сохранить
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Ввод стоимости счёта из приложения брокера и история оценок. */
export function ValueForm({ accounts, accountId, onClose }: { accounts: InvestAccount[]; accountId?: string; onClose: () => void }) {
  const [id, setId] = useState(accountId ?? accounts[0]?.id ?? "");
  const a = accounts.find((x) => x.id === id);
  const [value, setValue] = useState(a ? amountText(a.value, a.minorUnits) : "");
  const [date, setDate] = useState(today());
  const save = useAction(api.setInvestValue, onClose);
  const remove = useAction(api.deleteInvestValue);
  if (!a) return null;
  const parsed = parseAmount(value, a.minorUnits);
  const pick = (next: string) => {
    setId(next);
    const n = accounts.find((x) => x.id === next);
    if (n) setValue(amountText(n.value, n.minorUnits));
  };
  return (
    <Modal title={`Стоимость: ${a.name}`} onClose={onClose}>
      <form className="form" onSubmit={(e) => (e.preventDefault(), parsed !== null && save.run(a.id, date, parsed))}>
        <p className="muted">
          Введите, сколько сейчас стоит портфель, из приложения брокера. Вложено <Money amount={a.invested} symbol={a.currencySymbol} minorUnits={a.minorUnits} />; разница — результат инвестиций, он не попадает в доходы и расходы.
        </p>
        {accounts.length > 1 && (
          <Field label="Счёт">
            {(fid) => (
              <select id={fid} name="investAccount" value={id} onChange={(e) => pick(e.target.value)}>
                {accounts.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        <div className="row">
          <Field label="Стоит">{(fid) => <AmountInput id={fid} name="investValue" value={value} onChange={setValue} minorUnits={a.minorUnits} autoFocus />}</Field>
          <Field label="На дату">{(fid) => <input id={fid} name="investDate" type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
        </div>
        {parsed !== null && (
          <p data-testid="invest-value-preview">
            Результат: <Money amount={parsed - a.invested} symbol={a.currencySymbol} minorUnits={a.minorUnits} signed />
          </p>
        )}
        {a.history.length > 0 && (
          <table className="table compact" data-testid="invest-history">
            <tbody>
              {a.history.slice(0, 12).map((h) => (
                <tr key={h.date}>
                  <td>{formatDate(h.date)}</td>
                  <td className="num">
                    <Money amount={h.value} symbol={a.currencySymbol} minorUnits={a.minorUnits} />
                  </td>
                  <td className="row-actions">
                    <button type="button" className="link" onClick={() => remove.run(a.id, h.date)}>
                      Удалить
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <ErrorText error={save.error ?? remove.error} />
        <div className="actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn primary" aria-busy={save.busy} disabled={save.busy || parsed === null}>
            Сохранить
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** «Что будет через N лет»: взнос в месяц, доходность, срок, вычет ИИС. */
function Calculator({ o, onClose }: { o: InvestOverview; onClose: () => void }) {
  const [start, setStart] = useState(amountText(Math.max(o.value, 0) || null));
  const [monthly, setMonthly] = useState(amountText(o.month.planned ?? 1_000_000));
  const [rate, setRate] = useState("12");
  const [years, setYears] = useState("10");
  const [iis, setIis] = useState(o.tax != null);
  const rows = projectGrowth({
    start: parseAmount(start, 2) ?? 0,
    monthly: parseAmount(monthly, 2) ?? 0,
    ratePct: Number(rate.replace(",", ".")) || 0,
    years: Math.round(Number(years) || 0),
    iis,
  });
  const last = rows[rows.length - 1];
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <Modal title="Калькулятор инвестиций" onClose={onClose} wide>
      <div className="form">
        <div className="row">
          <Field label="Уже вложено">{(id) => <AmountInput id={id} name="calcStart" value={start} onChange={setStart} />}</Field>
          <Field label="Взнос в месяц">{(id) => <AmountInput id={id} name="calcMonthly" value={monthly} onChange={setMonthly} />}</Field>
        </div>
        <div className="row">
          <Field label="Доходность в год, %" hint="Ваше допущение: приложение ничего не советует">
            {(id) => <input id={id} name="calcRate" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />}
          </Field>
          <Field label="Срок, лет">{(id) => <input id={id} name="calcYears" inputMode="numeric" value={years} onChange={(e) => setYears(e.target.value)} />}</Field>
        </div>
        <label className="check">
          <input type="checkbox" name="calcIis" checked={iis} onChange={(e) => setIis(e.target.checked)} />
          ИИС: вычет 13 % (до 52 000 ₽ в год) докладывать на счёт
        </label>
        {last && (
          <p className="invest-calc-result" data-testid="invest-calc-result">
            Через {last.year} {yearsWord(last.year)}: <b><Money amount={last.value} /></b>, из них вложено <Money amount={last.invested} />
            {last.deductions > 0 && <>, вычеты <Money amount={last.deductions} /></>}, доход <Money amount={last.value - last.invested - last.deductions} signed />
          </p>
        )}
        <div className="invest-chart" aria-label="Рост по годам">
          {rows.map((r) => (
            <div key={r.year} className="invest-col" title={`${r.year}-й год`}>
              <span className="value" style={{ height: `${(r.value / max) * 100}%` }}>
                <span className="invested" style={{ height: `${(Math.min(r.invested, r.value) / Math.max(r.value, 1)) * 100}%` }} />
              </span>
              <span className="label">{r.year}</span>
            </div>
          ))}
        </div>
        <div className="hint">
          <span className="legend invested" /> вложено · <span className="legend value" /> доход и вычеты
        </div>
        <div className="actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </div>
    </Modal>
  );
}

function yearsWord(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "год";
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return "года";
  return "лет";
}

/** Подпись вида счёта в списке счетов. */
export function investKindLabel(kind: string | null): string {
  return kind && kind in INVEST_KINDS ? INVEST_KINDS[kind as keyof typeof INVEST_KINDS] : INVEST_KINDS.broker;
}
