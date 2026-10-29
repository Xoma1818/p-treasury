import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Field } from "../components/Fields";
import { ErrorText, Modal } from "../components/Modal";
import { Money } from "../components/Money";
import { NotesBlock } from "../components/Notes";
import { api, REPAYMENTS, type DebtCard, type ScheduleRow } from "../lib/api";
import { formatDate } from "../lib/dates";
import { formatAmount } from "../lib/money";
import { METHODS } from "../lib/loan";
import { useUi } from "../lib/store";
import { useAction } from "../lib/useAction";
import { ScreenTitle } from "../components/SectionIcon";
import { Hint } from "../components/Hint";
import { LoanPlanner } from "./debts/LoanPlanner";
import { PayForm } from "./debts/PayForm";
import { ChangesList, History, HolidayForm, PlannedBlock, RateChangeForm, TermsForm, WhatIf } from "./debts/LoanTools";
import { ExportDialog, savedText } from "./debts/ExportDialog";

type View = { kind: "list" } | { kind: "detail"; id: string } | { kind: "plan"; example: boolean };

const rateText = (bp: number) => `${formatAmount(bp, 2)} %`;
const STATUS: Record<ScheduleRow["status"], string> = { pending: "ожидается", paid: "оплачен", partial: "оплачен частично" };

/** Раздел «Займы и долги»: сводка, список, карточка долга с графиком, калькулятор. */
export function Debts() {
  // Переход из напоминания или календаря открывает карточку долга (и отметку платежа).
  const jump = useUi((s) => s.debtJump);
  const [view, setView] = useState<View>(jump ? { kind: "detail", id: jump.id } : { kind: "list" });
  useEffect(() => {
    if (jump) useUi.setState({ debtJump: null });
  }, [jump]);

  return (
    <section className="screen wide debts-screen">
      {view.kind === "list" && <DebtList open={(id) => setView({ kind: "detail", id })} onNew={() => setView({ kind: "plan", example: false })} onCalc={() => setView({ kind: "plan", example: true })} />}
      {view.kind === "detail" && <DebtView id={view.id} back={() => setView({ kind: "list" })} payNow={jump?.id === view.id && jump.pay} />}
      {view.kind === "plan" && <LoanPlanner key={String(view.example)} example={view.example} back={() => setView({ kind: "list" })} onCreated={(id) => setView({ kind: "detail", id })} />}
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
        <ScreenTitle id="debts" />
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
            <div className="tile-label">
              Чистые активы
              <Hint of="debts.net" />
            </div>
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
          <h2>
            Все долги
            <Hint of="debts.all" />
          </h2>
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

type Tab = "schedule" | "planned" | "whatif" | "history";
const TABS: [Tab, string][] = [
  ["schedule", "График"],
  ["planned", "Досрочки и прогноз"],
  ["whatif", "А что если"],
  ["history", "История"],
];
type Dialog = "pay" | "early" | "terms" | "rate" | "holiday" | "export" | "rename" | null;

function DebtView({ id, back, payNow }: { id: string; back: () => void; payNow?: boolean }) {
  const detail = useQuery({ queryKey: ["debt", id], queryFn: () => api.getDebt(id) });
  const [dialog, setDialog] = useState<Dialog>(payNow ? "pay" : null);
  const [tab, setTab] = useState<Tab>("schedule");
  const [confirm, setConfirm] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const remove = useAction(() => api.deleteDebt(id), back);
  const removePayment = useAction((pid: string) => api.deleteDebtPayment(pid));
  const d = detail.data;
  if (detail.error) return <p className="error">{String(detail.error)}</p>;
  if (!d) return null;
  const c = d.card;
  const m = (v: number) => <Money amount={v} symbol={c.currencySymbol} minorUnits={c.minorUnits} />;
  const lent = c.direction === "lent";
  const active = c.status === "active";
  const close = () => setDialog(null);
  const tabs = TABS.filter(([t]) => active || (t !== "whatif" && t !== "planned"));

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
          {active && (
            <>
              <button className="btn" onClick={() => setDialog("early")}>
                {c.repaymentType === "bullet" ? "Частичный возврат" : "Досрочный платёж"}
              </button>
              {c.nextPayment && (
                <button className="btn primary" onClick={() => setDialog("pay")}>
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
          {c.nextPayment && active && (
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
          <dd data-testid="debt-terms">
            {c.rateBp ? `${rateText(c.rateBp)} годовых` : "без процентов"}, {REPAYMENTS[c.repaymentType].toLowerCase()}
            {c.termMonths ? `, ${c.termMonths} мес.` : ""}, до {formatDate(c.maturityDate)}
          </dd>
          {c.rateBp > 0 && (
            <>
              <dt>Проценты</dt>
              <dd>{METHODS[c.interestMethod]}</dd>
            </>
          )}
          {c.note && (
            <>
              <dt>Комментарий</dt>
              <dd>{c.note}</dd>
            </>
          )}
        </dl>
        <ChangesList detail={d} />
        <div className="actions loan-card-actions">
          {active && (
            <>
              <span className="btn-with-hint">
                <button className="btn small" onClick={() => setDialog("terms")}>
                  Изменить условия
                </button>
                <Hint of="loan.terms" />
              </span>
              {c.rateBp > 0 || c.repaymentType !== "bullet" ? (
                <span className="btn-with-hint">
                  <button className="btn small" onClick={() => setDialog("rate")}>
                    Ставка изменилась
                  </button>
                  <Hint of="loan.rateChanged" />
                </span>
              ) : null}
              {c.repaymentType !== "bullet" && (
                <span className="btn-with-hint">
                  <button className="btn small" onClick={() => setDialog("holiday")}>
                    Каникулы
                  </button>
                  <Hint of="loan.holiday" />
                </span>
              )}
            </>
          )}
          <span className="btn-with-hint">
            <button className="btn small" onClick={() => (setStatus(null), setDialog("export"))}>
              Скачать график
            </button>
            <Hint of="loan.download" />
          </span>
          <button className="link" onClick={() => setDialog("rename")}>
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
        {status && (
          <p className="hint ok" data-testid="export-status">
            {status}
          </p>
        )}
        <ErrorText error={remove.error} />
      </div>

      <div className="tabs small loan-tabs" role="tablist" aria-label="Разделы займа">
        {tabs.map(([t, label]) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "tab active" : "tab"} data-testid={`tab-${t}`} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "schedule" && (
        <div className="columns debt-columns">
          <div className="card">
            <h2>
              График платежей
              <Hint of="debts.schedule" />
            </h2>
            <div className="table-scroll">
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
      )}
      {tab === "planned" && active && <PlannedBlock key={d.plannedEarly.map((p) => p.id).join()} detail={d} />}
      {tab === "whatif" && active && <WhatIf card={c} />}
      {tab === "history" && <History card={c} />}

      <div className="card">
        <NotesBlock filter={{ debtId: c.id }} initial={{ debtId: c.id }} />
      </div>

      {dialog === "pay" && c.nextPayment && <PayForm card={c} early={false} onClose={close} />}
      {dialog === "early" && <PayForm card={c} early onClose={close} />}
      {dialog === "terms" && <TermsForm detail={d} onClose={close} />}
      {dialog === "rate" && <RateChangeForm card={c} onClose={close} />}
      {dialog === "holiday" && <HolidayForm detail={d} onClose={close} />}
      {dialog === "export" && <ExportDialog source={{ kind: "debt", card: c }} format="pdf" onClose={close} onSaved={(p) => (close(), setStatus(savedText(p)))} />}
      {dialog === "rename" && <RenameForm card={c} onClose={close} />}
    </>
  );
}

function RenameForm({ card, onClose }: { card: DebtCard; onClose: () => void }) {
  const [name, setName] = useState(card.counterparty);
  const [note, setNote] = useState(card.note ?? "");
  const save = useAction(() => api.updateDebtInfo(card.id, name, note || null), onClose, { celebrate: true });
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
