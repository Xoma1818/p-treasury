import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Goal } from "../lib/api";
import { formatDate, monthGenitive, today } from "../lib/dates";
import { formatAmount, parseAmount } from "../lib/money";
import { useAccounts, useCurrencies, useSettings } from "../lib/queries";
import { useAction } from "../lib/useAction";
import { Ring } from "./Dashboard";
import { AccountSelect, AmountInput, amountText, Field } from "./Fields";
import { Hint } from "./Hint";
import { ErrorText, Modal } from "./Modal";
import { Money } from "./Money";

/** Счета, внутри которых можно держать резерв. */
const RESERVE_TYPES: string[] = ["cash", "debit", "savings"];

/** «к марту 2027» */
const byMonth = (date: string) => `к ${monthGenitive(date.slice(0, 7))} ${date.slice(0, 4)}`;

function forecast(g: Goal) {
  if (g.status === "reached") return "Цель достигнута";
  if (g.missingRate) return "Нет курса валюты счёта";
  if (g.forecastFar) return "При нынешнем темпе — больше 100 лет";
  if (!g.forecastDate) return "Пока нет пополнений за 3 месяца";
  return `При нынешнем темпе — ${byMonth(g.forecastDate)}`;
}

/** Цели накоплений на Главной: кольцо прогресса, прогноз даты и «Пополнить». */
export function GoalsCard() {
  const goals = useQuery({ queryKey: ["goals"], queryFn: api.listGoals }).data ?? [];
  const [editing, setEditing] = useState<Goal | "new" | null>(null);
  const [depositing, setDepositing] = useState<Goal | null>(null);
  return (
    <div className="card" data-testid="goals">
      <div className="screen-head">
        <h2>
          Цели накоплений
          <Hint title="Цели накоплений" example="«Отпуск 150 000 ₽ к июлю»">
            Задайте сумму и срок. Прогресс берётся с привязанного счёта или из ручных пополнений, а дата достижения считается по темпу последних трёх месяцев.
          </Hint>
        </h2>
        <button className="btn small" onClick={() => setEditing("new")}>
          + Цель
        </button>
      </div>
      {goals.length === 0 && <p className="muted">На что копите? Отпуск, машина, подушка: приложение покажет, сколько уже есть и когда хватит.</p>}
      <div className="goal-grid">
        {goals.map((g) => (
          <div key={g.id} className={`goal-card goal-card-${g.status}`} data-testid="goal" data-name={g.name}>
            <Ring percent={g.percent} size={92} label={`${g.name}: ${g.percent} %`}>
              <b>{g.percent} %</b>
            </Ring>
            <div className="goal-body">
              <button className="link main" onClick={() => setEditing(g)}>
                {g.name}
              </button>
              <div className="goal-sum">
                <Money amount={g.saved} symbol={g.currencySymbol} minorUnits={g.minorUnits} />
                <span className="muted">
                  {" "}
                  из {formatAmount(g.target, g.minorUnits)} {g.currencySymbol}
                </span>
              </div>
              <div className="sub" data-testid="goal-forecast">{forecast(g)}</div>
              {g.deadline && g.status !== "reached" && (
                <div className={g.status === "behind" ? "sub warn" : "sub"} data-testid="goal-need">
                  {g.status === "behind" ? "Не успеваете " : "Срок "}
                  {byMonth(g.deadline)}
                  {g.needPerMonth != null && (
                    <>
                      : нужно {formatAmount(g.needPerMonth, g.minorUnits)} {g.currencySymbol} в месяц
                    </>
                  )}
                </div>
              )}
              {g.reserve ? (
                <div className="sub" data-testid="goal-reserve">
                  Резерв на счёте «{g.accountName}»{" "}
                  <button className="link" data-testid="goal-deposit" onClick={() => setDepositing(g)}>
                    + Отложить
                  </button>
                </div>
              ) : g.accountName ? (
                <div className="sub">Счёт «{g.accountName}»</div>
              ) : (
                g.status !== "reached" && (
                  <button className="link" data-testid="goal-deposit" onClick={() => setDepositing(g)}>
                    + Пополнить
                  </button>
                )
              )}
            </div>
          </div>
        ))}
      </div>
      {editing && <GoalForm goal={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {depositing && <DepositForm goal={depositing} onClose={() => setDepositing(null)} />}
    </div>
  );
}

function GoalForm({ goal, onClose }: { goal: Goal | null; onClose: () => void }) {
  const base = useSettings().data?.base_currency ?? "RUB";
  const currencies = useCurrencies().data ?? [];
  const accounts = (useAccounts().data ?? []).filter((a) => a.type !== "credit");
  const [name, setName] = useState(goal?.name ?? "");
  const [accountId, setAccountId] = useState(goal?.accountId ?? "");
  const account = accounts.find((a) => a.id === accountId);
  const [currency, setCurrency] = useState(goal?.currencyCode ?? base);
  const code = account?.currencyCode ?? currency;
  const minor = currencies.find((c) => c.code === code)?.minorUnits ?? 2;
  const [target, setTarget] = useState(amountText(goal?.target ?? null, minor));
  const [deadline, setDeadline] = useState(goal?.deadline ?? "");
  // Резерв — только на быстрых счетах: деньги лежат вместе с остальными.
  const canReserve = !!account && RESERVE_TYPES.includes(account.type);
  const [reserve, setReserve] = useState(goal?.reserve ?? false);
  const save = useAction(
    async (t: number) => {
      const input = { name, target: t, currencyCode: code, accountId: accountId || null, deadline: deadline || null, reserve: canReserve && reserve };
      if (goal) return api.updateGoal(goal.id, input);
      await api.createGoal(input);
    },
    onClose,
    { celebrate: true },
  );
  const remove = useAction(() => api.deleteGoal(goal!.id), onClose);
  const submit = () => {
    const t = parseAmount(target, minor);
    if (t === null || t <= 0) return save.setError("Укажите, сколько накопить");
    save.run(t);
  };
  return (
    <Modal title={goal ? goal.name : "Новая цель"} onClose={onClose}>
      <form className="form" onSubmit={(e) => (e.preventDefault(), submit())}>
        <Field label="На что копите">
          {(id) => <input id={id} name="goalName" placeholder="Например, «Отпуск»" value={name} onChange={(e) => setName(e.target.value)} autoFocus />}
        </Field>
        <div className="row">
          <Field label="Сколько нужно">{(id) => <AmountInput id={id} name="goalTarget" value={target} onChange={setTarget} minorUnits={minor} />}</Field>
          {!account && (
            <Field label="Валюта">
              {(id) => (
                <select id={id} name="goalCurrency" value={currency} onChange={(e) => setCurrency(e.target.value)}>
                  {currencies.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code} {c.symbol}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}
        </div>
        <Field label="К какому сроку" hint="Можно оставить пустым: тогда покажем только прогноз.">
          {(id) => <input id={id} name="goalDeadline" type="date" min={today()} value={deadline} onChange={(e) => setDeadline(e.target.value)} />}
        </Field>
        <Field
          label="Где копите"
          hint={
            !account
              ? "Без счёта: пополнения отмечаете кнопкой «+ Пополнить»."
              : canReserve && reserve
                ? "Отложенное отмечаете кнопкой «+ Отложить»; оно не считается свободным до дохода."
                : "Накоплено = остаток этого счёта."
          }
        >
          {(id) => <AccountSelect id={id} name="goalAccount" accounts={accounts} value={accountId} onChange={setAccountId} placeholder="Без счёта, пополняю вручную" />}
        </Field>
        {canReserve && (
          <label className="check" data-testid="goal-reserve-toggle">
            <input type="checkbox" name="goalReserve" checked={reserve} onChange={(e) => setReserve(e.target.checked)} />
            Резерв внутри счёта: деньги лежат вместе с остальными
          </label>
        )}
        <ErrorText error={save.error ?? remove.error} />
        <div className="actions">
          {goal && (
            <button type="button" className="btn danger" onClick={() => remove.run()} disabled={remove.busy}>
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

function DepositForm({ goal, onClose }: { goal: Goal; onClose: () => void }) {
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today());
  const [take, setTake] = useState(false);
  const save = useAction((v: number) => api.goalDeposit(goal.id, date, take ? -v : v), onClose, { celebrate: true });
  const submit = () => {
    const v = parseAmount(amount, goal.minorUnits);
    if (v === null || v <= 0) return save.setError("Укажите сумму");
    save.run(v);
  };
  return (
    <Modal title={`Цель «${goal.name}»`} onClose={onClose}>
      <form className="form" onSubmit={(e) => (e.preventDefault(), submit())}>
        <div className="tabs small">
          <button type="button" className={take ? "tab" : "tab active"} onClick={() => setTake(false)}>
            Отложить
          </button>
          <button type="button" className={take ? "tab active" : "tab"} onClick={() => setTake(true)}>
            Взять из цели
          </button>
        </div>
        <div className="row">
          <Field label={`Сумма, ${goal.currencySymbol}`}>{(id) => <AmountInput id={id} name="amount" value={amount} onChange={setAmount} minorUnits={goal.minorUnits} autoFocus />}</Field>
          <Field label="Дата">{(id) => <input id={id} name="date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
        </div>
        <p className="muted">
          Осталось {formatAmount(goal.remaining, goal.minorUnits)} {goal.currencySymbol}
          {goal.deadline && <> до {formatDate(goal.deadline)}</>}.
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
