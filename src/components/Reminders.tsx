import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bell, X } from "lucide-react";
import { api, REPEATS, TXN_TYPES, type Occurrence, type Reminder, type ReminderInput, type ReminderKey, type Repeat, type Txn, type TxnType } from "../lib/api";
import { addDays, formatDate, formatDateTime, isoDateTime, nextRepeatDate, nowLocal, today } from "../lib/dates";
import { HIDDEN_AMOUNT, parseAmount } from "../lib/money";
import { occurrenceStatus } from "../lib/occurrenceStatus";
import { useAccounts, useCategories, useCurrencies, useSettings } from "../lib/queries";
import { useUi } from "../lib/store";
import { useAction } from "../lib/useAction";
import { usePopup } from "../lib/usePopup";
import { AccountSelect, AmountInput, amountText, CategorySelect, Field } from "./Fields";
import { ErrorText, Modal } from "./Modal";
import { Money } from "./Money";

/** Готовые сроки «заранее», дней. */
const LEAD_PRESETS: [number, string][] = [
  [14, "за 2 недели"],
  [7, "за неделю"],
  [3, "за 3 дня"],
  [1, "за день"],
];

export function leadText(days: number[]): string {
  if (days.length === 0) return "заранее не предупреждать";
  return days.map((d) => LEAD_PRESETS.find(([v]) => v === d)?.[1] ?? `за ${d} дн.`).join(", ");
}

export function parseLead(s: string | null | undefined): number[] {
  return (s ?? "")
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((d) => Number.isInteger(d) && d > 0);
}

/** Сроки «заранее»: готовые кнопки и своё число дней. */
export function LeadDaysPicker({ value, onChange, name = "leadDays" }: { value: number[]; onChange: (v: number[]) => void; name?: string }) {
  const [own, setOwn] = useState("");
  const toggle = (d: number) => onChange(value.includes(d) ? value.filter((x) => x !== d) : [...value, d].sort((a, b) => b - a));
  const custom = value.filter((d) => !LEAD_PRESETS.some(([v]) => v === d));
  return (
    <div className="lead-days" data-testid={name}>
      {LEAD_PRESETS.map(([d, label]) => (
        <button key={d} type="button" className={value.includes(d) ? "chip-btn active" : "chip-btn"} aria-pressed={value.includes(d)} onClick={() => toggle(d)}>
          {label}
        </button>
      ))}
      {custom.map((d) => (
        <button key={d} type="button" className="chip-btn active" aria-pressed title="Убрать" onClick={() => toggle(d)}>
          за {d} дн. <X size={12} strokeWidth={2} aria-hidden="true" />
        </button>
      ))}
      <input
        name={`${name}Own`}
        className="lead-own"
        inputMode="numeric"
        placeholder="своё, дней"
        value={own}
        onChange={(e) => setOwn(e.target.value.replace(/\D/g, ""))}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          const d = Number(own);
          if (d >= 1 && d <= 60 && !value.includes(d)) toggle(d);
          setOwn("");
        }}
        onBlur={() => {
          const d = Number(own);
          if (d >= 1 && d <= 60 && !value.includes(d)) toggle(d);
          setOwn("");
        }}
      />
    </div>
  );
}

type LeadMode = "default" | "own" | "none";
type EndMode = "never" | "date" | "count";

/**
 * Диалог напоминания: новое (можно с датой из календаря, из заметки или события)
 * или правка. С `from` сохраняет «этот платёж и все следующие» как новую серию.
 */
export function ReminderForm({
  reminder,
  date,
  preset,
  from,
  source,
  onClose,
}: {
  reminder?: Reminder;
  date?: string;
  preset?: Partial<ReminderInput>;
  from?: ReminderKey;
  source?: Txn;
  onClose: () => void;
}) {
  const accounts = useAccounts().data ?? [];
  const categories = useCategories().data ?? [];
  const settings = useSettings().data;
  const currencies = useCurrencies().data;
  const base = settings && currencies?.find((c) => c.code === (settings.base_currency ?? "RUB"));
  const minor = source?.minorUnits ?? reminder?.minorUnits ?? base?.minorUnits ?? 2;
  const unit = reminder?.currencySymbol ?? base?.symbol;
  const [title, setTitle] = useState(reminder?.title ?? preset?.title ?? "");
  const [day, setDay] = useState(from?.scheduledAt.slice(0, 10) ?? reminder?.startAt.slice(0, 10) ?? preset?.startAt?.slice(0, 10) ?? date ?? today());
  const [time, setTime] = useState(reminder?.startAt.slice(11, 16) ?? preset?.startAt?.slice(11, 16) ?? "09:00");
  const [repeat, setRepeat] = useState<Repeat>(reminder?.repeat ?? preset?.repeat ?? "once");
  const [customDay, setCustomDay] = useState(false);
  const [endMode, setEndMode] = useState<EndMode>(reminder?.endDate ? "date" : "never");
  const [endDate, setEndDate] = useState(reminder?.endDate ?? "");
  const [count, setCount] = useState("12");
  const [amountDraft, setAmount] = useState<string | null>(null);
  const [lastAmountDraft, setLastAmount] = useState<string | null>(null);
  const amount = amountDraft ?? amountText(reminder?.amount ?? preset?.amount, minor);
  const lastAmount = lastAmountDraft ?? amountText(reminder?.lastAmount, minor);
  const [txnType, setTxnType] = useState<"expense" | "income">(reminder?.txnType ?? preset?.txnType ?? "expense");
  const [accountId, setAccountId] = useState(reminder?.accountId ?? preset?.accountId ?? "");
  const [categoryId, setCategoryId] = useState(reminder?.categoryId ?? preset?.categoryId ?? "");
  const [note, setNote] = useState(reminder?.note ?? preset?.note ?? "");
  const saved = reminder?.leadDays ?? preset?.leadDays;
  const [leadMode, setLeadMode] = useState<LeadMode>(saved == null ? "default" : saved === "" ? "none" : "own");
  const [lead, setLead] = useState<number[]>(saved ? parseLead(saved) : [3, 1]);
  const defaults = parseLead(settings?.reminder_lead_days ?? "3,1");

  const save = useAction(
    (input: ReminderInput) =>
      source ? api.createRepeatPlan(source.id, input) : from ? api.splitReminder(from, input) : reminder ? api.updateReminder(reminder.id, input) : api.createReminder(input),
    onClose,
    { singleSubmit: true },
  );
  const remove = useAction(() => api.deleteReminder(reminder!.id), onClose);

  const series = repeat !== "once";
  const ends = series && endMode !== "never";
  const earliest = source && addDays(source.date > today() ? source.date : today(), 1);
  const originalDay = from?.scheduledAt.slice(0, 10) ?? reminder?.startAt.slice(0, 10);
  const monthlyDay = source && !customDay ? Number(source.date.slice(-2))
    : day === originalDay && reminder?.dayOfMonth ? reminder.dayOfMonth : Number(day.slice(-2));
  const changeRepeat = (next: Repeat) => {
    setRepeat(next);
    if (source && !customDay && (next === "monthly" || next === "weekly")) {
      setDay(nextRepeatDate(source.date, next));
    }
  };
  const submit = () => {
    if (earliest && (!day || day < earliest)) return save.setError("Выберите будущую дату после исходной операции.");
    if (!title.trim()) return save.setError("Введите название напоминания.");
    if (!source && !reminder && !base && amount.trim()) return save.setError("Дождитесь загрузки основной валюты.");
    const value = source?.amount ?? (amount.trim() ? parseAmount(amount, minor) : null);
    if (amount.trim() && (value === null || value <= 0)) return save.setError("Сумма должна быть больше нуля");
    const last = ends && value && lastAmount.trim() ? parseAmount(lastAmount, minor) : null;
    if (ends && value && lastAmount.trim() && (last === null || last <= 0)) return save.setError("Последний платёж должен быть больше нуля");
    const n = Number(count);
    if (series && endMode === "count" && !(Number.isInteger(n) && n >= 1 && n <= 600)) return save.setError("Сколько раз: от 1 до 600");
    save.run({
      title: title.trim(),
      startAt: `${day}T${time || "09:00"}`,
      repeat,
      // Сохраняем исходное число, даже если ближайший срок выпал на 28–30-е.
      dayOfMonth: repeat === "monthly" ? monthlyDay : null,
      endDate: series && endMode === "date" && endDate ? endDate : null,
      count: series && endMode === "count" ? n : null,
      amount: value,
      lastAmount: last && last !== value ? last : null,
      txnType: value ? txnType : null,
      accountId: accountId || null,
      categoryId: categoryId || null,
      note: note || null,
      leadDays: leadMode === "default" ? null : leadMode === "none" ? "" : lead.join(","),
      noteId: preset?.noteId ?? null,
      eventId: preset?.eventId ?? null,
    });
  };

  return (
    <Modal title={source ? "Запланировать повтор" : from ? "Этот и следующие платежи" : reminder ? "Напоминание" : "Новое напоминание"} onClose={onClose} dismissDisabled={save.busy}>
      <form
        className="form"
        data-testid={source ? "repeat-plan-form" : undefined}
        onSubmit={(e) => {
          e.preventDefault();
          // Форма может открываться поверх другой (заметки): та не должна сохраняться.
          e.stopPropagation();
          submit();
        }}
      >
        {source && <div data-testid="repeat-plan-source">
          <p>{TXN_TYPES[source.type]} · <Money amount={source.amount} symbol={source.currencySymbol} currencyCode={source.currencyCode} minorUnits={source.minorUnits} /> · {formatDate(source.date)}</p>
          <p className="muted">{[source.accountName, source.categoryName].filter(Boolean).join(" · ")}</p>
          <p className="hint">Операция уже записана. Повтор добавит будущий платёж в календарь.</p>
        </div>}
        <Field label="Название">{(id) => <input id={id} name="reminderTitle" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />}</Field>
        <div className="row">
          <Field label={source ? "Следующий платёж" : from ? "С какого дня" : "Дата"}>{(id) => <input id={id} name="reminderDate" type="date" value={day} min={earliest} required={!!source} onChange={(e) => { setDay(e.target.value); setCustomDay(true); }} />}</Field>
          <Field label="Время">{(id) => <input id={id} name="reminderTime" type="time" value={time} onChange={(e) => setTime(e.target.value)} />}</Field>
        </div>
        <div className="row">
          <Field label="Повтор">
            {(id) => (
              <select id={id} name="repeat" value={repeat} onChange={(e) => changeRepeat(e.target.value as Repeat)}>
                {Object.entries(REPEATS).filter(([k]) => !source || k === "monthly" || k === "weekly").map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {series && !source && (
            <Field label="Сколько раз">
              {(id) => (
                <select id={id} name="reminderEndMode" value={endMode} onChange={(e) => setEndMode(e.target.value as EndMode)}>
                  <option value="never">Без конца</option>
                  <option value="count">Несколько раз</option>
                  <option value="date">До даты</option>
                </select>
              )}
            </Field>
          )}
          {series && endMode === "date" && (
            <Field label="Повторять до">{(id) => <input id={id} name="reminderEnd" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />}</Field>
          )}
          {series && endMode === "count" && (
            <Field label="Раз">
              {(id) => <input id={id} name="reminderCount" inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value.replace(/\D/g, ""))} />}
            </Field>
          )}
        </div>
        {repeat === "monthly" && day && <p className="hint">Каждый месяц {monthlyDay}-го. Если такого числа нет, платёж приходится на последний день месяца.</p>}
        {!source && <>
        <div className="row">
          <Field label={unit ? `Сумма, ${unit} (необязательно)` : "Сумма (необязательно)"}>{(id) => <AmountInput id={id} name="reminderAmount" value={amount} onChange={setAmount} minorUnits={minor} />}</Field>
          <Field label="Это">
            {(id) => (
              <select id={id} name="reminderType" value={txnType} onChange={(e) => setTxnType(e.target.value as "expense" | "income")}>
                <option value="expense">Расход</option>
                <option value="income">Доход</option>
              </select>
            )}
          </Field>
        </div>
        {ends && amount.trim() && (
          <Field label="Последний платёж, если другой (необязательно)">
            {(id) => <AmountInput id={id} name="reminderLastAmount" value={lastAmount} onChange={setLastAmount} minorUnits={minor} />}
          </Field>
        )}
        <div className="row">
          <Field label="Счёт">
            {(id) => <AccountSelect id={id} name="reminderAccount" accounts={accounts} value={accountId} onChange={setAccountId} placeholder="Не выбран" />}
          </Field>
          <Field label="Категория">
            {(id) => (
              <CategorySelect
                key={txnType}
                id={id}
                name="reminderCategory"
                categories={categories}
                kind={txnType}
                value={categoryId}
                onChange={setCategoryId}
                placeholder="Не выбрана"
              />
            )}
          </Field>
        </div>
        <Field label="Напомнить заранее">
          {(id) => (
            <select id={id} name="reminderLeadMode" value={leadMode} onChange={(e) => setLeadMode(e.target.value as LeadMode)}>
              <option value="default">Как в Настройках: {leadText(defaults)}</option>
              <option value="own">Свои сроки</option>
              <option value="none">Только в сам день</option>
            </select>
          )}
        </Field>
        {leadMode === "own" && <LeadDaysPicker value={lead} onChange={setLead} />}
        {accountId && txnType === "expense" && amount.trim() && (
          <p className="hint">Если к платежу на счёте не будет хватать денег, программа предупредит заранее.</p>
        )}
        <Field label="Комментарий">{(id) => <input id={id} name="reminderNote" value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        </>}
        <ErrorText error={save.error ?? remove.error} />
        <div className="actions">
          {reminder && !from && (
            <button type="button" className="btn danger" onClick={() => remove.run()}>
              Удалить
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose} disabled={save.busy}>
            Отмена
          </button>
          <button type="submit" className="btn primary" data-testid={source ? "repeat-plan-save" : undefined} aria-busy={save.busy} data-done={save.done || undefined} disabled={save.busy}>
            {source ? "Запланировать" : "Сохранить"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Правка одного платежа серии: своя сумма и другой день; или переход к «этот и следующие». */
function EditOccurrence({ o, onClose }: { o: Occurrence; onClose: () => void }) {
  const [amount, setAmount] = useState(amountText(o.amount, o.minorUnits));
  const [day, setDay] = useState(o.payAt.slice(0, 10));
  const [time, setTime] = useState(o.payAt.slice(11, 16));
  const [following, setFollowing] = useState<Reminder | null>(null);
  const save = useAction((a: number | null, moved: string | null) => api.editReminderOccurrence(o.key, a, moved), onClose);
  const reset = useAction(() => api.editReminderOccurrence(o.key, null, null), onClose);
  const loadSeries = useAction(() => api.getReminder(o.key.refId).then(setFollowing));
  if (following) return <ReminderForm reminder={following} from={o.key} onClose={onClose} />;
  const submit = () => {
    const value = amount.trim() ? parseAmount(amount, o.minorUnits) : null;
    if (amount.trim() && (value === null || value <= 0)) return save.setError("Сумма должна быть больше нуля");
    const moved = `${day}T${time || "09:00"}`;
    save.run(value, moved === o.key.scheduledAt ? null : moved);
  };
  return (
    <Modal title={`Платёж ${formatDate(o.key.scheduledAt.slice(0, 10))}`} onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <p className="muted">{o.title}: меняется только этот платёж, остальные остаются как были.</p>
        <div className="row">
          <Field label={`Сумма, ${o.currencySymbol}`}>{(id) => <AmountInput id={id} name="occAmount" value={amount} onChange={setAmount} minorUnits={o.minorUnits} />}</Field>
          <Field label="День">{(id) => <input id={id} name="occDate" type="date" value={day} onChange={(e) => setDay(e.target.value)} />}</Field>
          <Field label="Время">{(id) => <input id={id} name="occTime" type="time" value={time} onChange={(e) => setTime(e.target.value)} />}</Field>
        </div>
        <ErrorText error={save.error ?? reset.error ?? loadSeries.error} />
        <div className="actions">
          <button type="button" className="btn" onClick={() => loadSeries.run()} data-testid="occ-following">
            Этот и все следующие…
          </button>
          {o.edited && (
            <button type="button" className="link" onClick={() => reset.run()}>
              Как в серии
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

/** «Напомнить…» у заметки или события: открывает своё напоминание или создаёт новое. */
export function ReminderButton({ reminderId, preset, label = "Напомнить…" }: { reminderId: string | null; preset: Partial<ReminderInput>; label?: string }) {
  const [open, setOpen] = useState(false);
  const [existing, setExisting] = useState<Reminder | null>(null);
  const load = useAction(() => api.getReminder(reminderId!).then((r) => (setExisting(r), setOpen(true))));
  return (
    <>
      <button
        type="button"
        className="link"
        data-testid="reminder-button"
        onClick={() => (reminderId ? load.run() : setOpen(true))}
        title={reminderId ? "Изменить напоминание" : "Напомнить об этом заранее"}
      >
        {reminderId ? (
            <>
              <Bell size={14} strokeWidth={1.75} aria-hidden="true" /> Напоминание
            </>
          ) : (
            label
          )}
      </button>
      <ErrorText error={load.error} />
      {open && (
        <ReminderForm
          reminder={existing ?? undefined}
          preset={preset}
          onClose={() => {
            setOpen(false);
            setExisting(null);
          }}
        />
      )}
    </>
  );
}

const SNOOZE: [string, () => string][] = [
  ["на час", () => isoDateTime(new Date(Date.now() + 3600_000))],
  ["до завтра", () => `${addDays(today(), 1)}T09:00`],
  ["на 3 дня", () => `${addDays(today(), 3)}T09:00`],
];

/** Форма платежа открывается после проверки совпадений. */
function useCreateFromReminder() {
  const openTxnForm = useUi((s) => s.openTxnForm);
  return (o: Occurrence, revision: string, allowSeparate: boolean, onCancelReminder: () => void) => {
    openTxnForm({
      mode: "new",
      type: o.txnType ?? "expense",
      date: today(),
      prefill: { amount: o.amount, amountCurrency: o.amountCurrency, accountId: o.accountId, categoryId: o.categoryId, payee: o.title, note: o.note },
      reminder: { key: o.key, revision, allowSeparate },
      onCancelReminder,
    });
  };
}

const PAYMENT_VERBS: Record<TxnType, string> = {
  expense: "списано", income: "зачислено", transfer: "переведено", adjustment: "скорректировано",
};

function PaymentDates({ o, date, type, id }: { o: Occurrence; date: string; type: TxnType; id?: string }) {
  const planned = o.dueDate ?? o.payAt.slice(0, 10);
  return <span id={id} data-testid="payment-dates">
    По плану <time dateTime={planned}>{formatDate(planned)}</time>
    {!o.dueDate && ` ${o.payAt.slice(11, 16)}`}
    {" · "}{PAYMENT_VERBS[type]} <time dateTime={date}>{formatDate(date)}</time>
  </span>;
}

export function OccurrenceItem({ o, onAction }: { o: Occurrence; onAction?: () => void }) {
  const [snoozing, setSnoozing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [matching, setMatching] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const more = usePopup();
  const moreId = useId();
  const primary = useRef<HTMLButtonElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const snoozeButton = useRef<HTMLButtonElement>(null);
  const transactionButton = useRef<HTMLButtonElement>(null);
  const done = useAction(() => api.completeReminder(o.key), onAction);
  const reopen = useAction(() => api.reopenReminder(o.key), onAction);
  const snooze = useAction((until: string) => api.snoozeReminder(o.key, until), () => {
    setSnoozing(false);
    onAction?.();
  });
  const create = useCreateFromReminder();
  const openDebt = useUi((s) => s.openDebt);
  const open = o.status === "pending" || o.status === "snoozed";
  const status = occurrenceStatus(o, nowLocal());
  const debt = o.key.source === "debt";
  const payment = !debt && o.amount != null;
  useEffect(() => {
    if (viewing && (o.status !== "done" || o.transactionId !== viewing)) {
      setViewing(null);
      (transactionButton.current ?? primary.current)?.focus();
    }
  }, [viewing, o.status, o.transactionId]);
  const closeMatching = () => {
    setMatching(false);
    (payment ? primary : moreButton).current?.focus();
  };
  const closeSnooze = () => {
    setSnoozing(false);
    requestAnimationFrame(() => snoozeButton.current?.focus());
  };
  return (
    <li className={status.state === "overdue" ? "occurrence late" : "occurrence"} data-testid="occurrence" data-title={o.title}>
      <div className="occ-main">
        <span className="main">{o.title}</span>
        <span className="sub">
          <span data-testid="occ-status" data-state={status.state}>{status.label}</span>
          {" · "}
          {o.status === "done" && o.actualPayment ? <>
            <PaymentDates o={o} {...o.actualPayment} />
            {(o.dueDate || (payment && o.payAt !== o.dueAt)) && ` · напомнить ${formatDateTime(o.dueAt)}`}
          </> : o.dueDate ? `платёж ${formatDate(o.dueDate)}, напомнить ${formatDateTime(o.dueAt)}`
            : payment && o.payAt !== o.dueAt ? `платёж ${formatDateTime(o.payAt)}, напомнить ${formatDateTime(o.dueAt)}`
            : formatDateTime(o.dueAt)}
          {o.last && " · последний"}
          {o.edited && <span className="edited"> · изменён</span>}
        </span>
        {o.shortfall != null && (
          <span className="sub shortfall" data-testid="shortfall">
            На счёте не хватит <Money amount={o.shortfall} symbol={o.currencySymbol} currencyCode={o.amountCurrency} minorUnits={o.minorUnits} />
          </span>
        )}
      </div>
      {o.amount != null && <Money amount={o.amount} symbol={o.currencySymbol} currencyCode={o.amountCurrency} minorUnits={o.minorUnits} />}
      <div className="occ-actions" ref={more.ref} onKeyDown={(event) => {
        if (event.key !== "Escape" || (!more.open && !snoozing)) return;
        event.stopPropagation();
        if (snoozing) closeSnooze();
        else {
          more.setOpen(false);
          moreButton.current?.focus();
        }
      }}>
        {open && !snoozing && (
          <>
            <button type="button" ref={primary} className="btn small primary" disabled={done.busy}
              data-testid={payment ? "occ-match-payment" : undefined} onClick={() => {
              more.setOpen(false);
              if (debt && o.debtId) openDebt(o.debtId, true);
              else if (payment || debt) setMatching(true);
              else done.run();
            }}>
              {debt ? "Оплачено" : payment ? "Учесть платёж" : "Выполнено"}
            </button>
            <button type="button" ref={snoozeButton} className="btn small" disabled={done.busy} onClick={() => { more.setOpen(false); setSnoozing(true); }}>
              Отложить
            </button>
            <button type="button" ref={moreButton} className="btn small" aria-expanded={more.open}
              aria-controls={more.open ? moreId : undefined} disabled={done.busy} onClick={() => more.setOpen(!more.open)}>Ещё</button>
            {more.open && (
              <div className="occ-secondary" id={moreId}>
                {payment || debt ? (
                  <button type="button" className="btn small" disabled={done.busy} onClick={() => { more.setOpen(false); done.run(); }}>Отметить выполненным без записи</button>
                ) : (
                  <button type="button" className="btn small" onClick={() => { more.setOpen(false); setMatching(true); }}>Создать операцию</button>
                )}
                {!debt && <button type="button" className="btn small" onClick={() => { more.setOpen(false); setEditing(true); }} data-testid="occ-edit">
                  Изменить
                </button>}
              </div>
            )}
          </>
        )}
        {snoozing && <>
          {SNOOZE.map(([label, until], index) => (
            <button key={label} type="button" className="btn small" autoFocus={index === 0} disabled={snooze.busy} onClick={() => snooze.run(until())}>
              {label}
            </button>
          ))}
          <button type="button" className="btn small" disabled={snooze.busy} onClick={closeSnooze}>Назад</button>
        </>}
        {o.status === "done" && (
          <>
            {o.transactionId && <button type="button" className="btn small" ref={transactionButton}
              data-testid="occ-open-transaction" onClick={() => setViewing(o.transactionId)}>Открыть операцию</button>}
            <button type="button" className="link" onClick={() => reopen.run()} title="Вернуть в ожидание">Вернуть</button>
          </>
        )}
      </div>
      <ErrorText error={done.error ?? snooze.error ?? reopen.error} />
      {viewing && o.status === "done" && viewing === o.transactionId && <LinkedTransaction id={viewing} onClose={() => {
        setViewing(null);
        (transactionButton.current ?? primary.current)?.focus();
      }} />}
      {matching && (
        <PaymentMatch o={o} onClose={closeMatching} onCreate={(revision, allowSeparate) => {
          setMatching(false);
          create(o, revision, allowSeparate, allowSeparate ? () => setMatching(true) : closeMatching);
        }} onLinked={() => {
          setMatching(false);
          onAction?.();
        }} />
      )}
      {editing && (
        <EditOccurrence
          o={o}
          onClose={() => {
            setEditing(false);
            moreButton.current?.focus();
            onAction?.();
          }}
        />
      )}
    </li>
  );
}

function LinkedTransaction({ id, onClose }: { id: string; onClose: () => void }) {
  const settings = useSettings().data;
  const accounts = useAccounts(true).data;
  const query = useQuery({
    queryKey: ["transactions", "linked", id],
    queryFn: () => api.getTransaction(id),
    refetchOnMount: "always",
    gcTime: 0,
    retry: false,
  });
  const t = query.data;
  const destination = t?.toAccountId ? accounts?.find((a) => a.id === t.toAccountId) : null;
  return (
    <Modal title="Связанная операция" onClose={onClose}>
      {query.isFetching ? <p role="status">Загружаем операцию…</p> : query.isError || !t ? (
        <>
          <p role="status">Связанная операция недоступна.</p>
          <button type="button" className="link" onClick={() => void query.refetch()}>Проверить снова</button>
        </>
      ) : (
        <dl className="facts linked-transaction" data-testid="linked-transaction" data-transaction-id={t.id}>
          <dt>Вид операции</dt><dd>{TXN_TYPES[t.type]}</dd>
          <dt>Дата</dt><dd>{formatDate(t.date)}</dd>
          <dt>{t.type === "transfer" ? "Со счёта" : "Счёт"}</dt><dd>{t.accountName} · {t.currencyCode}</dd>
          <dt>{t.type === "transfer" ? "Списано" : "Сумма"}</dt><dd><Money amount={t.amount} symbol={t.currencySymbol} currencyCode={t.currencyCode} minorUnits={t.minorUnits} /></dd>
          {t.type === "transfer" && <>
            <dt>На счёт</dt><dd>{t.toAccountName}{destination && ` · ${destination.currencyCode}`}</dd>
            {t.toAmount != null && <>
              <dt>Зачислено</dt>
              <dd>{destination
                ? <Money amount={t.toAmount} symbol={destination.currencySymbol} currencyCode={destination.currencyCode} minorUnits={destination.minorUnits} />
                : "—"}</dd>
            </>}
          </>}
          {t.payee && <><dt>{t.type === "income" ? "От кого" : "Получатель"}</dt><dd>{t.payee}</dd></>}
          {t.categoryName && <><dt>Категория</dt><dd>{t.categoryName}</dd></>}
          {t.note && settings && settings.hide_amounts !== "1" && <><dt>Комментарий</dt><dd>{t.note}</dd></>}
        </dl>
      )}
      <div className="actions">
        <button type="button" className="btn" autoFocus onClick={onClose}>Закрыть</button>
      </div>
    </Modal>
  );
}

function PaymentMatch({ o, onClose, onLinked, onCreate }: {
  o: Occurrence;
  onClose: () => void;
  onLinked: () => void;
  onCreate: (revision: string, allowSeparate: boolean) => void;
}) {
  const groupId = useId();
  const accountName = useAccounts(true).data?.find((account) => account.id === o.accountId)?.name;
  const settings = useSettings().data;
  const showAmounts = settings !== undefined && settings.hide_amounts !== "1";
  const hiddenMoney = <span className="money"><span aria-hidden="true">{HIDDEN_AMOUNT}</span><span className="sr-only">Сумма скрыта</span></span>;
  const query = useQuery({
    queryKey: ["reminderPaymentReview", o.key],
    queryFn: () => api.reminderPaymentReview(o.key),
    refetchOnMount: "always",
    retry: false,
  });
  const attach = useAction(api.attachReminderPayment, onLinked);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const review = query.isSuccess && !query.isFetching ? query.data : null;
  const candidates = review?.candidates ?? [];
  const selected = candidates.length === 1 ? candidates[0] : candidates.find((c) => c.transactionId === selectedId);
  const error = attach.error ?? (query.error ? String(query.error) : null);
  const openedForm = useRef(false);
  useEffect(() => {
    if (review && review.candidates.length === 0 && !error && !openedForm.current) {
      openedForm.current = true;
      onCreate(review.revision, false);
    }
  }, [review, error, onCreate]);
  return (
    <Modal title={`Учесть платёж · ${o.title}`} onClose={onClose} dismissDisabled={attach.busy}>
      {query.isFetching && !attach.busy && <p className="muted" role="status">Ищем в операциях…</p>}
      {review && candidates.length === 0 && (
        <p className="muted" data-testid="occ-match-empty">Подходящих операций нет.</p>
      )}
      {candidates.length === 1 && <p className="muted">Найдена проведённая операция. Проверьте дату и сумму.</p>}
      {candidates.length > 1 && <p className="muted">Выберите проведённую операцию для связи.</p>}
      {candidates.map((match, index) => {
        const id = `${groupId}-${index}`;
        const note = showAmounts && match.note;
        return <div className="card" data-testid="occ-match-candidate" key={match.transactionId}>
          {candidates.length > 1 && (
            <label className="small">
              <input type="radio" name="reminderPaymentCandidate" checked={selectedId === match.transactionId}
                aria-labelledby={`${id}-choice ${id}-payee ${id}-dates ${id}-amount${note ? ` ${id}-note` : ""}`}
                disabled={attach.busy} onChange={() => setSelectedId(match.transactionId)} />
              <span id={`${id}-choice`}>Выбрать операцию {index + 1}</span>
            </label>
          )}
          <p id={`${id}-payee`}><strong>{match.payee || "Операция"}</strong>{accountName && ` · ${accountName}`}</p>
          <p><PaymentDates id={`${id}-dates`} o={o} date={match.date} type={o.txnType ?? "expense"} /></p>
          {note && <p className="muted" id={`${id}-note`}>{note}</p>}
          <p className="hint">Совпали счёт и {match.matchReason === "payee" ? "получатель" : "категория"}.</p>
          <p id={`${id}-amount`}>В учёте · {showAmounts ? <Money amount={match.amount} symbol={match.currencySymbol} minorUnits={match.minorUnits} /> : hiddenMoney}</p>
          {match.amount !== match.expectedAmount && (
            <p className="warn">Сумма отличается. Ожидалось {showAmounts ? <Money amount={match.expectedAmount} symbol={match.currencySymbol} minorUnits={match.minorUnits} /> : hiddenMoney}.</p>
          )}
        </div>;
      })}
      {review?.moreCandidates && <p className="muted">Показаны 10 последних совпадений.</p>}
      <ErrorText error={error} />
      {error && <button type="button" className="link" disabled={query.isFetching || attach.busy} onClick={() => {
        openedForm.current = false;
        attach.setError(null);
        void query.refetch();
      }}>Проверить снова</button>}
      {selected && <p className="hint" role="status">Связь завершит напоминание. Сумма проведённой операции и остаток на счёте сохранятся.</p>}
      <div className="actions payment-review-actions">
        <button type="button" className="btn" autoFocus disabled={attach.busy} onClick={onClose}>Назад</button>
        {review && candidates.length > 0 && <button type="button" className="btn" disabled={attach.busy || !!error}
          onClick={() => onCreate(review.revision, true)}>
          {o.txnType === "income" ? "Записать отдельный доход" : "Записать отдельный расход"}
        </button>}
        {candidates.length > 0 && <button type="button" className="btn primary" disabled={!selected || attach.busy || !!error} aria-busy={attach.busy}
          onClick={() => {
            if (!selected || openedForm.current) return;
            // После связи обновление календаря вернёт пустой список для завершённого платежа.
            openedForm.current = true;
            attach.run(o.key, selected.transactionId, selected.revision);
          }}>Связать с платежом</button>}
      </div>
    </Modal>
  );
}
