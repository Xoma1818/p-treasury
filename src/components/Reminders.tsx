import { useState } from "react";
import { api, REPEATS, type Occurrence, type Reminder, type ReminderInput, type ReminderKey, type Repeat } from "../lib/api";
import { addDays, formatDate, formatDateTime, isoDateTime, nowLocal, today } from "../lib/dates";
import { parseAmount } from "../lib/money";
import { useAccounts, useCategories, useSettings } from "../lib/queries";
import { useUi } from "../lib/store";
import { useAction } from "../lib/useAction";
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
          за {d} дн. ×
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
  onClose,
}: {
  reminder?: Reminder;
  date?: string;
  preset?: Partial<ReminderInput>;
  from?: ReminderKey;
  onClose: () => void;
}) {
  const accounts = useAccounts().data ?? [];
  const categories = useCategories().data ?? [];
  const settings = useSettings().data;
  const [title, setTitle] = useState(reminder?.title ?? preset?.title ?? "");
  const [day, setDay] = useState(from?.scheduledAt.slice(0, 10) ?? reminder?.startAt.slice(0, 10) ?? preset?.startAt?.slice(0, 10) ?? date ?? today());
  const [time, setTime] = useState(reminder?.startAt.slice(11, 16) ?? preset?.startAt?.slice(11, 16) ?? "09:00");
  const [repeat, setRepeat] = useState<Repeat>(reminder?.repeat ?? preset?.repeat ?? "once");
  const [endMode, setEndMode] = useState<EndMode>(reminder?.endDate ? "date" : "never");
  const [endDate, setEndDate] = useState(reminder?.endDate ?? "");
  const [count, setCount] = useState("12");
  const [amount, setAmount] = useState(amountText(reminder?.amount ?? preset?.amount));
  const [lastAmount, setLastAmount] = useState(amountText(reminder?.lastAmount));
  const [txnType, setTxnType] = useState<"expense" | "income">(reminder?.txnType ?? "expense");
  const [accountId, setAccountId] = useState(reminder?.accountId ?? "");
  const [categoryId, setCategoryId] = useState(reminder?.categoryId ?? "");
  const [note, setNote] = useState(reminder?.note ?? preset?.note ?? "");
  const saved = reminder?.leadDays ?? preset?.leadDays;
  const [leadMode, setLeadMode] = useState<LeadMode>(saved == null ? "default" : saved === "" ? "none" : "own");
  const [lead, setLead] = useState<number[]>(saved ? parseLead(saved) : [3, 1]);
  const defaults = parseLead(settings?.reminder_lead_days ?? "3,1");

  const save = useAction(
    (input: ReminderInput) =>
      from ? api.splitReminder(from, input) : reminder ? api.updateReminder(reminder.id, input) : api.createReminder(input),
    onClose,
    { celebrate: true },
  );
  const remove = useAction(() => api.deleteReminder(reminder!.id), onClose);

  const series = repeat !== "once";
  const ends = series && endMode !== "never";
  const submit = () => {
    const value = amount.trim() ? parseAmount(amount) : null;
    if (amount.trim() && (value === null || value <= 0)) return save.setError("Сумма должна быть больше нуля");
    const last = ends && value && lastAmount.trim() ? parseAmount(lastAmount) : null;
    if (ends && value && lastAmount.trim() && (last === null || last <= 0)) return save.setError("Последний платёж должен быть больше нуля");
    const n = Number(count);
    if (series && endMode === "count" && !(Number.isInteger(n) && n >= 1 && n <= 600)) return save.setError("Сколько раз: от 1 до 600");
    save.run({
      title,
      startAt: `${day}T${time || "09:00"}`,
      repeat,
      // Ежемесячно — в число первой даты (31-е в коротком месяце — последний день).
      dayOfMonth: repeat === "monthly" ? Number(day.slice(8, 10)) : null,
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
    <Modal title={from ? "Этот и следующие платежи" : reminder ? "Напоминание" : "Новое напоминание"} onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Название">{(id) => <input id={id} name="reminderTitle" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />}</Field>
        <div className="row">
          <Field label={from ? "С какого дня" : "Дата"}>{(id) => <input id={id} name="reminderDate" type="date" value={day} onChange={(e) => setDay(e.target.value)} />}</Field>
          <Field label="Время">{(id) => <input id={id} name="reminderTime" type="time" value={time} onChange={(e) => setTime(e.target.value)} />}</Field>
        </div>
        <div className="row">
          <Field label="Повтор">
            {(id) => (
              <select id={id} name="repeat" value={repeat} onChange={(e) => setRepeat(e.target.value as Repeat)}>
                {Object.entries(REPEATS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {series && (
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
        {repeat === "monthly" && <p className="hint">Каждый месяц {Number(day.slice(8, 10))}-го; если такого числа нет, в последний день месяца.</p>}
        <div className="row">
          <Field label="Сумма (необязательно)">{(id) => <AmountInput id={id} name="reminderAmount" value={amount} onChange={setAmount} />}</Field>
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
            {(id) => <AmountInput id={id} name="reminderLastAmount" value={lastAmount} onChange={setLastAmount} />}
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
        <ErrorText error={save.error ?? remove.error} />
        <div className="actions">
          {reminder && !from && (
            <button type="button" className="btn danger" onClick={() => remove.run()}>
              Удалить
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

/** Правка одного платежа серии: своя сумма и другой день; или переход к «этот и следующие». */
function EditOccurrence({ o, onClose }: { o: Occurrence; onClose: () => void }) {
  const [amount, setAmount] = useState(amountText(o.amount));
  const [day, setDay] = useState(o.payAt.slice(0, 10));
  const [time, setTime] = useState(o.payAt.slice(11, 16));
  const [following, setFollowing] = useState<Reminder | null>(null);
  const save = useAction((a: number | null, moved: string | null) => api.editReminderOccurrence(o.key, a, moved), onClose);
  const reset = useAction(() => api.editReminderOccurrence(o.key, null, null), onClose);
  const loadSeries = useAction(() => api.getReminder(o.key.refId).then(setFollowing));
  if (following) return <ReminderForm reminder={following} from={o.key} onClose={onClose} />;
  const submit = () => {
    const value = amount.trim() ? parseAmount(amount) : null;
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
          <Field label="Сумма">{(id) => <AmountInput id={id} name="occAmount" value={amount} onChange={setAmount} />}</Field>
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
        {reminderId ? "🔔 Напоминание" : label}
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

/** «Создать операцию»: для своего напоминания — форма операции с суммой, для долга — отметка платежа. */
function useCreateFromReminder() {
  const { openTxnForm, openDebt } = useUi();
  const accounts = useAccounts().data ?? [];
  const base = useSettings().data?.base_currency;
  return (o: Occurrence) => {
    if (o.key.source === "debt" && o.debtId) return openDebt(o.debtId, true);
    // Сумма напоминания — в основной валюте: на счёт в другой валюте её не подставляем.
    const foreign = accounts.find((a) => a.id === o.accountId)?.currencyCode !== base && o.accountId != null;
    openTxnForm({
      mode: "new",
      type: o.txnType ?? "expense",
      date: today(),
      prefill: { amount: foreign ? null : o.amount, accountId: o.accountId, categoryId: o.categoryId, payee: o.title, note: o.note },
      onSaved: (id) => api.completeReminder(o.key, id),
    });
  };
}

/** Строка срабатывания с действиями «Выполнено», «Отложить», «Создать операцию». */
export function OccurrenceItem({ o, onAction }: { o: Occurrence; onAction?: () => void }) {
  const [snoozing, setSnoozing] = useState(false);
  const [editing, setEditing] = useState(false);
  const done = useAction(() => api.completeReminder(o.key), onAction);
  const reopen = useAction(() => api.reopenReminder(o.key), onAction);
  const snooze = useAction((until: string) => api.snoozeReminder(o.key, until), onAction);
  const create = useCreateFromReminder();
  const open = o.status === "pending" || o.status === "snoozed";
  const late = open && o.dueAt <= nowLocal();
  return (
    <li className={late ? "occurrence late" : "occurrence"} data-testid="occurrence" data-title={o.title}>
      <div className="occ-main">
        <span className="main">{o.title}</span>
        <span className="sub">
          {o.dueDate ? `платёж ${formatDate(o.dueDate)}, напомнить ${formatDateTime(o.dueAt)}` : formatDateTime(o.dueAt)}
          {o.status === "snoozed" && " · отложено"}
          {o.status === "done" && " · выполнено"}
          {o.last && " · последний"}
          {o.edited && <span className="edited"> · изменён</span>}
        </span>
        {o.shortfall != null && (
          <span className="sub shortfall" data-testid="shortfall">
            На счёте не хватит <Money amount={o.shortfall} symbol={o.currencySymbol} minorUnits={o.minorUnits} />
          </span>
        )}
      </div>
      {o.amount != null && <Money amount={o.amount} symbol={o.currencySymbol} minorUnits={o.minorUnits} />}
      <div className="occ-actions">
        {open && !snoozing && (
          <>
            <button className="btn small primary" onClick={() => create(o)}>
              {o.key.source === "debt" ? "Оплачено" : "Создать операцию"}
            </button>
            <button className="btn small" onClick={() => done.run()}>
              Выполнено
            </button>
            <button className="btn small" onClick={() => setSnoozing(true)}>
              Отложить
            </button>
            {o.key.source === "reminder" && (
              <button className="btn small" onClick={() => setEditing(true)} data-testid="occ-edit">
                Изменить
              </button>
            )}
          </>
        )}
        {snoozing &&
          SNOOZE.map(([label, until]) => (
            <button key={label} className="btn small" onClick={() => snooze.run(until())}>
              {label}
            </button>
          ))}
        {o.status === "done" && (
          <button className="link" onClick={() => reopen.run()} title="Вернуть в ожидание">
            Вернуть
          </button>
        )}
      </div>
      <ErrorText error={done.error ?? snooze.error ?? reopen.error} />
      {editing && (
        <EditOccurrence
          o={o}
          onClose={() => {
            setEditing(false);
            onAction?.();
          }}
        />
      )}
    </li>
  );
}
