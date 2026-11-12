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
import { BaseMoney, Money } from "./Money";
import { ChevronDown, ChevronUp } from "lucide-react";

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
  // Р26: очередь — порядок карточек; стрелки меняют места соседей.
  const order = useAction((ids: string[]) => api.setGoalPriority(ids));
  const move = (i: number, d: number) => {
    const ids = goals.map((g) => g.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    order.run(ids);
  };
  const open = goals.some((g) => g.status !== "reached");
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
        {goals.map((g, i) => (
          <div key={g.id} className={`goal-card goal-card-${g.status}`} data-testid="goal" data-name={g.name}>
            <Ring percent={g.percent} size={92} label={`${g.name}: ${g.percent} %`}>
              <b>{g.percent} %</b>
            </Ring>
            <div className="goal-body">
              <div className="goal-title">
                <button className="link main" onClick={() => setEditing(g)}>
                  {g.name}
                </button>
                {goals.length > 1 && (
                  <span className="goal-order">
                    <button className="icon-btn" aria-label={`Важнее: ${g.name}`} title="Важнее" disabled={i === 0 || order.busy} onClick={() => move(i, -1)}>
                      <ChevronUp size={14} aria-hidden />
                    </button>
                    <button className="icon-btn" aria-label={`Менее важна: ${g.name}`} title="Менее важна" disabled={i === goals.length - 1 || order.busy} onClick={() => move(i, 1)}>
                      <ChevronDown size={14} aria-hidden />
                    </button>
                  </span>
                )}
                {g.shareBp != null && g.shareBp > 0 && <span className="muted small"> · {g.shareBp / 100} % свободных</span>}
              </div>
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
      {open && <SplitHint />}
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
  const [share, setShare] = useState(goal?.shareBp != null ? String(goal.shareBp / 100).replace(".", ",") : "");
  const save = useAction(
    async (t: number) => {
      const input = { name, target: t, currencyCode: code, accountId: accountId || null, deadline: deadline || null, reserve: canReserve && reserve };
      const bp = share.trim() === "" ? null : Math.round(Number(share.replace(",", ".").replace("%", "").trim()) * 100);
      if (bp != null && (!Number.isFinite(bp) || bp < 0 || bp > 10_000)) throw "Доля — от 0 до 100 %";
      const id = goal ? (await api.updateGoal(goal.id, input), goal.id) : await api.createGoal(input);
      if (bp !== (goal?.shareBp ?? null)) await api.setGoalShare(id, bp);
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
        <Field label="Доля свободных денег, %" hint="Для подсказки «Разложить свободные деньги». Пусто — по очереди: сначала самая важная цель.">
          {(id) => <input id={id} name="goalShare" className="pct-input" inputMode="decimal" placeholder="—" value={share} onChange={(e) => setShare(e.target.value)} />}
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

/** Р26: подсказка, как разложить «Свободно до дохода» по целям. Переводов не делает. */
function SplitHint() {
  const [shown, setShown] = useState(false);
  const split = useQuery({ queryKey: ["goalSplit"], queryFn: () => api.goalSplit(), enabled: shown });
  const s = split.data;
  return (
    <div className="goal-split" data-testid="goal-split">
      {!shown ? (
        <button className="link" onClick={() => setShown(true)} data-testid="goal-split-open">
          Разложить свободные деньги по целям
        </button>
      ) : !s ? (
        <span className="muted small">Считаю…</span>
      ) : s.total <= 0 ? (
        <p className="muted small">Свободных денег до дохода сейчас нет — раскладывать нечего.</p>
      ) : (
        <>
          <div className="muted small">
            Свободно до дохода <BaseMoney amount={s.total} />. {s.mode === "share" ? "По долям целей:" : "По очереди, сначала самая важная:"}
          </div>
          <ul>
            {s.parts.map((p) => (
              <li key={p.goalId} data-testid="goal-split-part" data-name={p.name}>
                <span>{p.name}</span>
                <BaseMoney amount={p.amount} />
              </li>
            ))}
          </ul>
          <p className="hint">
            {s.left > 0 && (
              <>
                Останется свободным: <BaseMoney amount={s.left} />.{" "}
              </>
            )}
            Это подсказка: деньги никуда не переводятся, пополните цели сами.
            {s.skipped.length > 0 && <> Без курса валюты пропущены: {s.skipped.join(", ")}.</>}
          </p>
        </>
      )}
      <ErrorText error={split.error ? String(split.error) : null} />
    </div>
  );
}
