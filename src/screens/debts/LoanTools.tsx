import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { AmountInput, amountText, Field } from "../../components/Fields";
import { Hint } from "../../components/Hint";
import { ErrorText, Modal } from "../../components/Modal";
import { Money } from "../../components/Money";
import { api, REPAYMENTS, type DebtCard, type DebtDetail, type HolidayKind, type InterestMethod, type RecalcMode, type Repayment, type ScheduleRow, type TermsInput } from "../../lib/api";
import { formatDate, today } from "../../lib/dates";
import { annualHint, earlyLines, METHODS, MODES, monthsToPayments, paymentsToMonths, parseRate, plannedEarly, RATE_PERIODS, rateLabel, rateToInput, termToMonths, type EarlyLine, type TermUnit } from "../../lib/loan";
import { parseAmount } from "../../lib/money";
import { useAction } from "../../lib/useAction";
import { useDebounced } from "../../lib/useDebounced";
import { BalanceChart } from "./BalanceChart";
import { EarlyEditor } from "./Editors";
import { PayEverySelect, RatePeriodSelect } from "./LoanPlanner";

const money = (card: DebtCard) => (v: number) => <Money amount={v} symbol={card.currencySymbol} minorUnits={card.minorUnits} />;

/** Строка «было → стало» с подсветкой того, что изменилось. */
function Diff({ label, was, now, testid }: { label: string; was: ReactNode; now: ReactNode; testid?: string }) {
  return (
    <tr data-testid={testid}>
      <td className="muted">{label}</td>
      <td className="num">{was}</td>
      <td className="arrow">→</td>
      <td className="num">
        <b>{now}</b>
      </td>
    </tr>
  );
}

/** «Изменить условия»: все поля займа и предпросмотр «было → стало» до сохранения. */
export function TermsForm({ detail, onClose }: { detail: DebtDetail; onClose: () => void }) {
  const c = detail.card;
  const mu = c.minorUnits;
  const [f, setF] = useState({
    amount: amountText(c.principal, mu),
    issueDate: c.issueDate,
    rate: c.rateBp ? rateToInput(c.rateBp, c.ratePeriod) : "",
    ratePeriod: c.ratePeriod,
    repayment: c.repaymentType,
    payEvery: c.payEvery,
    term: c.termMonths ? String(paymentsToMonths(c.termMonths, c.payEvery)) : "",
    termUnit: "months" as TermUnit,
    firstPayment: c.firstPaymentDate ?? "",
    maturity: c.repaymentType === "bullet" ? c.maturityDate : "",
    method: c.interestMethod,
  });
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }));
  const terms = useMemo((): TermsInput | null => {
    const principal = parseAmount(f.amount, mu);
    const rateBp = parseRate(f.rate, f.ratePeriod);
    if (!principal || principal <= 0 || rateBp === null) return null;
    const bullet = f.repayment === "bullet";
    const months = bullet ? null : termToMonths(f.term, f.termUnit);
    // У ядра срок — число платежей.
    const termMonths = months === null ? null : monthsToPayments(months, f.payEvery);
    if (!bullet && termMonths === null) return null;
    if (bullet && !f.maturity) return null;
    return {
      principal,
      issueDate: f.issueDate,
      rateBp,
      repaymentType: f.repayment,
      termMonths,
      firstPaymentDate: bullet ? null : f.firstPayment || null,
      maturityDate: bullet ? f.maturity : null,
      interestMethod: f.method,
      ratePeriod: f.ratePeriod,
      payEvery: bullet ? "month" : f.payEvery,
    };
  }, [f, mu]);
  const key = useDebounced(terms ? JSON.stringify(terms) : null, 250);
  // Точный предпросмотр ядра: с уже внесёнными платежами, изменениями ставки и каникулами.
  const now = useQuery({
    queryKey: ["previewDebtTerms", c.id, key],
    queryFn: () => api.previewDebtTerms(c.id, JSON.parse(key!) as TermsInput),
    enabled: !!key,
    retry: false,
    placeholderData: keepPreviousData,
  });
  const save = useAction((t: TermsInput) => api.updateDebtTerms(c.id, t), onClose, { celebrate: true });
  const m = money(c);
  const w = now.data?.before.totals;
  const n = key ? now.data?.after.totals : undefined;
  const bullet = f.repayment === "bullet";

  return (
    <Modal title="Условия займа" onClose={onClose} wide>
      <form className="form" onSubmit={(e) => (e.preventDefault(), terms ? save.run(terms) : save.setError("Проверьте сумму, ставку и срок"))}>
        <div className="row">
          <Field label="Сумма" help="loan.amount">
            {(id) => <AmountInput id={id} name="termsPrincipal" value={f.amount} onChange={(v) => set({ amount: v })} minorUnits={mu} autoFocus />}
          </Field>
          <Field label="Дата выдачи">{(id) => <input id={id} name="termsIssue" type="date" value={f.issueDate} onChange={(e) => set({ issueDate: e.target.value })} />}</Field>
          <Field label="Ставка" help="loan.rate" hint={annualHint(terms?.rateBp ?? 0, f.ratePeriod)}>
            {(id) => (
              <span className="term-input">
                <input id={id} name="termsRate" className="amount" inputMode="decimal" value={f.rate} onChange={(e) => set({ rate: e.target.value })} placeholder="0" />
                <RatePeriodSelect value={f.ratePeriod} onChange={(ratePeriod) => set({ ratePeriod })} />
              </span>
            )}
          </Field>
        </div>
        <div className="row">
          <Field label="Тип платежей" help="loan.repayment">
            {(id) => (
              <select id={id} name="termsRepayment" value={f.repayment} onChange={(e) => set({ repayment: e.target.value as Repayment })}>
                {(Object.keys(REPAYMENTS) as Repayment[]).map((x) => (
                  <option key={x} value={x}>
                    {REPAYMENTS[x]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {bullet ? (
            <Field label="Вернуть до">{(id) => <input id={id} name="termsMaturity" type="date" value={f.maturity} onChange={(e) => set({ maturity: e.target.value })} />}</Field>
          ) : (
            <>
              <Field label="Срок" help="loan.term">
                {(id) => (
                  <span className="term-input">
                    <input id={id} name="termsTerm" inputMode="decimal" value={f.term} onChange={(e) => set({ term: e.target.value })} />
                    <select name="termsTermUnit" aria-label="Единица срока" value={f.termUnit} onChange={(e) => set({ termUnit: e.target.value as TermUnit })}>
                      <option value="years">лет</option>
                      <option value="months">месяцев</option>
                    </select>
                  </span>
                )}
              </Field>
              <Field label="Платить" help="loan.every">
                {(id) => <PayEverySelect id={id} value={f.payEvery} onChange={(payEvery) => set({ payEvery })} />}
              </Field>
              <Field label="Начало выплат" help="loan.first">
                {(id) => <input id={id} name="termsFirst" type="date" value={f.firstPayment} onChange={(e) => set({ firstPayment: e.target.value })} />}
              </Field>
            </>
          )}
        </div>
        <div className="loan-method">
          <span className="loan-solve-label">
            Проценты
            <Hint of="loan.method" />
          </span>
          <div className="tabs small" role="tablist" aria-label="Как считать проценты">
            {(Object.keys(METHODS) as InterestMethod[]).map((x) => (
              <button key={x} type="button" role="tab" aria-selected={f.method === x} className={f.method === x ? "tab active" : "tab"} onClick={() => set({ method: x })}>
                {METHODS[x]}
              </button>
            ))}
          </div>
        </div>
        {w && n && (
          <table className="table compact terms-diff" data-testid="terms-preview">
            <thead>
              <tr>
                <th></th>
                <th className="num">Было</th>
                <th></th>
                <th className="num">Станет</th>
              </tr>
            </thead>
            <tbody>
              <Diff label="Платёж" was={m(w.payment)} now={m(n.payment)} testid="diff-payment" />
              <Diff label="Проценты за весь срок" was={m(w.totalInterest)} now={m(n.totalInterest)} testid="diff-interest" />
              <Diff label="Последний платёж" was={formatDate(w.maturityDate)} now={formatDate(n.maturityDate)} testid="diff-maturity" />
            </tbody>
          </table>
        )}
        {now.error && <p className="hint warn">{String(now.error)}</p>}
        <p className="hint">Прежний график сохранится в истории. Если выдача записана операцией, её сумма и дата тоже изменятся.</p>
        <ErrorText error={save.error} />
        <div className="actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn primary" aria-busy={save.busy} data-done={save.done || undefined} disabled={save.busy}>
            Сохранить
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** «Ставка изменилась»: новая ставка с даты. */
export function RateChangeForm({ card, onClose }: { card: DebtCard; onClose: () => void }) {
  const [from, setFrom] = useState(today());
  const [rate, setRate] = useState("");
  const save = useAction(async () => {
    const bp = parseRate(rate, card.ratePeriod);
    if (bp === null || rate.trim() === "") throw "Введите новую ставку";
    return api.addDebtRateChange(card.id, { from, rateBp: bp });
  }, onClose, { celebrate: true });
  return (
    <Modal title="Ставка изменилась" onClose={onClose}>
      <form className="form" onSubmit={(e) => (e.preventDefault(), save.run())}>
        <div className="row">
          <Field label="С какой даты" help="loan.rateChanged">
            {(id) => <input id={id} name="rateFrom" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}
          </Field>
          <Field label={`Новая ставка, ${RATE_PERIODS[card.ratePeriod]}`} hint={`Сейчас ${rateLabel(card.rateBp, card.ratePeriod)}`}>
            {(id) => <input id={id} name="newRate" className="amount" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} autoFocus />}
          </Field>
        </div>
        <p className="hint">Проценты с этой даты считаются по новой ставке, платёж пересчитается с ближайшего платежа, срок прежний.</p>
        <ErrorText error={save.error} />
        <div className="actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn primary" aria-busy={save.busy} data-done={save.done || undefined} disabled={save.busy}>
            Сохранить
          </button>
        </div>
      </form>
    </Modal>
  );
}

const HOLIDAY: Record<HolidayKind, string> = { interest_only: "Только проценты", shift: "Перенос платежей" };

/** «Каникулы»: только проценты или перенос, с какого платежа и на сколько месяцев. */
export function HolidayForm({ detail, onClose }: { detail: DebtDetail; onClose: () => void }) {
  const pending = detail.schedule.filter((r) => r.status !== "paid");
  const [kind, setKind] = useState<HolidayKind>("interest_only");
  const [fromSeq, setFromSeq] = useState(String(pending[0]?.seq ?? 1));
  const [months, setMonths] = useState("3");
  const save = useAction(() => api.addDebtHoliday(detail.card.id, { fromSeq: Number(fromSeq), months: Number(months), kind }), onClose, { celebrate: true });
  const m = money(detail.card);
  return (
    <Modal title="Кредитные каникулы" onClose={onClose}>
      <form className="form" onSubmit={(e) => (e.preventDefault(), save.run())}>
        <Field label="Вид каникул" help="loan.holiday">
          {(id) => (
            <select id={id} name="holidayKind" value={kind} onChange={(e) => setKind(e.target.value as HolidayKind)}>
              {(Object.keys(HOLIDAY) as HolidayKind[]).map((k) => (
                <option key={k} value={k}>
                  {HOLIDAY[k]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <div className="row">
          <Field label="С какого платежа">
            {(id) => (
              <select id={id} name="holidayFrom" value={fromSeq} onChange={(e) => setFromSeq(e.target.value)}>
                {pending.map((r) => (
                  <option key={r.seq} value={r.seq}>
                    №{r.seq} — {formatDate(r.dueDate)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="На сколько месяцев">
            {(id) => (
              <select id={id} name="holidayMonths" value={months} onChange={(e) => setMonths(e.target.value)}>
                {Array.from({ length: 12 }, (_, i) => (
                  <option key={i + 1} value={i + 1}>
                    {i + 1}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <p className="hint">
          {kind === "interest_only" ? "В эти месяцы платите только проценты, срок удлинится." : "Платежи сдвинутся, проценты за паузу добавятся к первому платежу после неё."} Сейчас платёж {pending[0] ? m(pending[0].payment) : "—"}.
        </p>
        <ErrorText error={save.error} />
        <div className="actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn primary" aria-busy={save.busy} data-done={save.done || undefined} disabled={save.busy}>
            Сохранить
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Записанные изменения ставки и каникулы с удалением. */
export function ChangesList({ detail }: { detail: DebtDetail }) {
  const delRate = useAction((id: string) => api.deleteDebtRateChange(id));
  const delHoliday = useAction((id: string) => api.deleteDebtHoliday(id));
  if (detail.rateChanges.length === 0 && detail.holidays.length === 0) return null;
  return (
    <div className="loan-changes" data-testid="loan-changes">
      <div className="loan-sub-head">
        Изменения условий
        <Hint of="loan.changes" />
      </div>
      <ul className="account-list">
        {detail.rateChanges.map((r) => (
          <li key={r.id} data-testid="rate-change">
            <span>
              Ставка {rateLabel(r.rateBp, detail.card.ratePeriod)} с {formatDate(r.from)}
            </span>
            <button className="link danger" title="Удалить изменение ставки" aria-label="Удалить изменение ставки" onClick={() => delRate.run(r.id)}>
              ×
            </button>
          </li>
        ))}
        {detail.holidays.map((h) => (
          <li key={h.id} data-testid="holiday">
            <span>
              Каникулы: {HOLIDAY[h.kind].toLowerCase()}, с платежа №{h.fromSeq} на {h.months} мес.
            </span>
            <button className="link danger" title="Удалить каникулы" aria-label="Удалить каникулы" onClick={() => delHoliday.run(h.id)}>
              ×
            </button>
          </li>
        ))}
      </ul>
      <ErrorText error={delRate.error ?? delHoliday.error} />
    </div>
  );
}

/** Плановые досрочки займа (редактор как в форме) и прогноз: когда закроете и сколько сэкономите. */
export function PlannedBlock({ detail }: { detail: DebtDetail }) {
  const c = detail.card;
  const mu = c.minorUnits;
  const [lines, setLines] = useState<EarlyLine[]>(() => earlyLines(detail.plannedEarly, mu));
  const forecast = useQuery({ queryKey: ["debtForecast", c.id], queryFn: () => api.debtForecast(c.id) });
  const save = useAction(() => api.setDebtPlannedEarly(c.id, plannedEarly(lines, mu)));
  const m = money(c);
  const fc = forecast.data;
  const hasPlanned = detail.plannedEarly.length > 0;
  return (
    <div className="columns loan-two">
      <div className="card">
        <h2>
          Плановые досрочки
          <Hint of="loan.planned" />
        </h2>
        <EarlyEditor lines={lines} onChange={setLines} minorUnits={mu} symbol={c.currencySymbol} defaultDate={c.nextPayment?.dueDate ?? today()} bullet={c.repaymentType === "bullet"} />
        <div className="actions">
          <span className="spacer" />
          <button className="btn primary" aria-busy={save.busy} data-done={save.done || undefined} disabled={save.busy} onClick={() => save.run()}>
            Сохранить досрочки
          </button>
        </div>
        <ErrorText error={save.error} />
      </div>
      <div className="card" data-testid="forecast">
        <h2>Прогноз</h2>
        {fc && hasPlanned ? (
          <>
            <dl className="loan-totals">
              <div className="loan-total">
                <dt>Закроете</dt>
                <dd>
                  {formatDate(fc.totals.maturityDate)}
                  {fc.totals.maturityDate !== fc.base.maturityDate && <span className="sub"> вместо {formatDate(fc.base.maturityDate)}</span>}
                </dd>
              </div>
              <div className="loan-total">
                <dt>Процентов ещё</dt>
                <dd>
                  {m(fc.totals.interestLeft)}
                  <span className="sub"> вместо {m(fc.base.interestLeft)}</span>
                </dd>
              </div>
              <div className="loan-total good" data-testid="forecast-savings">
                <dt>Экономия</dt>
                <dd>{m(fc.savings)}</dd>
              </div>
            </dl>
            <BalanceChart base={{ rows: detail.schedule, early: [] }} withEarly={{ rows: fc.rows, early: fc.early }} issueDate={c.issueDate} principal={c.principal} symbol={c.currencySymbol} minorUnits={mu} />
          </>
        ) : (
          <p className="muted">Добавьте плановые досрочки и сохраните: здесь появятся дата закрытия и экономия.</p>
        )}
      </div>
    </div>
  );
}

/** «А что если»: досрочка без записи — разбивка, новый платёж или срок, экономия. */
export function WhatIf({ card }: { card: DebtCard }) {
  const mu = card.minorUnits;
  const monthly = card.repaymentType !== "bullet";
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today());
  const [mode, setMode] = useState<RecalcMode>("reduce_term");
  const total = parseAmount(amount, mu);
  const key = useDebounced(total && total > 0 && /^\d{4}-\d{2}-\d{2}$/.test(date) ? { date, amount: total, mode } : null, 250);
  const q = useQuery({
    queryKey: ["whatIf", card.id, key],
    queryFn: () => api.quoteDebtPayment(card.id, { date: key!.date, amount: key!.amount, kind: "early", mode: monthly ? key!.mode : null }),
    enabled: !!key,
    retry: false,
    placeholderData: keepPreviousData,
  });
  const m = money(card);
  const r = key ? q.data : undefined;
  return (
    <div className="card" data-testid="whatif">
      <h2>
        А что если внести досрочно
        <Hint of="loan.whatif" />
      </h2>
      <div className="row">
        <Field label="Сумма">{(id) => <AmountInput id={id} name="whatIfAmount" value={amount} onChange={setAmount} minorUnits={mu} />}</Field>
        <Field label="Дата">{(id) => <input id={id} name="whatIfDate" type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
        {monthly && (
          <Field label="Что уменьшать">
            {(id) => (
              <select id={id} name="whatIfMode" value={mode} onChange={(e) => setMode(e.target.value as RecalcMode)}>
                {(Object.keys(MODES) as RecalcMode[]).map((x) => (
                  <option key={x} value={x}>
                    {MODES[x]}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
      </div>
      {q.error && key && <p className="hint warn">{String(q.error)}</p>}
      {r && !q.error && (
        <table className="table compact terms-diff" data-testid="whatif-result">
          <thead>
            <tr>
              <th></th>
              <th className="num">Сейчас</th>
              <th></th>
              <th className="num">После досрочки</th>
            </tr>
          </thead>
          <tbody>
            <Diff label="Платёж" was={m(r.before.totals.payment)} now={r.newPayment ? m(r.newPayment) : "погашен"} />
            <Diff label="Последний платёж" was={formatDate(r.before.totals.maturityDate)} now={formatDate(r.after.totals.maturityDate)} />
            <Diff label="Платежей осталось" was={r.before.totals.rowsLeft} now={r.after.totals.rowsLeft} />
            <Diff label="Процентов ещё" was={m(r.before.totals.interestLeft)} now={m(r.after.totals.interestLeft)} />
            <tr className="good" data-testid="whatif-savings">
              <td>Экономия</td>
              <td colSpan={3} className="num">
                <b>{m(Math.max(0, r.savings))}</b>
              </td>
            </tr>
          </tbody>
        </table>
      )}
      {r && !q.error && (
        <p className="hint">
          Из суммы {m(r.interest)} уйдёт в проценты за прошедшие дни, {m(r.principal)} — в основной долг. Ничего не записывается.
        </p>
      )}
    </div>
  );
}

/** «История»: снимки графика до каждого изменения, разница итогов и общая экономия. */
export function History({ card }: { card: DebtCard }) {
  const v = useQuery({ queryKey: ["debtVersions", card.id], queryFn: () => api.debtVersions(card.id) });
  const m = money(card);
  const d = v.data;
  if (!d) return null;
  const list = d.versions;
  const signed = (x: number) => (
    <span className={x < 0 ? "good-text" : x > 0 ? "over" : "muted"}>
      {x > 0 ? "+" : x < 0 ? "−" : ""}
      <Money amount={Math.abs(x)} symbol={card.currencySymbol} minorUnits={card.minorUnits} />
    </span>
  );
  const when = (iso: string) => {
    const t = new Date(iso);
    return Number.isNaN(t.getTime()) ? iso : t.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  };
  return (
    <div className="card" data-testid="history">
      <h2>
        История графика
        <Hint of="loan.history" />
      </h2>
      <div className="history-now">
        <div>
          <div className="muted">Сейчас</div>
          платёж <b>{m(d.current.payment)}</b>, проценты за весь срок <b>{m(d.current.totalInterest)}</b>, последний платёж <b>{formatDate(d.current.maturityDate)}</b>
        </div>
        <div className="history-savings" data-testid="history-savings">
          <div className="muted">Экономия за всё время</div>
          <b>{m(Math.max(0, d.savings))}</b>
          {d.savings < 0 && <div className="hint">переплата выросла на {m(-d.savings)}</div>}
        </div>
      </div>
      {list.length === 0 && <p className="muted">Изменений ещё не было.</p>}
      <ol className="history-list">
        {list
          .map((before, i) => ({ before, after: list[i + 1] ?? d.current, first: i === 0 }))
          .reverse()
          .map(({ before, after, first }) => {
            const same = after.totalInterest === before.totalInterest && after.payment === before.payment && after.maturityDate === before.maturityDate;
            return (
              <li key={before.id ?? before.createdAt} data-testid="version" className="fade-up">
                <div className="history-head">
                  <b>{before.reason}</b>
                  <span className="muted">{when(before.createdAt)}</span>
                </div>
                <div className="history-diff">
                  {first ? (
                    <span>
                      исходный график: платёж {m(before.payment)}, проценты за весь срок {m(before.totalInterest)}, последний платёж {formatDate(before.maturityDate)}
                    </span>
                  ) : same ? (
                    <span className="muted">итоги графика не изменились</span>
                  ) : (
                    <>
                      <span>проценты {signed(after.totalInterest - before.totalInterest)}</span>
                      {after.payment !== before.payment && (
                        <span>
                          платёж {m(before.payment)} → {m(after.payment)}
                        </span>
                      )}
                      {after.maturityDate !== before.maturityDate && (
                        <span>
                          закрытие {formatDate(before.maturityDate)} → {formatDate(after.maturityDate)}
                        </span>
                      )}
                    </>
                  )}
                </div>
              </li>
            );
          })}
      </ol>
    </div>
  );
}

/** Своя сумма неоплаченного платежа: больше или меньше графика; следующие пересчитываются. */
export function RowAmountForm({ detail, row, onClose }: { detail: DebtDetail; row: ScheduleRow; onClose: () => void }) {
  const c = detail.card;
  const own = detail.rowAmounts.find((a) => a.seq === row.seq);
  const [amount, setAmount] = useState(amountText(own?.amount ?? row.payment, c.minorUnits));
  const [mode, setMode] = useState<RecalcMode>(own?.mode ?? "reduce_term");
  const m = money(c);
  const save = useAction(
    async () => {
      const v = parseAmount(amount, c.minorUnits);
      if (v === null || v < 0) throw "Введите сумму платежа";
      return api.setDebtRowAmount(c.id, { seq: row.seq, amount: v, mode });
    },
    onClose,
    { celebrate: true },
  );
  const reset = useAction(() => api.deleteDebtRowAmount(own!.id), onClose);
  const v = parseAmount(amount, c.minorUnits);
  return (
    <Modal title={`Платёж №${row.seq}, ${formatDate(row.dueDate)}`} onClose={onClose}>
      <form className="form" onSubmit={(e) => (e.preventDefault(), save.run())}>
        <Field label="Сколько заплатить" help="loan.rowAmount" hint={`По графику ${amountText(row.payment, c.minorUnits)} ${c.currencySymbol}, из них проценты ${amountText(row.interestPart, c.minorUnits)} ${c.currencySymbol}`}>
          {(id) => <AmountInput id={id} name="rowAmount" value={amount} onChange={setAmount} minorUnits={c.minorUnits} autoFocus />}
        </Field>
        {v !== null && v < row.interestPart && <p className="hint warn">Меньше процентов: в этот раз уйдут только проценты {m(row.interestPart)}, долг не уменьшится.</p>}
        <div className="loan-method">
          <span className="loan-solve-label">Остальные платежи</span>
          <div className="tabs small" role="tablist" aria-label="Как пересчитать остальные платежи">
            {(Object.keys(MODES) as RecalcMode[]).map((x) => (
              <button key={x} type="button" role="tab" aria-selected={mode === x} className={mode === x ? "tab active" : "tab"} onClick={() => setMode(x)}>
                {MODES[x]}
              </button>
            ))}
          </div>
        </div>
        <p className="hint">Сумма пойдёт в график и напоминания. Прежний график сохранится в истории.</p>
        <ErrorText error={save.error ?? reset.error} />
        <div className="actions">
          {own && (
            <button type="button" className="link" onClick={() => reset.run()}>
              Вернуть сумму по графику
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn primary" aria-busy={save.busy} data-done={save.done || undefined} disabled={save.busy}>
            Сохранить
          </button>
        </div>
      </form>
    </Modal>
  );
}
