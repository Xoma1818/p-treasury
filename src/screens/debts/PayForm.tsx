import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { AccountSelect, AmountInput, amountText, Field } from "../../components/Fields";
import { Hint } from "../../components/Hint";
import { ErrorText, Modal } from "../../components/Modal";
import { Money } from "../../components/Money";
import { api, type DebtCard, type PaymentInput, type RecalcMode } from "../../lib/api";
import { formatDate, today } from "../../lib/dates";
import { formatAmount, parseAmount } from "../../lib/money";
import { useAccounts } from "../../lib/queries";
import { useAction } from "../../lib/useAction";
import { useDebounced } from "../../lib/useDebounced";

/** Окно платежа. По графику: при дате раньше ближайшего платежа — подсказка «в счёт платежа от …»
 *  и переключатель «считать досрочкой». Досрочно: сумма делится на проценты и долг по quoteDebtPayment
 *  (части можно поправить), строка «новый платёж / срок до / экономия». */
export function PayForm({ card, early: startEarly, onClose }: { card: DebtCard; early: boolean; onClose: () => void }) {
  const accounts = (useAccounts().data ?? []).filter((a) => a.currencyCode === card.currencyCode);
  const next = card.nextPayment;
  const mu = card.minorUnits;
  const monthly = card.repaymentType !== "bullet";
  const [early, setEarly] = useState(startEarly || !next);
  const [date, setDate] = useState(!early && next && next.dueDate < today() ? next.dueDate : today());
  const [accountId, setAccountId] = useState(card.defaultAccountId ?? "");
  const [amount, setAmount] = useState("");
  const [principal, setPrincipal] = useState(early ? "" : amountText(next?.principalPart ?? null, mu));
  const [interest, setInterest] = useState(early ? "" : amountText(next ? next.interestPart : 0, mu));
  const [mode, setMode] = useState<RecalcMode>("reduce_payment");
  useEffect(() => {
    if (!accountId && accounts[0]) setAccountId(accounts[0].id);
  }, [accounts, accountId]);

  const switchEarly = (on: boolean) => {
    setEarly(on);
    if (on) {
      setPrincipal("");
      setInterest("");
      setAmount("");
    } else if (next) {
      setPrincipal(amountText(next.principalPart, mu));
      setInterest(amountText(next.interestPart, mu));
    }
  };

  // Досрочка: разбивка суммы и графики «до/после» без записи.
  const total = parseAmount(amount, mu);
  const qKey = useDebounced(early && total && total > 0 && /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}|${total}|${mode}` : null, 250);
  const quote = useQuery({
    queryKey: ["quoteDebtPayment", card.id, qKey],
    queryFn: () => {
      const [d, a, m] = qKey!.split("|");
      return api.quoteDebtPayment(card.id, { date: d, amount: Number(a), kind: "early", mode: monthly ? (m as RecalcMode) : null });
    },
    enabled: !!qKey,
    retry: false,
  });
  // Части подставляются, когда меняются сумма или дата; правка руками остаётся до следующей смены.
  const applied = useRef<string | null>(null);
  useEffect(() => {
    const q = quote.data;
    if (!q || !qKey) return;
    const split = qKey.split("|").slice(0, 2).join("|");
    if (applied.current === split) return;
    applied.current = split;
    setPrincipal(amountText(q.principal, mu));
    setInterest(amountText(q.interest, mu));
  }, [quote.data, qKey, mu]);

  const save = useAction((input: PaymentInput) => api.payDebt(card.id, input), onClose, { celebrate: true });
  const lent = card.direction === "lent";
  const p = parseAmount(principal || "0", mu);
  const i = parseAmount(interest || "0", mu);
  const differs = !early && next ? p !== next.principalPart : true;
  const beforeDue = !!next && date < next.dueDate;

  const submit = () => {
    if (p === null || p < 0 || i === null || i < 0 || p + i <= 0) return save.setError("Проверьте суммы");
    if (!accountId) return save.setError(`Выберите счёт в ${card.currencyCode}`);
    save.run({ date, accountId, principal: p, interest: i, scheduleId: early ? null : (next?.id ?? null), recalcMode: monthly && differs ? mode : null });
  };
  const m = (v: number) => <Money amount={v} symbol={card.currencySymbol} minorUnits={mu} />;
  const q = early ? quote.data : undefined;
  const title = !early ? "Платёж по графику" : monthly ? "Досрочный платёж" : "Частичный возврат";

  return (
    <Modal title={title} onClose={onClose}>
      <form className="form" onSubmit={(e) => (e.preventDefault(), submit())}>
        <div className="row">
          <Field label="Дата">{(id) => <input id={id} name="payDate" type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
          <Field label={lent ? "Зачислить на счёт" : "Списать со счёта"}>
            {(id) => <AccountSelect id={id} name="payAccount" accounts={accounts} value={accountId} onChange={setAccountId} />}
          </Field>
        </div>
        {next && monthly && (
          <div className="pay-kind">
            {!early && beforeDue && (
              <p className="hint" data-testid="pay-towards">
                Платёж пойдёт в счёт платежа от {formatDate(next.dueDate)} ({formatAmount(next.payment, mu)} {card.currencySymbol}).
              </p>
            )}
            <label className="check">
              <input type="checkbox" name="asEarly" checked={early} onChange={(e) => switchEarly(e.target.checked)} /> Считать досрочкой
              <Hint of="pay.early" />
            </label>
          </div>
        )}
        {early && (
          <Field label={monthly ? "Сумма досрочки" : "Сумма возврата"} help="pay.amount">
            {(id) => <AmountInput id={id} name="earlyAmount" value={amount} onChange={setAmount} minorUnits={mu} autoFocus />}
          </Field>
        )}
        <div className="row">
          <Field label="Основной долг" hint={`Остаток ${formatAmount(card.outstanding, mu)} ${card.currencySymbol}`}>
            {(id) => <AmountInput id={id} name="principal" value={principal} onChange={setPrincipal} minorUnits={mu} autoFocus={!early} />}
          </Field>
          <Field label="Проценты" hint={lent ? "доход «Проценты по займам»" : "расход «Проценты по кредитам»"}>
            {(id) => <AmountInput id={id} name="interest" value={interest} onChange={setInterest} minorUnits={mu} />}
          </Field>
        </div>
        {monthly && differs && (
          <Field label="Как пересчитать оставшийся график">
            {(id) => (
              <select id={id} name="recalcMode" value={mode} onChange={(e) => setMode(e.target.value as RecalcMode)}>
                <option value="reduce_payment">Уменьшить платёж, срок прежний</option>
                <option value="reduce_term">Уменьшить срок, платёж прежний</option>
              </select>
            )}
          </Field>
        )}
        {q && (
          <div className="card preview pay-quote" data-testid="pay-quote">
            {q.newPayment > 0 ? (
              <>
                новый платёж <b>{m(q.newPayment)}</b> / срок до <b>{formatDate(q.after.totals.maturityDate)}</b>
              </>
            ) : (
              <b>долг будет погашен</b>
            )}{" "}
            / экономия <b>{m(Math.max(0, q.savings))}</b>
          </div>
        )}
        {early && quote.error && <p className="hint warn">{String(quote.error)}</p>}
        <p className="hint">
          Основной долг запишется переводом {lent ? "со счёта долга на ваш счёт" : "с вашего счёта на счёт долга"}, проценты отдельной операцией.
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
