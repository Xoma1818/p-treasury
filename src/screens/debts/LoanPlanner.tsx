import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { AccountSelect, AmountInput, Field } from "../../components/Fields";
import { Hint } from "../../components/Hint";
import { ErrorText, Modal } from "../../components/Modal";
import { Money } from "../../components/Money";
import { api, REPAYMENTS, type CalcInput, type CalcResult, type DebtInput, type Direction, type InterestMethod, type PayEvery, type RatePeriod, type Repayment, type SimView } from "../../lib/api";
import { formatDate, today } from "../../lib/dates";
import { addDays, addMonths, annualHint, daysBetween, METHODS, PAY_EVERY, paymentsText, RATE_PERIODS, rateLabel, toCalcInput, type LoanForm, type Solve, type TermUnit } from "../../lib/loan";
import { useAccounts, useCurrencies, useSettings } from "../../lib/queries";
import { useAction } from "../../lib/useAction";
import { useDebounced } from "../../lib/useDebounced";
import { BalanceChart } from "./BalanceChart";
import { EarlyEditor, RateEditor } from "./Editors";
import { ExportDialog, exportSchedule, savedText, type ExportSource } from "./ExportDialog";

const SOLVES: [Solve, string][] = [
  ["payment", "Платёж"],
  ["term", "Срок"],
  ["principal", "Сумму"],
  ["rate", "Ставку"],
];

/** Начальные поля: «Калькулятор» открывается с примером, «Новый долг» — пустым. */
export function initialForm(example: boolean): LoanForm {
  return {
    solve: "payment",
    amount: example ? "300000" : "",
    payment: "",
    term: example ? "2" : "",
    termUnit: example ? "years" : "months",
    rate: example ? "18" : "",
    ratePeriod: "year",
    rates: [],
    repayment: "annuity",
    payEvery: "month",
    issueDate: today(),
    firstPayment: "",
    maturity: "",
    method: "daily",
    early: [],
  };
}

/** Калькулятор и «Новый долг» — одна форма: расчёт, досрочки, диаграмма, график,
 *  «Записать заём», «Скачать Excel», «PDF для подписи». Расчёт живой (planLoan). */
export function LoanPlanner({ back, example, onCreated }: { back: () => void; example: boolean; onCreated: (id: string) => void }) {
  const currencies = useCurrencies().data ?? [];
  const base = useSettings().data?.base_currency ?? "RUB";
  const [currency, setCurrency] = useState<string | null>(null);
  const cur = currency ?? base;
  const c = currencies.find((x) => x.code === cur);
  const mu = c?.minorUnits ?? 2;
  const sym = c?.symbol ?? "₽";
  const [f, setF] = useState<LoanForm>(() => initialForm(example));
  const set = (patch: Partial<LoanForm>) => setF((x) => ({ ...x, ...patch }));
  const [showRates, setShowRates] = useState(false);
  const [record, setRecord] = useState(false);
  const [pdf, setPdf] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const parsed = toCalcInput(f, mu);
  const key = useDebounced(parsed.input ? JSON.stringify(parsed.input) : null, 250);
  const input = useMemo(() => (key ? (JSON.parse(key) as CalcInput) : null), [key]);
  const plan = useQuery({ queryKey: ["planLoan", key], queryFn: () => api.planLoan(input!), enabled: !!input, retry: false, placeholderData: keepPreviousData });
  const r = input ? plan.data : undefined;
  const bullet = f.repayment === "bullet";
  const solve: Solve = bullet ? "payment" : f.solve;
  const excel = useAction(async () => input && exportSchedule({ kind: "calc", input, currency: cur }, "xlsx"), (p) => p && setStatus(savedText(p)));

  return (
    <>
      <button className="link back" onClick={back}>
        ← Все долги
      </button>
      <div className="screen-head">
        <h1>
          {example ? "Калькулятор кредита и займа" : "Новый долг"}
          <span className="sub-title">расчёт, как в банке</span>
        </h1>
      </div>
      <div className="loan-planner">
        <div className="card loan-form" data-testid="loan-form">
          {!bullet && (
            <div className="loan-solve">
              <span className="loan-solve-label">
                Рассчитать
                <Hint of="loan.solve" />
              </span>
              <div className="tabs small" role="tablist" aria-label="Что рассчитать">
                {SOLVES.map(([s, label]) => (
                  <button key={s} type="button" role="tab" aria-selected={f.solve === s} className={f.solve === s ? "tab active" : "tab"} data-testid={`solve-${s}`} onClick={() => set({ solve: s })}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="row">
            {solve !== "principal" ? (
              <Field label="Сумма" help="loan.amount">
                {(id) => <AmountInput id={id} name="principal" value={f.amount} onChange={(v) => set({ amount: v })} minorUnits={mu} autoFocus={!example} />}
              </Field>
            ) : (
              <Field label="Сумма" help="loan.amount">
                {() => (
                  <div className="loan-solved" data-testid="solved-principal">
                    {r ? <Money amount={r.principal} symbol={sym} minorUnits={mu} /> : "—"}
                  </div>
                )}
              </Field>
            )}
            <Field label="Валюта">
              {(id) => (
                <select id={id} name="currency" value={cur} onChange={(e) => setCurrency(e.target.value)}>
                  {currencies.map((x) => (
                    <option key={x.code} value={x.code}>
                      {x.code}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
          {solve !== "payment" && (
            <Field label={solve === "rate" ? "Платёж по договору" : f.payEvery === "month" ? "Желаемый платёж в месяц" : "Желаемый платёж"} help="loan.payment">
              {(id) => <AmountInput id={id} name="desiredPayment" value={f.payment} onChange={(v) => set({ payment: v })} minorUnits={mu} />}
            </Field>
          )}
          <div className="row">
            {bullet ? (
              <>
                <Field label="Вернуть до">{(id) => <input id={id} name="maturity" type="date" value={f.maturity} onChange={(e) => set({ maturity: e.target.value })} />}</Field>
                <Field label="Или через, дней" help="loan.days">
                  {(id) => (
                    <input
                      id={id}
                      name="termDays"
                      className="amount"
                      inputMode="numeric"
                      value={daysBetween(f.issueDate, f.maturity) ?? ""}
                      onChange={(e) => {
                        const n = Number(e.target.value.replace(/\D/g, ""));
                        set({ maturity: e.target.value.trim() === "" ? "" : addDays(f.issueDate, Math.min(n, 36_500)) });
                      }}
                    />
                  )}
                </Field>
              </>
            ) : solve === "term" ? (
              <Field label="Срок" help="loan.term">
                {() => <div className="loan-solved" data-testid="solved-term">{r?.termMonths ? paymentsText(r.termMonths, f.payEvery) : "—"}</div>}
              </Field>
            ) : (
              <Field label="Срок" help="loan.term">
                {(id) => (
                  <span className="term-input">
                    <input id={id} name="term" inputMode="decimal" value={f.term} onChange={(e) => set({ term: e.target.value })} />
                    <select name="termUnit" aria-label="Единица срока" value={f.termUnit} onChange={(e) => set({ termUnit: e.target.value as TermUnit })}>
                      <option value="years">лет</option>
                      <option value="months">месяцев</option>
                    </select>
                  </span>
                )}
              </Field>
            )}
            {solve === "rate" ? (
              <Field label="Ставка" help="loan.rate">
                {() => (
                  <div className="loan-solved" data-testid="solved-rate">
                    {r ? rateLabel(r.rateBp, f.ratePeriod) : "—"}
                  </div>
                )}
              </Field>
            ) : (
              <Field label="Ставка" help="loan.rate" hint={annualHint(input?.rateBp ?? 0, f.ratePeriod)}>
                {(id) => (
                  <span className="term-input">
                    <input id={id} name="rate" className="amount" inputMode="decimal" value={f.rate} onChange={(e) => set({ rate: e.target.value })} placeholder="0" />
                    <RatePeriodSelect value={f.ratePeriod} onChange={(ratePeriod) => set({ ratePeriod })} />
                  </span>
                )}
              </Field>
            )}
          </div>
          {solve === "rate" && (
            <Field label="Ставку показать" help="loan.rate">
              {(id) => <RatePeriodSelect id={id} value={f.ratePeriod} onChange={(ratePeriod) => set({ ratePeriod })} />}
            </Field>
          )}
          {showRates || f.rates.length > 0 ? (
            <div className="loan-sub">
              <div className="loan-sub-head">
                Ставка меняется
                <Hint of="loan.rates" />
              </div>
              <RateEditor lines={f.rates} unit={RATE_PERIODS[f.ratePeriod]} onChange={(rates) => (set({ rates }), rates.length === 0 && setShowRates(false))} defaultDate={f.issueDate} />
            </div>
          ) : (
            <button type="button" className="link rate-link" onClick={() => (setShowRates(true), set({ rates: [{ from: f.issueDate, rate: "" }] }))}>
              Ставка меняется?
            </button>
          )}
          <div className="row">
            <Field label="Тип платежей" help="loan.repayment">
              {(id) => (
                <select id={id} name="repayment" value={f.repayment} onChange={(e) => set({ repayment: e.target.value as Repayment })}>
                  {(Object.keys(REPAYMENTS) as Repayment[]).map((x) => (
                    <option key={x} value={x}>
                      {REPAYMENTS[x]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {!bullet && (
              <Field label="Платить" help="loan.every">
                {(id) => <PayEverySelect id={id} value={f.payEvery} onChange={(payEvery) => set({ payEvery })} />}
              </Field>
            )}
          </div>
          <div className="row">
            <Field label="Дата выдачи">{(id) => <input id={id} name="issueDate" type="date" value={f.issueDate} onChange={(e) => set({ issueDate: e.target.value })} />}</Field>
            {!bullet && (
              <Field label="Начало выплат" help="loan.first" hint={f.firstPayment ? undefined : f.payEvery === "month" ? "через месяц после выдачи" : `через один период: ${PAY_EVERY[f.payEvery]}`}>
                {(id) => <input id={id} name="firstPayment" type="date" value={f.firstPayment} onChange={(e) => set({ firstPayment: e.target.value })} />}
              </Field>
            )}
          </div>
          <div className="loan-method">
            <span className="loan-solve-label">
              Проценты
              <Hint of="loan.method" />
            </span>
            <div className="tabs small" role="tablist" aria-label="Как считать проценты">
              {(Object.keys(METHODS) as InterestMethod[]).map((m) => (
                <button key={m} type="button" role="tab" aria-selected={f.method === m} className={f.method === m ? "tab active" : "tab"} data-testid={`method-${m}`} onClick={() => set({ method: m })}>
                  {METHODS[m]}
                </button>
              ))}
            </div>
          </div>
          <div className="loan-sub">
            <div className="loan-sub-head">
              Досрочные погашения
              <Hint of="loan.early" />
            </div>
            <EarlyEditor lines={f.early} onChange={(early) => set({ early })} minorUnits={mu} symbol={sym} defaultDate={f.firstPayment || addMonths(f.issueDate, 1)} bullet={bullet} />
          </div>
        </div>

        <div className="loan-side">
          <div className="card loan-result" data-testid="loan-totals">
            <h2>
              Итог
              <Hint of="loan.totals" />
            </h2>
            {!input && <p className="hint">{parsed.error}</p>}
            {input && plan.error && (
              <p className="hint warn" role="status">
                {String(plan.error)}
              </p>
            )}
            {r && !plan.error && <Totals r={r} solve={solve} bullet={bullet} falling={f.repayment === "differentiated"} period={f.ratePeriod} every={f.payEvery} sym={sym} mu={mu} />}
            {r && !plan.error && (
              <>
                <div className="loan-chart-head">
                  Остаток долга
                  <Hint of="loan.chart" />
                </div>
                <BalanceChart base={r.base} withEarly={r.withEarly} issueDate={f.issueDate} principal={r.principal} symbol={sym} minorUnits={mu} />
              </>
            )}
            <div className="loan-actions">
              <span className="btn-with-hint">
                <button type="button" className="btn primary" disabled={!r || !!plan.error} onClick={() => setRecord(true)}>
                  Записать заём
                </button>
                <Hint of="loan.record" />
              </span>
              <span className="btn-with-hint">
                <button type="button" className="btn" disabled={!r || !!plan.error} aria-busy={excel.busy} data-done={excel.done || undefined} onClick={() => (setStatus(null), excel.run())}>
                  Скачать Excel
                </button>
                <Hint of="loan.excel" />
              </span>
              <span className="btn-with-hint">
                <button type="button" className="btn" disabled={!r || !!plan.error} onClick={() => (setStatus(null), setPdf(true))}>
                  PDF для подписи
                </button>
                <Hint of="loan.pdf" />
              </span>
            </div>
            {status && (
              <p className="hint ok" data-testid="export-status">
                {status}
              </p>
            )}
            <ErrorText error={excel.error} />
          </div>
        </div>
      </div>

      {r && !plan.error && (
        <div className="card">
          <h2>
            График платежей{r.withEarly ? " с досрочками" : ""}
            <Hint of="debts.schedule" />
          </h2>
          <PlanTable view={r.withEarly ?? r.base} sym={sym} mu={mu} />
        </div>
      )}

      {record && input && r && <RecordDialog input={input} result={r} currency={cur} sym={sym} mu={mu} onClose={() => setRecord(false)} onCreated={onCreated} />}
      {pdf && input && <ExportDialog source={{ kind: "calc", input, currency: cur } satisfies ExportSource} format="pdf" onClose={() => setPdf(false)} onSaved={(p) => (setPdf(false), setStatus(savedText(p)))} />}
    </>
  );
}

/** У дифференцированного платёж убывает: «первый → последний». */
function Totals({ r, solve, bullet, falling, period, every, sym, mu }: { r: CalcResult; solve: Solve; bullet: boolean; falling: boolean; period: RatePeriod; every: PayEvery; sym: string; mu: number }) {
  const m = (v: number) => <Money amount={v} symbol={sym} minorUnits={mu} />;
  const v = r.withEarly ?? r.base;
  const last = r.base.rows[r.base.rows.length - 1]?.payment ?? r.payment;
  return (
    <dl className="loan-totals">
      {solve === "term" && (
        <div className="loan-total big" data-testid="loan-term">
          <dt>Срок</dt>
          <dd>{r.termMonths ? paymentsText(r.termMonths, every) : "—"}</dd>
        </div>
      )}
      {solve === "rate" && (
        <div className="loan-total big" data-testid="loan-rate">
          <dt>Ставка</dt>
          <dd>
            {rateLabel(r.rateBp, period)}
            {annualHint(r.rateBp, period) && <span className="sub"> {annualHint(r.rateBp, period)}</span>}
          </dd>
        </div>
      )}
      {solve === "principal" && (
        <div className="loan-total big" data-testid="loan-principal">
          <dt>Можно взять</dt>
          <dd>{m(r.principal)}</dd>
        </div>
      )}
      <div className={solve === "payment" ? "loan-total big" : "loan-total"} data-testid="loan-payment">
        <dt>{bullet ? "К возврату" : "Платёж"}</dt>
        <dd>
          {m(r.payment)}
          {falling && last !== r.payment && <span className="sub"> → {m(last)}</span>}
        </dd>
      </div>
      <div className="loan-total" data-testid="loan-overpay">
        <dt>Переплата</dt>
        <dd>{m(v.totals.totalInterest)}</dd>
      </div>
      <div className="loan-total" data-testid="loan-maturity">
        <dt>Последний платёж</dt>
        <dd>
          {formatDate(v.totals.maturityDate)}
          {r.withEarly && r.withEarly.totals.maturityDate !== r.base.totals.maturityDate && <span className="sub"> вместо {formatDate(r.base.totals.maturityDate)}</span>}
        </dd>
      </div>
      <div className="loan-total" data-testid="loan-total-payment">
        <dt>Всего выплатить</dt>
        <dd>{m(v.totals.totalPayment)}</dd>
      </div>
      {r.withEarly && (
        <div className="loan-total good" data-testid="loan-savings">
          <dt>Экономия от досрочек</dt>
          <dd>{m(r.savings)}</dd>
        </div>
      )}
    </dl>
  );
}

/** Строки графика вместе с досрочками (досрочка — строка без номера). */
export function PlanTable({ view, sym, mu }: { view: Pick<SimView, "rows" | "early">; sym: string; mu: number }) {
  const m = (v: number) => <Money amount={v} symbol={sym} minorUnits={mu} />;
  type Line = { key: string; seq: number | null; date: string; payment: number; principal: number; interest: number; balance: number; note: string };
  const lines: Line[] = [
    ...view.rows.map((r) => ({
      key: `r${r.seq}`,
      seq: r.seq,
      date: r.dueDate,
      payment: r.payment,
      principal: r.principalPart,
      interest: r.interestPart,
      balance: r.balanceAfter,
      note: r.kind === "interest_only" ? "каникулы" : r.kind === "after_shift" ? "после каникул" : r.status === "paid" ? "оплачен" : r.status === "partial" ? "оплачен частично" : "",
    })),
    ...view.early.map((e, i) => ({ key: `e${i}`, seq: null, date: e.date, payment: e.principal + e.interest, principal: e.principal, interest: e.interest, balance: e.balanceAfter, note: e.planned ? "досрочно (план)" : "досрочно" })),
  ].sort((a, b) => a.date.localeCompare(b.date) || (a.seq === null ? -1 : 0) - (b.seq === null ? -1 : 0));
  return (
    <div className="table-scroll">
      <table className="table compact schedule" data-testid="plan-schedule">
        <thead>
          <tr>
            <th>№</th>
            <th>Дата</th>
            <th className="num">Платёж</th>
            <th className="num">Основной долг</th>
            <th className="num">Проценты</th>
            <th className="num">Остаток</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.key} className={l.seq === null ? "early-row" : undefined} data-testid={l.seq === null ? "plan-early" : "plan-row"}>
              <td>{l.seq ?? "—"}</td>
              <td>{formatDate(l.date)}</td>
              <td className="num">{m(l.payment)}</td>
              <td className="num">{m(l.principal)}</td>
              <td className="num">{m(l.interest)}</td>
              <td className="num">{m(l.balance)}</td>
              <td className="status">{l.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** «Записать заём»: кто, направление, счёт и комментарий — остальное из расчёта. */
function RecordDialog({ input, result, currency, sym, mu, onClose, onCreated }: { input: CalcInput; result: CalcResult; currency: string; sym: string; mu: number; onClose: () => void; onCreated: (id: string) => void }) {
  const accounts = (useAccounts().data ?? []).filter((a) => a.currencyCode === currency);
  const [direction, setDirection] = useState<Direction>("borrowed");
  const [counterparty, setCounterparty] = useState("");
  const [accountId, setAccountId] = useState("");
  const [note, setNote] = useState("");
  const save = useAction(async (d: DebtInput) => onCreated(await api.createDebt(d)));
  const submit = () => {
    if (!counterparty.trim()) return save.setError(direction === "lent" ? "Укажите, кому вы дали в долг" : "Укажите, у кого взяли в долг");
    save.run({
      direction,
      counterparty: counterparty.trim(),
      note: note.trim() || null,
      currencyCode: currency,
      principal: result.principal,
      issueDate: input.issueDate,
      rateBp: result.rateBp,
      ratePeriod: input.ratePeriod,
      payEvery: input.payEvery,
      repaymentType: input.repayment,
      termMonths: input.repayment === "bullet" ? null : result.termMonths,
      firstPaymentDate: input.firstPaymentDate,
      maturityDate: input.maturityDate,
      accountId: accountId || null,
      interestMethod: input.interestMethod,
      rateChanges: input.rateChanges ?? [],
      plannedEarly: input.plannedEarly ?? [],
    });
  };
  return (
    <Modal title="Записать заём" onClose={onClose} wide>
      <form className="form" onSubmit={(e) => (e.preventDefault(), submit())}>
        <div className="tabs" role="tablist">
          {(
            [
              ["borrowed", "Я взял в долг"],
              ["lent", "Я дал в долг"],
            ] as [Direction, string][]
          ).map(([d, label]) => (
            <button key={d} type="button" role="tab" aria-selected={direction === d} className={direction === d ? "tab active" : "tab"} onClick={() => setDirection(d)}>
              {label}
            </button>
          ))}
        </div>
        <div className="row">
          <Field label={direction === "lent" ? "Кому" : "У кого (человек или банк)"}>
            {(id) => <input id={id} name="counterparty" value={counterparty} onChange={(e) => setCounterparty(e.target.value)} autoFocus />}
          </Field>
          <Field label={direction === "lent" ? "С какого счёта выдал" : "На какой счёт получил"} hint="Без счёта долг запишется без операции, например старый кредит">
            {(id) => <AccountSelect id={id} name="account" accounts={accounts} value={accountId} onChange={setAccountId} placeholder="Без операции" />}
          </Field>
        </div>
        <Field label="Комментарий">{(id) => <input id={id} name="debtNote" value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        <div className="card preview" data-testid="debt-preview">
          <Money amount={result.principal} symbol={sym} minorUnits={mu} />
          {result.rateBp ? ` под ${rateLabel(result.rateBp, input.ratePeriod)}` : " без процентов"}
          {result.termMonths && input.repayment !== "bullet" ? `, ${paymentsText(result.termMonths, input.payEvery)}` : ""}, {input.repayment === "bullet" ? "к возврату" : "платёж"}{" "}
          <b>
            <Money amount={result.payment} symbol={sym} minorUnits={mu} />
          </b>
          , проценты {METHODS[input.interestMethod ?? "daily"]}
          {(input.plannedEarly?.length ?? 0) > 0 && ", плановые досрочки сохранятся для прогноза"}
        </div>
        <ErrorText error={save.error} />
        <div className="actions">
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


/** «% годовых / в месяц / в день». */
export function RatePeriodSelect({ id, value, onChange }: { id?: string; value: RatePeriod; onChange: (v: RatePeriod) => void }) {
  return (
    <select id={id} name="ratePeriod" aria-label="Период ставки" value={value} onChange={(e) => onChange(e.target.value as RatePeriod)}>
      {(Object.keys(RATE_PERIODS) as RatePeriod[]).map((p) => (
        <option key={p} value={p}>
          {RATE_PERIODS[p]}
        </option>
      ))}
    </select>
  );
}

/** «каждый месяц / раз в квартал / раз в две недели». */
export function PayEverySelect({ id, value, onChange }: { id?: string; value: PayEvery; onChange: (v: PayEvery) => void }) {
  return (
    <select id={id} name="payEvery" value={value} onChange={(e) => onChange(e.target.value as PayEvery)}>
      {(Object.keys(PAY_EVERY) as PayEvery[]).map((p) => (
        <option key={p} value={p}>
          {PAY_EVERY[p]}
        </option>
      ))}
    </select>
  );
}
