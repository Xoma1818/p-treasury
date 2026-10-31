import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, X } from "lucide-react";
import { ErrorText } from "../components/Modal";
import { BaseMoney, Money } from "../components/Money";
import { NotesBlock } from "../components/Notes";
import { leadText, OccurrenceItem, parseLead, ReminderForm } from "../components/Reminders";
import { TXN_DRAG, TxnTable } from "../components/TxnTable";
import { HabitsCard } from "../components/Habits";
import { api, REPEATS, type CalendarDay, type CalendarMonth, type Reminder } from "../lib/api";
import { addDays, formatDate, formatDateTime, monthTitle, shiftMonth, today, WEEKDAYS, weekStart } from "../lib/dates";
import { useUi } from "../lib/store";
import { useAction } from "../lib/useAction";
import { ScreenTitle } from "../components/SectionIcon";
import { goalText, monthLine } from "../lib/forecast";

type Tab = "month" | "week" | "reminders";

/** Раздел «Календарь»: месяц, неделя, список напоминаний; день открывает свою панель. */
export function Calendar() {
  const [tab, setTab] = useState<Tab>("month");
  const [month, setMonth] = useState(today().slice(0, 7));
  const [selected, setSelected] = useState<string | null>(null);
  const [reminderDate, setReminderDate] = useState<string | null>(null);

  return (
    <section className="screen wide">
      <div className="screen-head">
        <ScreenTitle id="calendar" />
        <div className="btn-group">
          <button className="btn primary" onClick={() => setReminderDate(selected ?? today())}>
            + Напоминание
          </button>
        </div>
      </div>
      <div className="tabs fit cal-tabs" role="tablist">
        {(
          [
            ["month", "Месяц"],
            ["week", "Неделя"],
            ["reminders", "Напоминания"],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "tab active" : "tab"} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "month" && <MonthView month={month} setMonth={setMonth} selected={selected} select={setSelected} />}
      {tab === "week" && <WeekView start={weekStart(selected ?? today())} select={setSelected} selected={selected} />}
      {tab === "reminders" && <RemindersView />}
      {selected && tab !== "reminders" && <DayPanel date={selected} onClose={() => setSelected(null)} onReminder={() => setReminderDate(selected)} />}
      {reminderDate && <ReminderForm date={reminderDate} onClose={() => setReminderDate(null)} />}
    </section>
  );
}

function DayChips({ day, m }: { day: CalendarDay; m: CalendarMonth }) {
  const past = day.date < today();
  return (
    <div className="chips">
      {day.income > 0 && <Money className="plus" amount={day.income} symbol={m.currencySymbol} minorUnits={m.minorUnits} signed />}
      {day.expense > 0 && <Money className="minus" amount={-day.expense} symbol={m.currencySymbol} minorUnits={m.minorUnits} />}
      {day.debts.map((d) => (
        <span key={d.scheduleId} className={`chip debt ${d.status}`} data-testid="cal-debt" title={d.status === "paid" ? "оплачен" : past ? "просрочен" : "по графику"}>
          {d.direction === "lent" ? "↩ " : "⇥ "}
          {d.counterparty}
        </span>
      ))}
      {day.reminders.map((r) => (
        <span key={r.key.refId + r.key.scheduledAt} className={`chip reminder ${r.status}`} data-testid="cal-reminder">
          ⏰ {r.title}
        </span>
      ))}
      {day.memos.length > 0 && (
        <span className="chip note" title={day.memos.join("\n")} data-testid="cal-memo">
          ✎ {day.memos[0]}
          {day.memos.length > 1 && <span className="memo-more"> +{day.memos.length - 1}</span>}
        </span>
      )}
    </div>
  );
}

function Totals({ m, partial }: { m: CalendarMonth; partial?: boolean }) {
  const money = (v: number) => <Money amount={v} symbol={m.currencySymbol} minorUnits={m.minorUnits} />;
  return (
    <div className="tiles cal-totals">
      <div className="card tile" data-testid="cal-income">
        <div className="tile-label">Доходы{partial ? " за неделю" : ""}</div>
        <div className="tile-value plus">{money(m.income)}</div>
      </div>
      <div className="card tile" data-testid="cal-expense">
        <div className="tile-label">Расходы{partial ? " за неделю" : ""}</div>
        <div className="tile-value">{money(m.expense)}</div>
      </div>
      <div className="card tile" data-testid="cal-planned">
        <div className="tile-label">Ещё заплатить{partial ? "" : " до конца месяца"}</div>
        <div className="tile-value">{money(m.plannedExpense)}</div>
        <div className="hint">платежи по долгам и напоминания с суммой</div>
      </div>
      <div className="card tile" data-testid="cal-planned-income">
        <div className="tile-label">Ещё получить</div>
        <div className="tile-value plus">{money(m.plannedIncome)}</div>
      </div>
      {m.missingRates.length > 0 && <p className="hint warn">Нет курса для {m.missingRates.join(", ")}: такие суммы не вошли.</p>}
    </div>
  );
}

/** Строка прогноза над месяцем (0.19): сколько денег будет на конец месяца. */
function ForecastLine({ month }: { month: string }) {
  const f = useQuery({ queryKey: ["forecast", null], queryFn: () => api.forecast(null) }).data;
  const { go } = useUi();
  const line = f ? monthLine(f, month) : null;
  if (!f || !line) return null;
  return (
    <div className="card cal-forecast clickable" onClick={() => go("forecast")} title="Открыть «Взгляд вперёд»" data-testid="cal-forecast">
      <span>
        Прогноз на {formatDate(line.end)}: <b className={line.closing < 0 ? "over" : undefined}><BaseMoney amount={line.closing} /></b>
      </span>
      <span>
        за месяц <BaseMoney amount={line.change} signed />
      </span>
      {line.goals.map((g) => (
        <span key={g.id} className={g.free >= 0 ? "ok" : "over"}>
          ◆ {goalText(g, f.currencySymbol, f.minorUnits)}
        </span>
      ))}
    </div>
  );
}

function MonthView({ month, setMonth, selected, select }: { month: string; setMonth: (m: string) => void; selected: string | null; select: (d: string) => void }) {
  const q = useQuery({ queryKey: ["calendar", month], queryFn: () => api.calendarMonth(month) });
  const m = q.data;
  const t = today();
  // Перетаскивание операции из панели дня на другой день.
  const [over, setOver] = useState<string | null>(null);
  const move = useAction(api.moveTransaction, () => {});
  // Пустые клетки до первого числа: неделя с понедельника.
  const lead = m ? (new Date(`${month}-01T00:00`).getDay() + 6) % 7 : 0;
  return (
    <>
      <div className="period-nav">
        <button className="icon-btn" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Предыдущий месяц">
          <ChevronLeft size={18} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <h2 data-testid="cal-title">{monthTitle(month)}</h2>
        <button className="icon-btn" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Следующий месяц">
          <ChevronRight size={18} strokeWidth={1.75} aria-hidden="true" />
        </button>
        {month !== t.slice(0, 7) && (
          <button className="link" onClick={() => setMonth(t.slice(0, 7))}>
            Сегодня
          </button>
        )}
      </div>
      {q.error && <p className="error">{String(q.error)}</p>}
      <ForecastLine month={month} />
      {m && (
        <>
          <div className="card cal-grid" data-testid="calendar">
            {WEEKDAYS.map((w) => (
              <div key={w} className="cal-weekday">
                {w}
              </div>
            ))}
            {Array.from({ length: lead }, (_, i) => (
              <div key={`e${i}`} className="cal-cell empty" />
            ))}
            {m.days.map((d) => (
              <div
                key={d.date}
                className={["cal-cell", d.date === t && "today", d.date === selected && "selected", d.date > t && "future", d.noSpend && "no-spend", d.date === over && "drop-over"]
                  .filter(Boolean)
                  .join(" ")}
                data-testid="cal-day"
                data-date={d.date}
                onClick={() => select(d.date)}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes(TXN_DRAG)) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setOver(d.date);
                }}
                onDragLeave={() => setOver((cur) => (cur === d.date ? null : cur))}
                onDrop={(e) => {
                  const id = e.dataTransfer.getData(TXN_DRAG);
                  setOver(null);
                  if (!id) return;
                  e.preventDefault();
                  move.run(id, d.date);
                }}
              >
                <div className="cal-num">
                  {Number(d.date.slice(8))}
                  {d.noSpend && (
                    <span className="no-spend-mark" title="День без трат" data-testid="no-spend">
                      <Check size={11} strokeWidth={2.5} aria-hidden />
                    </span>
                  )}
                </div>
                <DayChips day={d} m={m} />
              </div>
            ))}
          </div>
          <ErrorText error={move.error} />
          <Totals m={m} />
          <HabitsCard noSpend={m.days.filter((d) => d.noSpend).length} />
        </>
      )}
    </>
  );
}

function WeekView({ start, selected, select }: { start: string; selected: string | null; select: (d: string) => void }) {
  const [from, setFrom] = useState(start);
  const to = addDays(from, 6);
  const q = useQuery({ queryKey: ["calendar", from, to], queryFn: () => api.calendarRange(from, to) });
  const m = q.data;
  return (
    <>
      <div className="period-nav">
        <button className="icon-btn" onClick={() => setFrom(addDays(from, -7))} aria-label="Предыдущая неделя">
          <ChevronLeft size={18} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <h2>
          {formatDate(from)} — {formatDate(to)}
        </h2>
        <button className="icon-btn" onClick={() => setFrom(addDays(from, 7))} aria-label="Следующая неделя">
          <ChevronRight size={18} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      {m && (
        <>
          <ul className="card week-list" data-testid="week">
            {m.days.map((d, i) => (
              <li key={d.date} className={d.date === selected ? "selected clickable" : "clickable"} onClick={() => select(d.date)} data-testid="week-day">
                <span className="week-date">
                  {WEEKDAYS[i]}, {formatDate(d.date)}
                </span>
                <DayChips day={d} m={m} />
              </li>
            ))}
          </ul>
          <Totals m={m} partial />
        </>
      )}
    </>
  );
}

/** Панель дня: операции, платежи, напоминания и заметки; добавить на эту дату. */
function DayPanel({ date, onClose, onReminder }: { date: string; onClose: () => void; onReminder: () => void }) {
  const { openTxnForm, openDebt } = useUi();
  const month = date.slice(0, 7);
  const cal = useQuery({ queryKey: ["calendar", month], queryFn: () => api.calendarMonth(month) }).data;
  const txns = useQuery({ queryKey: ["transactions", "day", date], queryFn: () => api.listTransactions({ dateFrom: date, dateTo: date, limit: 100 }) }).data;
  const day = cal?.days.find((d) => d.date === date);
  const noteInput = useRef<HTMLInputElement>(null);
  return (
    <aside className="card day-panel" data-testid="day-panel">
      <div className="notes-head">
        <h2>{formatDate(date)}</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Закрыть день">
          <X size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      <div className="btn-group">
        <button className="btn small primary" onClick={() => openTxnForm({ mode: "new", type: "expense", date })}>
          + Операция
        </button>
        <button className="btn small" onClick={onReminder}>
          + Напоминание
        </button>
        <button className="btn small" onClick={() => noteInput.current?.focus()}>
          + Заметка
        </button>
      </div>
      <h3>Операции</h3>
      {txns && txns.items.length === 0 && <p className="muted small">Операций нет.</p>}
      {txns && txns.items.length > 0 && <TxnTable items={txns.items} compact draggable />}
      {txns && txns.items.length > 0 && <p className="hint">Операцию можно перетащить на другой день календаря.</p>}
      {day && day.debts.length > 0 && (
        <>
          <h3>Платежи по долгам</h3>
          <ul className="account-list">
            {day.debts.map((d) => (
              <li key={d.scheduleId} className="clickable" onClick={() => openDebt(d.debtId)}>
                <span>
                  {d.counterparty}
                  <span className="sub"> · {d.status === "paid" ? "оплачен" : d.direction === "lent" ? "должны вернуть" : "по графику"}</span>
                </span>
                <Money amount={d.payment} symbol={d.currencySymbol} minorUnits={d.minorUnits} />
              </li>
            ))}
          </ul>
        </>
      )}
      {day && day.reminders.length > 0 && (
        <>
          <h3>Напоминания</h3>
          <ul className="occ-list">
            {day.reminders.map((o) => (
              <OccurrenceItem key={o.key.refId + o.key.scheduledAt} o={o} />
            ))}
          </ul>
        </>
      )}
      <NotesBlock filter={{ dateFrom: date, dateTo: date }} initial={{ date }} inputRef={noteInput} />
    </aside>
  );
}

function RemindersView() {
  const q = useQuery({ queryKey: ["reminders"], queryFn: api.remindersOverview });
  const [edit, setEdit] = useState<Reminder | null>(null);
  const toggle = useAction((r: Reminder) => api.setReminderActive(r.id, !r.active));
  const o = q.data;
  if (!o) return null;
  const section = (title: string, list: typeof o.overdue, id: string, empty: string) => (
    <div className="card" data-testid={id}>
      <h2>{title}</h2>
      {list.length === 0 ? <p className="muted">{empty}</p> : <ul className="occ-list">{list.map((x) => <OccurrenceItem key={x.key.refId + x.key.scheduledAt} o={x} />)}</ul>}
    </div>
  );
  return (
    <>
      {section("Просроченные", o.overdue, "rem-overdue", "Всё сделано.")}
      {section("Ближайшие 30 дней", o.upcoming, "rem-upcoming", "Ничего не запланировано.")}
      {o.done.length > 0 && section("Выполненные", o.done, "rem-done", "")}
      <div className="card" data-testid="rem-all">
        <h2>Все напоминания</h2>
        <p className="hint">Платежи по долгам напоминаются сами, за сколько дней — в Настройках.</p>
        {o.reminders.length === 0 && <p className="muted">Своих напоминаний нет.</p>}
        <ul className="account-list">
          {o.reminders.map((r) => (
            <li key={r.id} className={r.active ? undefined : "muted"} data-testid="reminder-row">
              <span className="clickable" onClick={() => setEdit(r)}>
                <span className="main">{r.title}</span>
                <span className="sub">
                  {" "}
                  · {REPEATS[r.repeat].toLowerCase()}
                  {r.nextAt ? `, следующее ${formatDateTime(r.nextAt)}` : r.active ? ", больше не повторится" : ", выключено"}
                  {r.leadDays != null && `, ${leadText(parseLead(r.leadDays))}`}
                  {(r.noteId || r.eventId) && (r.noteId ? ", из заметки" : ", у события")}
                </span>
              </span>
              <span>
                {r.amount != null && <Money amount={r.amount} />}
                <button className="link" onClick={() => toggle.run(r)}>
                  {r.active ? "Выключить" : "Включить"}
                </button>
              </span>
            </li>
          ))}
        </ul>
      </div>
      {edit && <ReminderForm reminder={edit} onClose={() => setEdit(null)} />}
    </>
  );
}
