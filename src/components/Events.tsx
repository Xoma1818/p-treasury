import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type BudgetEvent } from "../lib/api";
import { formatDate, today } from "../lib/dates";
import { formatAmount, parseAmount } from "../lib/money";
import { useSettings, useCurrencies } from "../lib/queries";
import { useUi } from "../lib/store";
import { useAction } from "../lib/useAction";
import { AmountInput, amountText, Field } from "./Fields";
import { ErrorText, Modal } from "./Modal";
import { Money } from "./Money";

const STATE: Record<BudgetEvent["state"], string> = { upcoming: "скоро", current: "идёт сейчас", past: "прошло" };

/** Поездки и события в «Бюджете»: свой бюджет и итог, отдельно от месяца. */
export function EventsCard() {
  const events = useQuery({ queryKey: ["events"], queryFn: api.listEvents }).data ?? [];
  const [editing, setEditing] = useState<BudgetEvent | "new" | null>(null);
  const showTransactions = useUi((s) => s.showTransactions);
  const addAll = useAction(async (e: BudgetEvent) => api.assignEvent(e.id, await api.eventCandidates(e.id)));

  return (
    <div className="card" data-testid="events">
      <div className="screen-head">
        <h2>Поездки и события</h2>
        <button className="btn small" onClick={() => setEditing("new")}>
          + Событие
        </button>
      </div>
      {events.length === 0 && (
        <p className="muted">Отпуск, ремонт, свадьба: задайте даты и бюджет, и траты этих дней соберутся в отдельный итог.</p>
      )}
      <ul className="event-list">
        {events.map((e) => {
          const pct = e.budget ? Math.round((e.spent / e.budget) * 100) : null;
          return (
            <li key={e.id} data-testid="event-row" data-name={e.name}>
              <div className="event-main">
                <button className="link main" onClick={() => setEditing(e)}>
                  {e.name}
                </button>
                <span className="sub">
                  {formatDate(e.startDate)} — {formatDate(e.endDate)} · {STATE[e.state]}
                </span>
              </div>
              <div className="event-sum">
                <span data-testid="event-spent">
                  <Money amount={e.spent} symbol={e.baseSymbol} minorUnits={e.baseMinorUnits} />
                  {e.budget != null && (
                    <span className="muted">
                      {" "}
                      из {formatAmount(e.budget, e.baseMinorUnits)} {e.baseSymbol}
                    </span>
                  )}
                </span>
                {pct != null && (
                  <span className={pct > 100 ? "bar over" : "bar"}>
                    <span style={{ width: `${Math.min(pct, 100)}%` }} />
                  </span>
                )}
              </div>
              <div className="event-actions">
                {e.count > 0 && (
                  <button className="link" onClick={() => showTransactions({ eventId: e.id })}>
                    Операции: {e.count}
                  </button>
                )}
                {e.unassigned > 0 && (
                  <button className="link" data-testid="event-add-all" onClick={() => addAll.run(e)} title="Расходы в дни события, ещё не отнесённые к нему">
                    + {e.unassigned} {e.unassigned === 1 ? "трата" : e.unassigned < 5 ? "траты" : "трат"} этих дней
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <ErrorText error={addAll.error} />
      {editing && <EventForm event={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function EventForm({ event, onClose }: { event: BudgetEvent | null; onClose: () => void }) {
  const base = useSettings().data?.base_currency ?? "RUB";
  const currency = useCurrencies().data?.find((c) => c.code === base);
  const minor = currency?.minorUnits ?? 2;
  const [name, setName] = useState(event?.name ?? "");
  const [start, setStart] = useState(event?.startDate ?? today());
  const [end, setEnd] = useState(event?.endDate ?? today());
  const [budget, setBudget] = useState(amountText(event?.budget ?? null, minor));
  const save = useAction(async (b: number | null) => {
    const input = { name, startDate: start, endDate: end, budget: b, note: event?.note ?? null };
    if (event) return api.updateEvent(event.id, input);
    await api.createEvent(input);
  }, onClose);
  const remove = useAction(() => api.deleteEvent(event!.id), onClose);
  const submit = () => {
    const b = budget.trim() === "" ? null : parseAmount(budget, minor);
    if (budget.trim() !== "" && (b === null || b <= 0)) return save.setError("Проверьте бюджет");
    save.run(b);
  };

  return (
    <Modal title={event ? event.name : "Новое событие"} onClose={onClose}>
      <form className="form" onSubmit={(e) => (e.preventDefault(), submit())}>
        <Field label="Название">
          {(id) => <input id={id} name="eventName" placeholder="Например, «Отпуск в Сочи»" value={name} onChange={(e) => setName(e.target.value)} autoFocus />}
        </Field>
        <div className="row">
          <Field label="С">{(id) => <input id={id} name="eventStart" type="date" value={start} onChange={(e) => setStart(e.target.value)} />}</Field>
          <Field label="По">{(id) => <input id={id} name="eventEnd" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />}</Field>
        </div>
        <Field label={`Бюджет, ${currency?.symbol ?? "₽"}`} hint="Можно оставить пустым.">
          {(id) => <AmountInput id={id} name="eventBudget" value={budget} onChange={setBudget} minorUnits={minor} />}
        </Field>
        {!event && <p className="muted">Расходы, уже записанные в эти дни, можно будет добавить одной кнопкой. Новые отмечаются в форме операции.</p>}
        <ErrorText error={save.error ?? remove.error} />
        <div className="actions">
          {event && (
            <button type="button" className="btn danger" onClick={() => remove.run()} disabled={remove.busy} title="Операции останутся, только без отметки">
              Удалить
            </button>
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
