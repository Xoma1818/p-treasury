import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { AccountSelect, AmountInput, amountText, Field } from "../../components/Fields";
import { Hint } from "../../components/Hint";
import { ErrorText, Modal } from "../../components/Modal";
import { Money } from "../../components/Money";
import { api, type DebtCard, type PaymentInput, type RecalcMode } from "../../lib/api";
import { formatDate, today } from "../../lib/dates";
import { parseAmount } from "../../lib/money";
import { useAccounts } from "../../lib/queries";
import { useAction } from "../../lib/useAction";
import { useDebounced } from "../../lib/useDebounced";
import { LoanCompareTable } from "./LoanTools";

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
  const [manual, setManual] = useState<{ principal: string; interest: string } | null>(null);
  const [mode, setMode] = useState<RecalcMode>("reduce_payment");
  useEffect(() => {
    if (!accountId && accounts[0]) setAccountId(accounts[0].id);
  }, [accounts, accountId]);

  const switchEarly = (on: boolean) => {
    setEarly(on);
    setManual(null);
    setAmount("");
  };

  // Досрочка: разбивка суммы и графики «до/после» без записи.
  const total = parseAmount(amount, mu);
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date);
  // Частичный возврат разового займа можно заполнить сразу по частям.
  const needsQuote = early && (monthly || amount.trim() !== "");
  const currentKey = early && total != null && total > 0 && validDate ? `${date}|${total}|${mode}` : null;
  const qKey = useDebounced(currentKey, 250);
  const quote = useQuery({
    queryKey: ["quoteDebtPayment", card.id, qKey],
    queryFn: () => {
      const [d, a, m] = qKey!.split("|");
      return api.quoteDebtPayment(card.id, { date: d, amount: Number(a), kind: "early", mode: monthly ? (m as RecalcMode) : null });
    },
    enabled: !!qKey && qKey === currentKey,
    retry: false,
  });
  const currentRequest = !!currentKey && currentKey === qKey;
  const q = currentRequest && quote.isSuccess && !quote.isFetching ? quote.data : undefined;
  const parts = manual ?? {
    principal: amountText(early ? q?.principal : next?.principalPart, mu),
    interest: amountText(early ? q?.interest : next?.interestPart, mu),
  };

  const save = useAction((input: PaymentInput) => api.payDebt(card.id, input), onClose, { singleSubmit: true });
  const lent = card.direction === "lent";
  const p = parseAmount(parts.principal || "0", mu);
  const i = parseAmount(parts.interest || "0", mu);
  const differs = !early && next ? p !== next.principalPart : true;
  const beforeDue = !!next && date < next.dueDate;

  const splitValid = p !== null && i !== null && p >= 0 && i >= 0 && p + i > 0 && Number.isSafeInteger(p + i);
  const splitError = "Введите основной долг и проценты. Хотя бы одна из сумм должна быть больше нуля.";
  const quoteError = currentRequest && quote.isError ? String(quote.error) : null;
  const paymentStatus = () => {
    if (!early) return null;
    if (!validDate) return "Введите дату платежа.";
    if (needsQuote) {
      if (total === null || total <= 0) return "Введите общую сумму платежа больше нуля.";
      if (quoteError) return quoteError;
      if (!q) return "Рассчитываем разбивку для выбранной суммы и даты…";
    }
    if (!splitValid) return splitError;
    if (needsQuote && p + i !== total) return "Основной долг и проценты в сумме должны совпадать с общей суммой платежа.";
    return null;
  };
  const reason = paymentStatus();
  const changedSplit = !!q && (p !== q.principal || i !== q.interest);
  const submit = () => {
    if (reason) return;
    if (!splitValid) return save.setError(splitError);
    if (!accountId) return save.setError(`Выберите счёт в ${card.currencyCode}`);
    save.run({ date, accountId, principal: p, interest: i, scheduleId: early ? null : (next?.id ?? null), recalcMode: monthly && differs ? mode : null });
  };
  const m = (v: number) => <Money amount={v} symbol={card.currencySymbol} currencyCode={card.currencyCode} minorUnits={mu} />;
  const title = !early ? "Платёж по графику" : monthly ? "Досрочный платёж" : "Частичный возврат";

  return (
    <Modal title={title} onClose={onClose} wide>
      <form className="form" onSubmit={(e) => (e.preventDefault(), submit())}>
        <div className="row">
          <Field label="Дата">{(id) => <input id={id} name="payDate" type="date" value={date} onChange={(e) => {
            if (needsQuote) setManual(null);
            setDate(e.target.value);
          }} />}</Field>
          <Field label={lent ? "Зачислить на счёт" : "Списать со счёта"}>
            {(id) => <AccountSelect id={id} name="payAccount" accounts={accounts} value={accountId} onChange={setAccountId} />}
          </Field>
        </div>
        {next && monthly && (
          <div className="pay-kind">
            {!early && beforeDue && (
              <p className="hint" data-testid="pay-towards">
                Платёж пойдёт в счёт платежа от {formatDate(next.dueDate)} ({m(next.payment)}).
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
            {(id) => <AmountInput id={id} name="earlyAmount" value={amount} onChange={(v) => { setManual(null); setAmount(v); }} minorUnits={mu} autoFocus />}
          </Field>
        )}
        <div className="row">
          <Field label="Основной долг" hint={<>Остаток {m(card.outstanding)}</>}>
            {(id) => <AmountInput id={id} name="principal" value={parts.principal} onChange={(v) => setManual({ ...parts, principal: v })} minorUnits={mu} autoFocus={!early} />}
          </Field>
          <Field label="Проценты" hint={lent ? "доход «Проценты по займам»" : "расход «Проценты по кредитам»"}>
            {(id) => <AmountInput id={id} name="interest" value={parts.interest} onChange={(v) => setManual({ ...parts, interest: v })} minorUnits={mu} />}
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
        {q && !changedSplit && (
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
        {q && !changedSplit && <LoanCompareTable card={card} compare={q.compare} after="После платежа" />}
        {changedSplit && !reason && <p className="hint">График будет пересчитан по введённым частям после сохранения.</p>}
        {reason && <p className="hint" role="status">{reason}</p>}
        {quoteError && <button type="button" className="link" onClick={() => void quote.refetch()}>Повторить расчёт</button>}
        <p className="hint">
          Основной долг запишется переводом {lent ? "со счёта долга на ваш счёт" : "с вашего счёта на счёт долга"}, проценты отдельной операцией.
        </p>
        <ErrorText error={save.error} />
        <div className="actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn primary" aria-busy={save.busy} data-done={save.done || undefined} disabled={save.busy || !!reason}>
            Сохранить
          </button>
        </div>
      </form>
    </Modal>
  );
}
