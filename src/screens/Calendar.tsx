import { useQuery } from "@tanstack/react-query";
import { useModules } from "../lib/modules";
import { useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, X } from "lucide-react";
import { ErrorText } from "../components/Modal";
import { BaseMoney, Money } from "../components/Money";
import { NotesBlock } from "../components/Notes";
import { leadText, OccurrenceItem, parseLead, ReminderForm } from "../components/Reminders";
import { TXN_DRAG, TxnTable } from "../components/TxnTable";
import { HabitsCard } from "../components/Habits";
import { api, REPEATS, type CalendarDay, type CalendarMonth, type Reminder } from "../lib/api";
import { addDays, formatDate, formatDateTime, monthTitle, shiftMonth, today, weekdays, weekStart } from "../lib/dates";
import { CAL_LAYERS, saveFine, useFine, weekdayIndex, type CalLayers } from "../lib/fine";
import { useUi } from "../lib/store";
import { useAction } from "../lib/useAction";
import { ScreenTitle } from "../components/SectionIcon";
import { goalText, monthLine } from "../lib/forecast";
import { heatWeeks } from "../lib/heat";
import { formatMoney } from "../lib/money";

type Tab = "month" | "week" | "year" | "reminders";

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
            ["year", "Год"],
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
      {tab === "year" && <YearView selected={selected} select={setSelected} />}
      {tab === "reminders" && <RemindersView />}
      {selected && tab !== "reminders" && <DayPanel date={selected} onClose={() => setSelected(null)} onReminder={() => setReminderDate(selected)} />}
      {reminderDate && <ReminderForm date={reminderDate} onClose={() => setReminderDate(null)} />}
    </section>
  );
}

/** Р6: какие слои видны в днях; переключатели сохраняются в настройках вида. */
function LayerToggles() {
  const f = useFine();
  return (
    <div className="tabs small cal-layers" role="group" aria-label="Что показывать в днях" data-testid="cal-layers">
      {CAL_LAYERS.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          className={f.layers[key] ? "tab active" : "tab"}
          aria-pressed={f.layers[key]}
          data-testid={`cal-layer-${key}`}
          onClick={() => saveFine({ ...f, layers: { ...f.layers, [key]: !f.layers[key] } })}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Р6: остаток на конец дня — запрашивается, только когда слой включён. */
function useBalances(from: string, to: string, on: boolean) {
  const q = useQuery({ queryKey: ["calendar", "balances", from, to], queryFn: () => api.calendarBalances(from, to), enabled: on });
  return on ? new Map((q.data ?? []).map((b) => [b.date, b.balance])) : null;
}

function DayChips({ day, m, layers, balance }: { day: CalendarDay; m: CalendarMonth; layers: CalLayers; balance?: number | null }) {
  const past = day.date < today();
  return (
    <div className="chips">
      {layers.income && day.income > 0 && <Money className="plus" amount={day.income} symbol={m.currencySymbol} minorUnits={m.minorUnits} signed />}
      {layers.expense && day.expense > 0 && <Money className="minus" amount={-day.expense} symbol={m.currencySymbol} minorUnits={m.minorUnits} />}
      {layers.balance && balance != null && (
        <span className="cal-balance" title="Остаток на конец дня, все счета" data-testid="cal-balance">
          = <Money amount={balance} symbol={m.currencySymbol} minorUnits={m.minorUnits} />
        </span>
      )}
      {layers.debts && day.debts.map((d) => (
        <span key={d.scheduleId} className={`chip debt ${d.status}`} data-testid="cal-debt" title={d.status === "paid" ? "оплачен" : past ? "просрочен" : "по графику"}>
          {d.direction === "lent" ? "↩ " : "⇥ "}
          {d.counterparty}
        </span>
      ))}
      {layers.reminders && day.reminders.map((r) => (
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
  const modules = useModules();
  const q = useQuery({ queryKey: ["calendar", month], queryFn: () => api.calendarMonth(month) });
  const m = q.data;
  const t = today();
  // Перетаскивание операции из панели дня на другой день.
  const [over, setOver] = useState<string | null>(null);
  const move = useAction(api.moveTransaction, () => {});
  // Пустые клетки до первого числа: неделя с понедельника или воскресенья (Г12).
  const fineView = useFine();
  const lead = m ? weekdayIndex(new Date(`${month}-01T00:00`).getDay(), fineView) : 0;
  const balances = useBalances(`${month}-01`, m?.days.at(-1)?.date ?? `${month}-28`, fineView.layers.balance && !!m);
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
        <span className="spacer" />
        <LayerToggles />
      </div>
      {q.error && <p className="error">{String(q.error)}</p>}
      <ForecastLine month={month} />
      {m && (
        <>
          <div className="card cal-grid" data-testid="calendar">
            {weekdays().map((w) => (
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
                <DayChips day={d} m={m} layers={fineView.layers} balance={balances?.get(d.date)} />
              </div>
            ))}
          </div>
          <ErrorText error={move.error} />
          <Totals m={m} />
          {modules.on("habits") && <HabitsCard noSpend={m.days.filter((d) => d.noSpend).length} />}
        </>
      )}
    </>
  );
}

const MONTH_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

/** Р7 вид «Год»: тепловая карта трат по дням, чем темнее — тем больше. День открывает свою панель. */
function YearView({ selected, select }: { selected: string | null; select: (d: string) => void }) {
  const [year, setYear] = useState(Number(today().slice(0, 4)));
  const q = useQuery({ queryKey: ["calendar", "year", year], queryFn: () => api.calendarYear(year) });
  const fineView = useFine();
  const h = q.data;
  const weeks = h ? heatWeeks(h.days, h.max, fineView) : [];
  const t = today();
  const money = (v: number) => (h ? formatMoney(v, h.currencySymbol, h.minorUnits) : "");
  return (
    <>
      <div className="period-nav">
        <button className="icon-btn" onClick={() => setYear(year - 1)} aria-label="Предыдущий год">
          <ChevronLeft size={18} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <h2 data-testid="year-title">{year}</h2>
        <button className="icon-btn" onClick={() => setYear(year + 1)} aria-label="Следующий год">
          <ChevronRight size={18} strokeWidth={1.75} aria-hidden="true" />
        </button>
        {year !== Number(t.slice(0, 4)) && (
          <button className="link" onClick={() => setYear(Number(t.slice(0, 4)))}>
            Этот год
          </button>
        )}
      </div>
      {q.error && <p className="error">{String(q.error)}</p>}
      {h && (
        <div className="card heat-card" data-testid="year-heat">
          <div className="heat-scroll">
            <div className="heat-months" aria-hidden="true">
              {weeks.map((w, i) => {
                const first = w.find((c) => c && c.date.endsWith("-01")) ?? (i === 0 ? w.find(Boolean) : null);
                return <span key={i}>{first ? MONTH_SHORT[Number(first.date.slice(5, 7)) - 1] : ""}</span>;
              })}
            </div>
            <div className="heat-body">
              <div className="heat-weekdays" aria-hidden="true">
                {weekdays().map((w, i) => (
                  <span key={w}>{i % 2 === 0 ? w : ""}</span>
                ))}
              </div>
              <div className="heat-grid" role="grid" aria-label={`Траты по дням, ${year}`}>
                {weeks.map((w, i) => (
                  <div key={i} className="heat-week" role="row">
                    {w.map((c, j) =>
                      c ? (
                        <button
                          key={c.date}
                          type="button"
                          role="gridcell"
                          className={["heat-day", `l${c.level}`, c.date === t && "today", c.date === selected && "selected", c.date > t && "future"].filter(Boolean).join(" ")}
                          data-testid="heat-day"
                          data-date={c.date}
                          data-level={c.level}
                          title={`${formatDate(c.date)}: ${c.expense > 0 ? money(c.expense) : "без трат"}`}
                          aria-label={`${formatDate(c.date)}: ${c.expense > 0 ? money(c.expense) : "без трат"}`}
                          onClick={() => select(c.date)}
                        />
                      ) : (
                        <span key={`e${j}`} className="heat-day empty" />
                      ),
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="heat-foot">
            <span data-testid="year-total">
              Потрачено за год: <b>{money(h.total)}</b>
            </span>
            <span className="heat-legend muted" aria-hidden="true">
              меньше {[0, 1, 2, 3, 4].map((l) => <span key={l} className={`heat-day l${l}`} />)} больше
            </span>
          </div>
          {h.missingRates.length > 0 && <p className="hint warn">Нет курса для {h.missingRates.join(", ")}: такие траты не вошли.</p>}
          <p className="hint">Неделя начинается с {fineView.week === "sun" ? "воскресенья" : "понедельника"}: поменять можно в Настройках, «Тонкие настройки» → «Неделя начинается».</p>
        </div>
      )}
    </>
  );
}

function WeekView({ start, selected, select }: { start: string; selected: string | null; select: (d: string) => void }) {
  const [from, setFrom] = useState(start);
  const to = addDays(from, 6);
  const q = useQuery({ queryKey: ["calendar", from, to], queryFn: () => api.calendarRange(from, to) });
  const m = q.data;
  const fineView = useFine();
  const balances = useBalances(from, to, fineView.layers.balance);
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
        <span className="spacer" />
        <LayerToggles />
      </div>
      {m && (
        <>
          <ul className="card week-list" data-testid="week">
            {m.days.map((d, i) => (
              <li key={d.date} className={d.date === selected ? "selected clickable" : "clickable"} onClick={() => select(d.date)} data-testid="week-day">
                <span className="week-date">
                  {weekdays()[i]}, {formatDate(d.date)}
                </span>
                <DayChips day={d} m={m} layers={fineView.layers} balance={balances?.get(d.date)} />
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
                  {!r.active ? ", выключено" : r.nextAt ? `, следующее ${formatDateTime(r.nextAt)}` : ", больше не повторится"}
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
