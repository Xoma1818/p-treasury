import { useState } from "react";
import { api, REPEATS, type Occurrence, type Reminder, type ReminderInput, type Repeat } from "../lib/api";
import { addDays, formatDate, formatDateTime, isoDateTime, nowLocal, today } from "../lib/dates";
import { parseAmount } from "../lib/money";
import { useAccounts, useCategories } from "../lib/queries";
import { useUi } from "../lib/store";
import { useAction } from "../lib/useAction";
import { AccountSelect, AmountInput, amountText, CategorySelect, Field } from "./Fields";
import { ErrorText, Modal } from "./Modal";
import { Money } from "./Money";

/** Диалог напоминания: новое (можно с датой из календаря) или правка. */
export function ReminderForm({ reminder, date, onClose }: { reminder?: Reminder; date?: string; onClose: () => void }) {
  const accounts = useAccounts().data ?? [];
  const categories = useCategories().data ?? [];
  const [title, setTitle] = useState(reminder?.title ?? "");
  const [day, setDay] = useState(reminder?.startAt.slice(0, 10) ?? date ?? today());
  const [time, setTime] = useState(reminder?.startAt.slice(11, 16) ?? "09:00");
  const [repeat, setRepeat] = useState<Repeat>(reminder?.repeat ?? "once");
  const [endDate, setEndDate] = useState(reminder?.endDate ?? "");
  const [amount, setAmount] = useState(amountText(reminder?.amount));
  const [txnType, setTxnType] = useState<"expense" | "income">(reminder?.txnType ?? "expense");
  const [accountId, setAccountId] = useState(reminder?.accountId ?? "");
  const [categoryId, setCategoryId] = useState(reminder?.categoryId ?? "");
  const [note, setNote] = useState(reminder?.note ?? "");

  const save = useAction((input: ReminderInput) => (reminder ? api.updateReminder(reminder.id, input) : api.createReminder(input)), onClose, { celebrate: true });
  const remove = useAction(() => api.deleteReminder(reminder!.id), onClose);

  const submit = () => {
    const value = amount.trim() ? parseAmount(amount) : null;
    if (amount.trim() && (value === null || value <= 0)) return save.setError("Сумма должна быть больше нуля");
    save.run({
      title,
      startAt: `${day}T${time || "09:00"}`,
      repeat,
      // Ежемесячно — в число первой даты (31-е в коротком месяце — последний день).
      dayOfMonth: repeat === "monthly" ? Number(day.slice(8, 10)) : null,
      endDate: repeat !== "once" && endDate ? endDate : null,
      amount: value,
      txnType: value ? txnType : null,
      accountId: accountId || null,
      categoryId: categoryId || null,
      note: note || null,
    });
  };

  return (
    <Modal title={reminder ? "Напоминание" : "Новое напоминание"} onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Название">{(id) => <input id={id} name="reminderTitle" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />}</Field>
        <div className="row">
          <Field label="Дата">{(id) => <input id={id} name="reminderDate" type="date" value={day} onChange={(e) => setDay(e.target.value)} />}</Field>
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
          {repeat !== "once" && (
            <Field label="Повторять до (необязательно)">
              {(id) => <input id={id} name="reminderEnd" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />}
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
        <Field label="Комментарий">{(id) => <input id={id} name="reminderNote" value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        <ErrorText error={save.error ?? remove.error} />
        <div className="actions">
          {reminder && (
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

const SNOOZE: [string, () => string][] = [
  ["на час", () => isoDateTime(new Date(Date.now() + 3600_000))],
  ["до завтра", () => `${addDays(today(), 1)}T09:00`],
  ["на 3 дня", () => `${addDays(today(), 3)}T09:00`],
];

/** «Создать операцию»: для своего напоминания — форма операции с суммой, для долга — отметка платежа. */
function useCreateFromReminder() {
  const { openTxnForm, openDebt } = useUi();
  return (o: Occurrence) => {
    if (o.key.source === "debt" && o.debtId) return openDebt(o.debtId, true);
    openTxnForm({
      mode: "new",
      type: o.txnType ?? "expense",
      date: today(),
      prefill: { amount: o.amount, accountId: o.accountId, categoryId: o.categoryId, payee: o.title, note: o.note },
      onSaved: (id) => api.completeReminder(o.key, id),
    });
  };
}

/** Строка срабатывания с действиями «Выполнено», «Отложить», «Создать операцию». */
export function OccurrenceItem({ o, onAction }: { o: Occurrence; onAction?: () => void }) {
  const [snoozing, setSnoozing] = useState(false);
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
        </span>
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
    </li>
  );
}
