import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, INVEST_KINDS, type Currency, type InvestAccount, type InvestMonth, type InvestOverview, type InvestPlanMode } from "../lib/api";
import { formatDate, monthTitle, today } from "../lib/dates";
import { contributionPrefill, needsPlanCurrency, progressIssue, projectGrowth, rubleContribution, tenthsText } from "../lib/invest";
import { parseAmount } from "../lib/money";
import { useAccounts, useInvestOverview } from "../lib/queries";
import { useUi } from "../lib/store";
import { useAction } from "../lib/useAction";
import { useFormWrite } from "../lib/useFormWrite";
import { AmountInput, amountText, Field } from "./Fields";
import { FormAmountsToggle, useFormAmounts, useFormMoney } from "./FormAmounts";
import { ErrorText, Modal } from "./Modal";
import { BaseMoney, Money } from "./Money";
import { Hint } from "./Hint";
import { ConfirmPlanCurrency, PlanCurrencySelect } from "./InvestPlanCurrency";

/** «Отложено 15 000 из 20 000 ₽» с полоской; без плана — только сумма. */
function MonthLine({ m, onPlan }: { m: InvestMonth; onPlan: () => void }) {
  const percent = m.percent;
  const issue = progressIssue(m);
  const unit = { symbol: m.currency.symbol, currencyCode: m.currency.code, minorUnits: m.currency.minorUnits };
  return (
    <div className="invest-month" data-testid="invest-month">
      <div>
        {m.savedComplete ? "Отложено" : "Отложено по известным курсам"} <b data-testid="invest-saved"><Money amount={m.saved} {...unit} /></b>
        {m.planned != null ? (
          <>
            {" "}из <Money amount={m.planned} {...unit} />
            {m.plan.mode === "percent" && <span className="hint"> ({m.plan.value} % доходов)</span>}
          </>
        ) : null}{" "}
        <button className="link" onClick={onPlan} data-testid="invest-plan-edit">
          {needsPlanCurrency(m.plan) ? "Указать валюту плана" : m.plan.mode ? "Изменить план" : "Задать план на месяц"}
        </button>
      </div>
      {issue && <p className="hint">{issue}</p>}
      {!issue && percent != null && (
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
  return (
    <div className="invest-totals" data-testid="invest-totals">
      <div>
        <div className="tile-label">Вложено</div>
        <BaseMoney amount={o.invested} currencyCode={o.baseCurrency} />
      </div>
      <div>
        <div className="tile-label">Стоит сейчас</div>
        <b data-testid="invest-value">
          <BaseMoney amount={o.value} currencyCode={o.baseCurrency} />
        </b>
      </div>
      <div>
        <div className="tile-label">Результат</div>
        <span className={o.result >= 0 ? "plus" : "minus"} data-testid="invest-result">
          <BaseMoney amount={o.result} currencyCode={o.baseCurrency} signed />
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
  const o = useInvestOverview().data;
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
      prefill: { accountId: from?.id ?? null, toAccountId: o.accounts[0]?.id ?? null, ...contributionPrefill(o.month) },
    });
  return (
    <div className="card invest-card" data-testid="home-invest">
      <div className="notes-head">
        <h2>
          Инвестиции, {monthTitle(o.month.month).toLowerCase()}
          <Hint of="invest" />
        </h2>
        <button className="link" onClick={() => setDialog("calc")} data-testid="invest-calc-open">
          Калькулятор
        </button>
      </div>
      {!has && !o.month.plan.mode ? (
        <p className="muted">
          Откладываете на инвестиции? Заведите брокерский счёт или ИИС в «Счетах», задайте план на месяц, и здесь будет видно, сколько отложено и сколько это стоит.{" "}
          <button className="link" onClick={() => go("accounts")}>
            Завести счёт
          </button>
        </p>
      ) : (
        <>
          <MonthLine m={o.month} onPlan={() => setDialog("plan")} />
          {has && <Totals o={o} />}
          <TaxLine o={o} />
          {o.passiveIncome > 0 && (
            <div className="hint" data-testid="invest-passive">
              Дивиденды и купоны за год: <BaseMoney amount={o.passiveIncome} currencyCode={o.baseCurrency} />
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
  const [planning, setPlanning] = useState(false);
  if (!m) return null;
  return (
    <div className="card" data-testid="budget-invest">
      <h2>Инвестиции</h2>
      <p className="hint">Переводы на брокерский счёт или ИИС — не траты: они не уменьшают «Можно тратить», но видно, выполнен ли план.</p>
      <MonthLine m={m} onPlan={() => setPlanning(true)} />
      {planning && <PlanForm m={m} month={month} onClose={() => setPlanning(false)} />}
    </div>
  );
}

/** План на инвестиции; с `month` можно задать план только на этот месяц. */
type PlanProps = { m: InvestMonth; month?: string; onClose: () => void };
export function PlanForm(props: PlanProps) {
  // Подтверждаем именно запись, открытую пользователем, даже если запрос обновился.
  const [source] = useState(props.m);
  if (needsPlanCurrency(source.plan)) {
    return <ConfirmPlanCurrency month={source.plan.onlyMonth ? source.month : null} rawValue={source.plan.value} onClose={props.onClose} />;
  }
  return <PlanEditor {...props} m={source} />;
}

function PlanEditor({ m, month, onClose }: PlanProps) {
  const privacy = useFormAmounts(m.start);
  const money = useFormMoney(privacy, m.incomeCurrency.code, m.incomeCurrency.symbol, m.incomeCurrency.minorUnits);
  const [currency, setCurrency] = useState(m.currency);
  const [mode, setMode] = useState<InvestPlanMode>(m.plan.mode || "amount");
  const [amount, setAmount] = useState(m.plan.mode === "amount" ? amountText(m.plan.value, currency.minorUnits) : "");
  const [percent, setPercent] = useState(m.plan.mode === "percent" ? String(m.plan.value) : "10");
  const [onlyMonth, setOnlyMonth] = useState(m.plan.onlyMonth);
  const write = useFormWrite();
  const save = useAction(api.setInvestPlan, onClose);
  const reset = useAction(api.clearInvestMonthPlan, onClose);
  const target = onlyMonth ? m.month : null;
  const cancel = () => { if (!write.locked.current) onClose(); };
  const selectCurrency = (next: Currency | null) => {
    if (!next || next.code === currency.code) return;
    privacy.conceal();
    setAmount("");
    setCurrency(next);
  };
  const canPickCurrency = m.plan.mode !== "amount" || (onlyMonth && !m.plan.onlyMonth);
  const submit = () => {
    if (mode === "amount") {
      const v = parseAmount(amount, currency.minorUnits);
      if (v === null || v <= 0) return save.setError("Введите сумму, например 20 000");
      return write.run("save", () => save.runAsync("amount", v, target, currency.code));
    }
    const p = Number(percent.replace(",", "."));
    if (!Number.isInteger(p) || p < 1 || p > 100) return save.setError("Процент — целое число от 1 до 100");
    write.run("save", () => save.runAsync("percent", p, target));
  };
  return (
    <Modal title="План на инвестиции" onClose={cancel} dismissDisabled={write.busy}>
      <form className="form" ref={write.form} onClickCapture={write.blockClick} onSubmit={(e) => (e.preventDefault(), submit())}>
        <fieldset disabled={write.busy} style={{ display: "contents" }}>
        <p className="muted">Сколько откладывать каждый месяц. Отложенным считаются переводы на брокерские счета, ИИС и ПДС.</p>
        <FormAmountsToggle privacy={privacy} />
        <div className="tabs small" role="tablist">
          <button type="button" role="tab" className={mode === "amount" ? "tab active" : "tab"} onClick={() => setMode("amount")}>
            Сумма
          </button>
          <button type="button" role="tab" className={mode === "percent" ? "tab active" : "tab"} onClick={() => setMode("percent")} data-testid="invest-plan-percent">
            % от доходов
          </button>
        </div>
        {mode === "amount" ? (
          <>
            {canPickCurrency && <PlanCurrencySelect currency={currency} onChange={selectCurrency} />}
            <Field label={`Сумма плана, ${currency.code}`}>{(id) => <AmountInput id={id} name="investPlanAmount" value={amount} onChange={setAmount} minorUnits={currency.minorUnits} concealed={privacy.concealed} autoFocus />}</Field>
          </>
        ) : (
          <Field label="Процент от доходов месяца" hint={!m.incomeComplete ? "Для расчёта доходов нужен курс валюты." : m.income > 0 ? <>В этом месяце доходы <span className="money">{money(m.income)}</span></> : undefined}>
            {(id) => <input id={id} name="investPlanPercent" inputMode="numeric" value={percent} onChange={(e) => setPercent(e.target.value)} />}
          </Field>
        )}
        {m.plan.onlyMonth && <p className="hint">План на {monthTitle(m.month).toLowerCase()}.</p>}
        {month && !m.plan.onlyMonth && (
          <label className="check">
            <input type="checkbox" name="investOnlyMonth" checked={onlyMonth} onChange={e => {
              setOnlyMonth(e.target.checked);
              if (!e.target.checked && m.plan.mode === "amount") selectCurrency(m.currency);
            }} />
            Только на {monthTitle(m.month).toLowerCase()} (например, премия — отложить больше), остальные месяцы по общему плану
          </label>
        )}
        <ErrorText error={save.error ?? reset.error} />
        <div className="actions">
          {m.plan.onlyMonth ? (
            <button type="button" className="btn" onClick={() => write.run("delete", () => reset.runAsync(m.month))}>
              Вернуть общий план
            </button>
          ) : (
            m.plan.mode && (
              <button type="button" className="btn" onClick={() => write.run("delete", () => save.runAsync("", 0, target))}>
                {onlyMonth ? "Не откладывать в этом месяце" : "Убрать план"}
              </button>
            )
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={cancel}>
            Отмена
          </button>
          <button type="submit" className="btn primary" aria-busy={write.operation === "save"} data-done={save.done || undefined} disabled={write.busy}>
            Сохранить
          </button>
        </div>
        </fieldset>
      </form>
    </Modal>
  );
}

/** Ввод стоимости счёта из приложения брокера и история оценок. */
export function ValueForm({ accounts, accountId, onClose }: { accounts: InvestAccount[]; accountId?: string; onClose: () => void }) {
  const [id, setId] = useState(accountId ?? accounts[0]?.id ?? "");
  const a = accounts.find((x) => x.id === id);
  const privacy = useFormAmounts(id);
  const money = useFormMoney(privacy, a?.currencyCode ?? "", a?.currencySymbol ?? "", a?.minorUnits ?? 2);
  const [value, setValue] = useState(a ? amountText(a.value, a.minorUnits) : "");
  const [date, setDate] = useState(today());
  const save = useAction(api.setInvestValue, onClose, { singleSubmit: true });
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
        <FormAmountsToggle privacy={privacy} />
        <p className="muted">
          Введите, сколько сейчас стоит портфель, из приложения брокера. Вложено <span className="money">{money(a.invested)}</span>; разница — результат инвестиций, он не попадает в доходы и расходы.
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
          <Field label="Стоит">{(fid) => <AmountInput id={fid} name="investValue" value={value} onChange={setValue} minorUnits={a.minorUnits} concealed={privacy.concealed} autoFocus />}</Field>
          <Field label="На дату">{(fid) => <input id={fid} name="investDate" type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
        </div>
        {parsed !== null && (
          <p data-testid="invest-value-preview">
            Результат: <span className="money">{money(parsed - a.invested, true)}</span>
          </p>
        )}
        {a.history.length > 0 && (
          <table className="table compact" data-testid="invest-history">
            <tbody>
              {a.history.slice(0, 12).map((h) => (
                <tr key={h.date}>
                  <td>{formatDate(h.date)}</td>
                  <td className="num">
                    <span className="money">{money(h.value)}</span>
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
          <button type="submit" className="btn primary" aria-busy={save.busy} data-done={save.done || undefined} disabled={save.busy || parsed === null}>
            Сохранить
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** «Что будет через N лет»: взнос в месяц, доходность, срок, вычет ИИС. */
function Calculator({ o, onClose }: { o: InvestOverview; onClose: () => void }) {
  const privacy = useFormAmounts("invest-calculator");
  const money = useFormMoney(privacy, "RUB", "₽", 2);
  const inRubles = o.baseCurrency === "RUB";
  const [start, setStart] = useState(inRubles ? amountText(Math.max(o.value, 0) || null) : "");
  const [monthly, setMonthly] = useState(amountText(rubleContribution(o.month)));
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
        <FormAmountsToggle privacy={privacy} />
        <div className="row">
          <Field label="Уже вложено, ₽">{(id) => <AmountInput id={id} name="calcStart" value={start} onChange={setStart} concealed={privacy.concealed} />}</Field>
          <Field label="Взнос в месяц, ₽">{(id) => <AmountInput id={id} name="calcMonthly" value={monthly} onChange={setMonthly} concealed={privacy.concealed} />}</Field>
        </div>
        <div className="row">
          <Field label="Доходность в год, %" hint="Ваше допущение: приложение ничего не советует">
            {(id) => <input id={id} name="calcRate" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />}
          </Field>
          <Field label="Срок, лет">{(id) => <input id={id} name="calcYears" inputMode="numeric" value={years} onChange={(e) => setYears(e.target.value)} />}</Field>
        </div>
        <label className="check">
          <input type="checkbox" name="calcIis" checked={iis} onChange={(e) => setIis(e.target.checked)} />
          ИИС: вычет 13 %{!privacy.concealed && " (до 52 000 ₽ в год)"} докладывать на счёт
        </label>
        {last && (
          <p className="invest-calc-result" data-testid="invest-calc-result">
            Через {last.year} {yearsWord(last.year)}: <b className="money">{money(last.value)}</b>, из них вложено <span className="money">{money(last.invested)}</span>
            {last.deductions > 0 && <>, вычеты <span className="money">{money(last.deductions)}</span></>}, доход <span className="money">{money(last.value - last.invested - last.deductions, true)}</span>
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
          <span className="legend-dot invested" /> вложено · <span className="legend-dot value" /> доход и вычеты
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
