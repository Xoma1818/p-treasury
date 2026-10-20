import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { AccountSelect, AmountInput, amountText, Field } from "../components/Fields";
import { ErrorText, Modal } from "../components/Modal";
import { Money } from "../components/Money";
import { NotesBlock } from "../components/Notes";
import {
  api,
  REPAYMENTS,
  type DebtCard,
  type DebtInput,
  type Direction,
  type LoanInput,
  type PaymentInput,
  type Repayment,
  type Schedule,
  type ScheduleRow,
} from "../lib/api";
import { formatDate, today } from "../lib/dates";
import { formatAmount, parseAmount } from "../lib/money";
import { useAccounts, useCurrencies, useSettings } from "../lib/queries";
import { useUi } from "../lib/store";
import { useAction } from "../lib/useAction";

type View = { kind: "list" } | { kind: "detail"; id: string } | { kind: "calc" };

const rateText = (bp: number) => `${formatAmount(bp, 2)} %`;
const STATUS: Record<ScheduleRow["status"], string> = { pending: "ожидается", paid: "оплачен", partial: "оплачен частично" };

/** Раздел «Долги»: сводка, список, карточка долга с графиком, калькулятор. */
export function Debts() {
  // Переход из напоминания или календаря открывает карточку долга (и отметку платежа).
  const jump = useUi((s) => s.debtJump);
  const [view, setView] = useState<View>(jump ? { kind: "detail", id: jump.id } : { kind: "list" });
  useEffect(() => {
    if (jump) useUi.setState({ debtJump: null });
  }, [jump]);
  const [form, setForm] = useState<Partial<DebtInput> | null>(null);

  return (
    <section className="screen wide">
      {view.kind === "list" && <DebtList open={(id) => setView({ kind: "detail", id })} onNew={() => setForm({})} onCalc={() => setView({ kind: "calc" })} />}
      {view.kind === "detail" && <DebtView id={view.id} back={() => setView({ kind: "list" })} payNow={jump?.id === view.id && jump.pay} />}
      {view.kind === "calc" && <Calculator back={() => setView({ kind: "list" })} onSave={(p) => setForm(p)} />}
      {form && (
        <DebtForm
          initial={form}
          onClose={() => setForm(null)}
          onCreated={(id) => {
            setForm(null);
            setView({ kind: "detail", id });
          }}
        />
      )}
    </section>
  );
}

function DebtList({ open, onNew, onCalc }: { open: (id: string) => void; onNew: () => void; onCalc: () => void }) {
  const debts = useQuery({ queryKey: ["debts"], queryFn: api.listDebts });
  const summary = useQuery({ queryKey: ["debtSummary"], queryFn: api.debtSummary });
  const s = summary.data;
  const sym = s?.baseSymbol ?? "₽";
  const list = debts.data ?? [];

  return (
    <>
      <div className="screen-head">
        <h1>Долги</h1>
        <div className="btn-group">
          <button className="btn" onClick={onCalc}>
            Калькулятор
          </button>
          <button className="btn primary" onClick={onNew}>
            + Новый долг
          </button>
        </div>
      </div>
      {s && (
        <div className="tiles">
          <div className="card tile" data-testid="owed-to-me">
            <div className="tile-label">Мне должны</div>
            <div className="tile-value plus">
              <Money amount={s.owedToMe} symbol={sym} />
            </div>
          </div>
          <div className="card tile" data-testid="i-owe">
            <div className="tile-label">Я должен</div>
            <div className="tile-value">
              <Money amount={s.iOwe} symbol={sym} />
            </div>
          </div>
          <div className="card tile" data-testid="debts-net">
            <div className="tile-label">Итог по долгам</div>
            <div className={s.owedToMe - s.iOwe < 0 ? "tile-value over" : "tile-value"}>
              <Money amount={s.owedToMe - s.iOwe} symbol={sym} signed />
            </div>
          </div>
          <div className="card tile" data-testid="net-worth">
            <div className="tile-label">Чистые активы</div>
            <div className="tile-value">
              <Money amount={s.netWorth} symbol={sym} />
            </div>
            <div className="hint">счета плюс долги мне минус мои долги</div>
          </div>
        </div>
      )}
      {s && s.missingRates.length > 0 && <div className="card hint warn">Нет курса для {s.missingRates.join(", ")}: такие суммы не вошли в итоги.</div>}

      <div className="columns home">
        <div className="card" data-testid="upcoming">
          <h2>Ближайшие платежи</h2>
          {s && s.upcoming.length === 0 && <p className="muted">Платежей по графику нет.</p>}
          <ul className="account-list">
            {s?.upcoming.map((u) => (
              <li key={u.scheduleId} className={u.overdue ? "clickable over" : "clickable"} onClick={() => open(u.debtId)}>
                <span>
                  <span className="main">{formatDate(u.dueDate)}</span> · {u.counterparty}
                  {u.overdue && <span className="badge over">просрочен</span>}
                </span>
                <Money amount={u.payment} symbol={u.currencySymbol} minorUnits={u.minorUnits} />
              </li>
            ))}
          </ul>
        </div>
        <div className="card">
          <h2>Все долги</h2>
          {list.length === 0 && <p className="muted">Долгов нет. Добавьте кредит или деньги, которые вы дали в долг.</p>}
          {list.length > 0 && (
            <table className="table">
              <tbody>
                {list.map((d) => (
                  <tr key={d.id} className={d.status === "closed" ? "clickable archived" : "clickable"} data-testid="debt-row" data-name={d.counterparty} onClick={() => open(d.id)}>
                    <td>
                      <div className="main">{d.counterparty}</div>
                      <div className="sub">
                        {d.direction === "lent" ? "Я дал" : "Я взял"} · {d.rateBp ? rateText(d.rateBp) : "без процентов"} · {REPAYMENTS[d.repaymentType].split(" (")[0].toLowerCase()}
                      </div>
                    </td>
                    <td className="num">
                      <div className={d.direction === "lent" ? "plus" : undefined}>
                        <Money amount={d.outstanding} symbol={d.currencySymbol} minorUnits={d.minorUnits} />
                      </div>
                      <div className="sub">
                        из <Money amount={d.principal} symbol={d.currencySymbol} minorUnits={d.minorUnits} />
                      </div>
                    </td>
                    <td className="num">
                      {d.status === "closed" ? (
                        <span className="muted">погашен</span>
                      ) : d.nextPayment ? (
                        <>
                          <div className={d.overdueCount ? "over" : undefined}>{formatDate(d.nextPayment.dueDate)}</div>
                          <div className="sub">
                            <Money amount={d.nextPayment.payment} symbol={d.currencySymbol} minorUnits={d.minorUnits} />
                          </div>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

function DebtView({ id, back, payNow }: { id: string; back: () => void; payNow?: boolean }) {
  const detail = useQuery({ queryKey: ["debt", id], queryFn: () => api.getDebt(id) });
  const [pay, setPay] = useState<"scheduled" | "early" | null>(payNow ? "scheduled" : null);
  const [confirm, setConfirm] = useState(false);
  const [rename, setRename] = useState(false);
  const remove = useAction(() => api.deleteDebt(id), back);
  const removePayment = useAction((pid: string) => api.deleteDebtPayment(pid));
  const d = detail.data;
  if (detail.error) return <p className="error">{String(detail.error)}</p>;
  if (!d) return null;
  const c = d.card;
  const m = (v: number) => <Money amount={v} symbol={c.currencySymbol} minorUnits={c.minorUnits} />;
  const lent = c.direction === "lent";

  return (
    <>
      <button className="link back" onClick={back}>
        ← Все долги
      </button>
      <div className="screen-head">
        <h1>
          {c.counterparty}
          <span className="sub-title">{lent ? "я дал в долг" : "я взял в долг"}</span>
        </h1>
        <div className="btn-group">
          {c.status === "active" && (
            <>
              <button className="btn" onClick={() => setPay("early")}>
                {c.repaymentType === "bullet" ? "Частичный возврат" : "Досрочный платёж"}
              </button>
              {c.nextPayment && (
                <button className="btn primary" onClick={() => setPay("scheduled")}>
                  Оплачено
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <div className="tiles">
        <div className="card tile" data-testid="debt-outstanding">
          <div className="tile-label">Остаток</div>
          <div className="tile-value">{m(c.outstanding)}</div>
          <div className="hint">
            {lent ? "выдано" : "взято"} {m(c.principal)} {formatDate(c.issueDate)}
          </div>
        </div>
        <div className="card tile">
          <div className="tile-label">{lent ? "Вернули" : "Вернул"}</div>
          <div className="tile-value">{m(c.principalPaid)}</div>
        </div>
        <div className="card tile" data-testid="debt-interest">
          <div className="tile-label">Проценты</div>
          <div className="tile-value">{m(c.interestPaid)}</div>
          <div className="hint">уплачено, ещё по графику {m(c.interestPlanned)}</div>
        </div>
        <div className="card tile" data-testid="debt-next">
          <div className="tile-label">{c.status === "closed" ? "Статус" : "Следующий платёж"}</div>
          <div className={c.overdueCount ? "tile-value over" : "tile-value"}>{c.status === "closed" ? "Погашен" : c.nextPayment ? m(c.nextPayment.payment) : "—"}</div>
          {c.nextPayment && c.status === "active" && (
            <div className={c.overdueCount ? "hint warn" : "hint"}>
              {formatDate(c.nextPayment.dueDate)}
              {c.overdueCount > 0 && `, просрочено платежей: ${c.overdueCount}`}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <dl className="facts">
          <dt>Условия</dt>
          <dd>
            {c.rateBp ? `${rateText(c.rateBp)} годовых` : "без процентов"}, {REPAYMENTS[c.repaymentType].toLowerCase()}
            {c.termMonths ? `, ${c.termMonths} мес.` : ""}, до {formatDate(c.maturityDate)}
          </dd>
          {c.note && (
            <>
              <dt>Комментарий</dt>
              <dd>{c.note}</dd>
            </>
          )}
        </dl>
        <div className="actions">
          <button className="link" onClick={() => setRename(true)}>
            Изменить название и комментарий
          </button>
          <span className="spacer" />
          {confirm ? (
            <>
              <span className="muted">Удалятся долг, его график и все его операции.</span>
              <button className="btn danger small" onClick={() => remove.run()}>
                Да, удалить
              </button>
              <button className="btn small" onClick={() => setConfirm(false)}>
                Отмена
              </button>
            </>
          ) : (
            <button className="link danger" onClick={() => setConfirm(true)}>
              Удалить долг
            </button>
          )}
        </div>
        <ErrorText error={remove.error} />
      </div>

      <div className="columns debt-columns">
        <div className="card">
          <h2>График платежей</h2>
          <table className="table compact schedule" data-testid="schedule">
            <thead>
              <tr>
                <th>№</th>
                <th>Дата</th>
                <th className="num">Платёж</th>
                <th className="num">Основной долг</th>
                <th className="num">Проценты</th>
                <th className="num">Остаток</th>
                <th>Статус</th>
              </tr>
            </thead>
            <tbody>
              {d.schedule.map((r) => (
                <tr key={r.id} className={r.overdue ? "overdue" : r.status !== "pending" ? "done" : undefined} data-testid="schedule-row">
                  <td>{r.seq}</td>
                  <td>{formatDate(r.dueDate)}</td>
                  <td className="num">{m(r.payment)}</td>
                  <td className="num">{m(r.principalPart)}</td>
                  <td className="num">{m(r.interestPart)}</td>
                  <td className="num">{m(r.balanceAfter)}</td>
                  <td className="status">{r.overdue ? "просрочен" : STATUS[r.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card">
          <h2>Платежи</h2>
          {d.payments.length === 0 && <p className="muted">Платежей ещё не было.</p>}
          <ul className="account-list" data-testid="payments">
            {d.payments.map((p) => (
              <li key={p.id}>
                <span>
                  <span className="main">{formatDate(p.date)}</span>
                  <span className="sub">
                    {" "}
                    {p.scheduleSeq ? `по графику №${p.scheduleSeq}` : lent ? "возврат" : "досрочно"}
                    {p.accountName && `, ${p.accountName}`}
                    {p.interest > 0 && <>, проценты {m(p.interest)}</>}
                  </span>
                </span>
                <span>
                  {m(p.principal + p.interest)}
                  <button className="link danger" title="Удалить платёж и его операции" onClick={() => removePayment.run(p.id)}>
                    ×
                  </button>
                </span>
              </li>
            ))}
          </ul>
          <ErrorText error={removePayment.error} />
        </div>
      </div>

      <div className="card">
        <NotesBlock filter={{ debtId: c.id }} initial={{ debtId: c.id }} />
      </div>

      {pay && (pay === "early" || c.nextPayment) && <PayForm card={c} scheduled={pay === "scheduled"} onClose={() => setPay(null)} />}
      {rename && <RenameForm card={c} onClose={() => setRename(false)} />}
    </>
  );
}

function PayForm({ card, scheduled, onClose }: { card: DebtCard; scheduled: boolean; onClose: () => void }) {
  const accounts = (useAccounts().data ?? []).filter((a) => a.currencyCode === card.currencyCode);
  const next = scheduled ? card.nextPayment : null;
  const mu = card.minorUnits;
  const [date, setDate] = useState(next && next.dueDate < today() ? next.dueDate : today());
  const [accountId, setAccountId] = useState(card.defaultAccountId ?? "");
  const [principal, setPrincipal] = useState(amountText(next?.principalPart ?? null, mu));
  const [interest, setInterest] = useState(amountText(next ? next.interestPart : 0, mu));
  const [mode, setMode] = useState<"reduce_payment" | "reduce_term">("reduce_payment");
  useEffect(() => {
    if (!accountId && accounts[0]) setAccountId(accounts[0].id);
  }, [accounts, accountId]);
  const save = useAction((input: PaymentInput) => api.payDebt(card.id, input), onClose);
  const lent = card.direction === "lent";
  const p = parseAmount(principal, mu);
  const i = parseAmount(interest || "0", mu);
  const differs = next ? p !== next.principalPart : true;
  const monthly = card.repaymentType !== "bullet";

  const submit = () => {
    if (p === null || p < 0 || i === null || i < 0) return save.setError("Проверьте суммы");
    if (!accountId) return save.setError(`Выберите счёт в ${card.currencyCode}`);
    save.run({ date, accountId, principal: p, interest: i, scheduleId: next?.id ?? null, recalcMode: monthly && differs ? mode : null });
  };

  return (
    <Modal title={scheduled ? "Платёж по графику" : card.repaymentType === "bullet" ? "Частичный возврат" : "Досрочный платёж"} onClose={onClose}>
      <form className="form" onSubmit={(e) => (e.preventDefault(), submit())}>
        <div className="row">
          <Field label="Дата">{(id) => <input id={id} name="payDate" type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
          <Field label={lent ? "Зачислить на счёт" : "Списать со счёта"}>
            {(id) => <AccountSelect id={id} name="payAccount" accounts={accounts} value={accountId} onChange={setAccountId} />}
          </Field>
        </div>
        <div className="row">
          <Field label="Основной долг" hint={`Остаток ${formatAmount(card.outstanding, mu)} ${card.currencySymbol}`}>
            {(id) => <AmountInput id={id} name="principal" value={principal} onChange={setPrincipal} minorUnits={mu} autoFocus />}
          </Field>
          <Field label="Проценты" hint={lent ? "доход «Проценты по займам»" : "расход «Проценты по кредитам»"}>
            {(id) => <AmountInput id={id} name="interest" value={interest} onChange={setInterest} minorUnits={mu} />}
          </Field>
        </div>
        {monthly && differs && (
          <Field label="Как пересчитать оставшийся график">
            {(id) => (
              <select id={id} name="recalcMode" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
                <option value="reduce_payment">Уменьшить платёж, срок прежний</option>
                <option value="reduce_term">Уменьшить срок, платёж прежний</option>
              </select>
            )}
          </Field>
        )}
        <p className="hint">
          Основной долг запишется переводом {lent ? "со счёта долга на ваш счёт" : "с вашего счёта на счёт долга"}, проценты отдельной операцией.
        </p>
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

function RenameForm({ card, onClose }: { card: DebtCard; onClose: () => void }) {
  const [name, setName] = useState(card.counterparty);
  const [note, setNote] = useState(card.note ?? "");
  const save = useAction(() => api.updateDebtInfo(card.id, name, note || null), onClose);
  return (
    <Modal title="Долг" onClose={onClose}>
      <form className="form" onSubmit={(e) => (e.preventDefault(), save.run())}>
        <Field label="Кто должен или кому">{(id) => <input id={id} name="counterparty" value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Комментарий">{(id) => <input id={id} name="note" value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        <ErrorText error={save.error} />
        <div className="actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn primary">
            Сохранить
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Параметры кредита из полей формы; null, если чего-то не хватает. */
function loanFrom(f: { amount: string; rate: string; term: string; repayment: Repayment; issueDate: string; firstPayment: string; maturity: string }, minorUnits = 2): LoanInput | null {
  const principal = parseAmount(f.amount, minorUnits);
  const rateBp = f.rate.trim() === "" ? 0 : parseAmount(f.rate, 2);
  const term = Number(f.term);
  if (!principal || principal <= 0 || rateBp === null || rateBp < 0) return null;
  if (f.repayment === "bullet") {
    if (!f.maturity) return null;
    return { principal, rateBp, repayment: "bullet", termMonths: null, issueDate: f.issueDate, firstPaymentDate: null, maturityDate: f.maturity };
  }
  if (!Number.isInteger(term) || term < 1) return null;
  return { principal, rateBp, repayment: f.repayment, termMonths: term, issueDate: f.issueDate, firstPaymentDate: f.firstPayment || null, maturityDate: null };
}

function DebtForm({ initial, onClose, onCreated }: { initial: Partial<DebtInput>; onClose: () => void; onCreated: (id: string) => void }) {
  const currencies = useCurrencies().data ?? [];
  const base = useSettings().data?.base_currency ?? "RUB";
  const allAccounts = useAccounts().data ?? [];
  const [direction, setDirection] = useState<Direction>(initial.direction ?? "borrowed");
  const [counterparty, setCounterparty] = useState(initial.counterparty ?? "");
  const [currency, setCurrency] = useState(initial.currencyCode ?? base);
  const mu = currencies.find((c) => c.code === currency)?.minorUnits ?? 2;
  const [f, setF] = useState({
    amount: amountText(initial.principal ?? null, mu),
    rate: initial.rateBp ? formatAmount(initial.rateBp, 2) : "",
    term: initial.termMonths ? String(initial.termMonths) : "",
    repayment: initial.repaymentType ?? ("annuity" as Repayment),
    issueDate: initial.issueDate ?? today(),
    firstPayment: initial.firstPaymentDate ?? "",
    maturity: initial.maturityDate ?? "",
  });
  const [accountId, setAccountId] = useState<string>("");
  const [note, setNote] = useState("");
  const accounts = allAccounts.filter((a) => a.currencyCode === currency);
  const set = (patch: Partial<typeof f>) => setF((cur) => ({ ...cur, ...patch }));
  const loan = loanFrom(f, mu);
  const preview = useQuery({ queryKey: ["calcLoan", loan], queryFn: () => api.calcLoan(loan!), enabled: !!loan, retry: false });
  const save = useAction(async (input: DebtInput) => onCreated(await api.createDebt(input)));
  const sym = currencies.find((c) => c.code === currency)?.symbol ?? "";

  const submit = () => {
    if (!counterparty.trim()) return save.setError("Укажите, кто должен или кому");
    if (!loan) return save.setError(f.repayment === "bullet" ? "Введите сумму и дату возврата" : "Введите сумму и срок в месяцах");
    save.run({
      direction,
      counterparty,
      note: note || null,
      currencyCode: currency,
      principal: loan.principal,
      issueDate: loan.issueDate,
      rateBp: loan.rateBp,
      repaymentType: loan.repayment,
      termMonths: loan.termMonths,
      firstPaymentDate: loan.firstPaymentDate,
      maturityDate: loan.maturityDate,
      accountId: accountId || null,
    });
  };

  return (
    <Modal title="Новый долг" onClose={onClose} wide>
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
          <Field label="Сумма">{(id) => <AmountInput id={id} name="principal" value={f.amount} onChange={(v) => set({ amount: v })} minorUnits={mu} />}</Field>
          <Field label="Валюта">
            {(id) => (
              <select id={id} name="currency" value={currency} onChange={(e) => (setCurrency(e.target.value), setAccountId(""))}>
                {currencies.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <div className="row">
          <Field label="Дата выдачи">{(id) => <input id={id} name="issueDate" type="date" value={f.issueDate} onChange={(e) => set({ issueDate: e.target.value })} />}</Field>
          <Field label={direction === "lent" ? "С какого счёта выдал" : "На какой счёт получил"} hint="Без счёта долг запишется без операции, например старый кредит">
            {(id) => <AccountSelect id={id} name="account" accounts={accounts} value={accountId} onChange={setAccountId} placeholder="Без операции" />}
          </Field>
        </div>
        <div className="row">
          <Field label="Ставка, % годовых" hint="0 или пусто — без процентов">
            {(id) => <input id={id} name="rate" className="amount" inputMode="decimal" value={f.rate} onChange={(e) => set({ rate: e.target.value })} placeholder="0" />}
          </Field>
          <Field label="Погашение">
            {(id) => (
              <select id={id} name="repayment" value={f.repayment} onChange={(e) => set({ repayment: e.target.value as Repayment })}>
                {(Object.keys(REPAYMENTS) as Repayment[]).map((r) => (
                  <option key={r} value={r}>
                    {REPAYMENTS[r]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {f.repayment === "bullet" ? (
            <Field label="Вернуть до">{(id) => <input id={id} name="maturity" type="date" value={f.maturity} onChange={(e) => set({ maturity: e.target.value })} />}</Field>
          ) : (
            <>
              <Field label="Срок, месяцев">{(id) => <input id={id} name="term" inputMode="numeric" value={f.term} onChange={(e) => set({ term: e.target.value })} />}</Field>
              <Field label="Первый платёж" hint="По умолчанию через месяц">
                {(id) => <input id={id} name="firstPayment" type="date" value={f.firstPayment} onChange={(e) => set({ firstPayment: e.target.value })} />}
              </Field>
            </>
          )}
        </div>
        <Field label="Комментарий">{(id) => <input id={id} name="debtNote" value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        {preview.data && (
          <div className="card preview" data-testid="debt-preview">
            {f.repayment === "bullet" ? "К возврату" : "Платёж"}{" "}
            <b>
              {formatAmount(preview.data.firstPayment, mu)} {sym}
            </b>
            {preview.data.lastPayment !== preview.data.firstPayment && f.repayment !== "bullet" && (
              <>
                {" "}
                (последний {formatAmount(preview.data.lastPayment, mu)} {sym})
              </>
            )}
            , переплата{" "}
            <b>
              {formatAmount(preview.data.totalInterest, mu)} {sym}
            </b>
            , до {formatDate(preview.data.maturityDate)}
          </div>
        )}
        {preview.error && <p className="hint warn">{String(preview.error)}</p>}
        <ErrorText error={save.error} />
        <div className="actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn primary">
            Сохранить
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Calculator({ back, onSave }: { back: () => void; onSave: (p: Partial<DebtInput>) => void }) {
  const [f, setF] = useState({ amount: "300000", rate: "18", term: "24", repayment: "annuity" as Repayment, issueDate: today(), firstPayment: "", maturity: "" });
  const [shown, setShown] = useState<"annuity" | "differentiated">("annuity");
  const set = (patch: Partial<typeof f>) => setF((cur) => ({ ...cur, ...patch }));
  const loan = loanFrom(f);
  const cmp = useQuery({ queryKey: ["compareLoans", loan], queryFn: () => api.compareLoans(loan!), enabled: !!loan, retry: false });
  const sym = "₽";
  const variant = (key: "annuity" | "differentiated", title: string, s: Schedule, other: Schedule) => (
    <div className={shown === key ? "card variant active" : "card variant"} data-testid={`calc-${key}`} onClick={() => setShown(key)}>
      <h2>{title}</h2>
      <dl className="facts">
        <dt>Платёж</dt>
        <dd className="big">
          {formatAmount(s.firstPayment)} {sym}
          {s.lastPayment !== s.firstPayment && key === "differentiated" && (
            <span className="sub">
              {" "}
              → {formatAmount(s.lastPayment)} {sym}
            </span>
          )}
        </dd>
        <dt>Переплата</dt>
        <dd data-testid="overpay">
          {formatAmount(s.totalInterest)} {sym}
          {s.totalInterest < other.totalInterest && <span className="badge good">дешевле на {formatAmount(other.totalInterest - s.totalInterest)} {sym}</span>}
        </dd>
        <dt>Всего выплатить</dt>
        <dd>
          {formatAmount(s.totalPayment)} {sym}
        </dd>
      </dl>
      <button
        className="btn small"
        onClick={(e) => {
          e.stopPropagation();
          onSave({ direction: "borrowed", principal: loan!.principal, rateBp: loan!.rateBp, termMonths: loan!.termMonths, repaymentType: key, issueDate: loan!.issueDate, firstPaymentDate: loan!.firstPaymentDate });
        }}
      >
        Сохранить как долг
      </button>
    </div>
  );
  const s = cmp.data?.[shown];

  return (
    <>
      <button className="link back" onClick={back}>
        ← Все долги
      </button>
      <div className="screen-head">
        <h1>Калькулятор кредита</h1>
      </div>
      <div className="card">
        <div className="row">
          <Field label="Сумма, ₽">{(id) => <AmountInput id={id} name="calcAmount" value={f.amount} onChange={(v) => set({ amount: v })} />}</Field>
          <Field label="Ставка, % годовых">{(id) => <input id={id} name="calcRate" className="amount" inputMode="decimal" value={f.rate} onChange={(e) => set({ rate: e.target.value })} />}</Field>
          <Field label="Срок, месяцев">{(id) => <input id={id} name="calcTerm" inputMode="numeric" value={f.term} onChange={(e) => set({ term: e.target.value })} />}</Field>
          <Field label="Дата выдачи">{(id) => <input id={id} name="calcIssue" type="date" value={f.issueDate} onChange={(e) => set({ issueDate: e.target.value })} />}</Field>
        </div>
        {cmp.error && <p className="hint warn">{String(cmp.error)}</p>}
        {!loan && <p className="hint">Введите сумму, ставку и срок.</p>}
      </div>
      {cmp.data && (
        <div className="columns variants">
          {variant("annuity", "Аннуитет: равные платежи", cmp.data.annuity, cmp.data.differentiated)}
          {variant("differentiated", "Дифференцированный: платёж уменьшается", cmp.data.differentiated, cmp.data.annuity)}
        </div>
      )}
      {s && (
        <div className="card">
          <h2>График: {shown === "annuity" ? "аннуитет" : "дифференцированный"}</h2>
          <table className="table compact schedule">
            <thead>
              <tr>
                <th>№</th>
                <th>Дата</th>
                <th className="num">Платёж</th>
                <th className="num">Основной долг</th>
                <th className="num">Проценты</th>
                <th className="num">Остаток</th>
              </tr>
            </thead>
            <tbody>
              {s.rows.map((r) => (
                <tr key={r.seq}>
                  <td>{r.seq}</td>
                  <td>{formatDate(r.dueDate)}</td>
                  <td className="num">{formatAmount(r.payment)}</td>
                  <td className="num">{formatAmount(r.principalPart)}</td>
                  <td className="num">{formatAmount(r.interestPart)}</td>
                  <td className="num">{formatAmount(r.balanceAfter)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
