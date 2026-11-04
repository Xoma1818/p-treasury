import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Txn } from "../lib/api";
import { formatDate, monthTitle, today } from "../lib/dates";
import { amountToInput, parseAmount } from "../lib/money";
import { useAccounts, useMonthOf } from "../lib/queries";
import { useAction } from "../lib/useAction";
import { AccountSelect, AmountInput, Field } from "./Fields";
import { ErrorText, Modal } from "./Modal";
import { Money } from "./Money";

/** 0.29: возврат за покупку. Деньги приходят на счёт, а в бюджете это минус
 *  расход категории покупки — в месяце покупки (по умолчанию) или возврата. */
export function RefundDialog({ purchaseId, refund, onClose }: { purchaseId: string; refund?: Txn; onClose: () => void }) {
  const info = useQuery({ queryKey: ["refundInfo", purchaseId, refund?.id ?? null], queryFn: () => api.refundInfo(purchaseId, refund?.id) });
  if (!info.data) {
    return (
      <Modal title="Возврат" onClose={onClose}>
        <p className="hint">{info.error ? String(info.error) : "Загрузка…"}</p>
      </Modal>
    );
  }
  return <RefundForm info={info.data} refund={refund} onClose={onClose} />;
}

function RefundForm({ info, refund, onClose }: { info: NonNullable<Awaited<ReturnType<typeof api.refundInfo>>>; refund?: Txn; onClose: () => void }) {
  const p = info.purchase;
  const accounts = useAccounts(false).data ?? [];
  const [amount, setAmount] = useState(amountToInput(refund?.amount ?? info.left, p.minorUnits));
  const [date, setDate] = useState(refund?.date ?? today());
  const [accountId, setAccountId] = useState(refund?.accountId ?? p.accountId);
  const [inPurchase, setInPurchase] = useState(refund ? refund.countDate !== null : true);
  const [note, setNote] = useState(refund?.note ?? "");
  const refundMonth = useMonthOf(date).data?.month;
  const save = useAction(() => {
    const value = parseAmount(amount, p.minorUnits);
    if (value === null || value <= 0) return Promise.reject("введите сумму возврата");
    const input = { of: p.id, date, accountId, amount: value, inPurchaseMonth: inPurchase, note: note.trim() || null };
    return refund ? api.updateRefund(refund.id, input) : api.createRefund(input);
  }, onClose);
  const remove = useAction(() => api.deleteTransaction(refund!.id), onClose);
  const purchaseMonth = monthTitle(`${info.purchaseMonth}-01`);
  const sameMonth = refundMonth === info.purchaseMonth;

  return (
    <Modal title={refund ? "Возврат" : "Вернуть деньги за покупку"} onClose={onClose}>
      <form
        className="form"
        data-testid="refund-form"
        onSubmit={(e) => {
          e.preventDefault();
          save.run();
        }}
      >
        <p className="sub" data-testid="refund-purchase">
          {p.payee || p.categoryName} · {formatDate(p.date)} · <Money amount={p.amount} symbol={p.currencySymbol} minorUnits={p.minorUnits} />
          {info.refunded > 0 && (
            <>
              {" "}
              · уже вернули <Money amount={info.refunded} symbol={p.currencySymbol} minorUnits={p.minorUnits} />
            </>
          )}
        </p>
        <div className="row">
          <Field label="Сумма возврата">
            {(id) => <AmountInput id={id} name="amount" value={amount} onChange={setAmount} minorUnits={p.minorUnits} autoFocus />}
          </Field>
          <Field label="Дата возврата">{(id) => <input id={id} name="date" type="date" value={date} min={p.date} onChange={(e) => setDate(e.target.value)} />}</Field>
        </div>
        <Field label="Деньги пришли на счёт">
          {(id) => <AccountSelect id={id} name="accountId" accounts={accounts.filter((a) => a.currencySymbol === p.currencySymbol)} value={accountId} onChange={setAccountId} />}
        </Field>
        {!sameMonth && (
          <fieldset className="choice" data-testid="refund-month">
            <legend>В каком месяце учесть возврат</legend>
            <label className="check">
              <input type="radio" name="refundMonth" checked={inPurchase} onChange={() => setInPurchase(true)} />
              {purchaseMonth}, как покупку: лимит категории снова свободен
            </label>
            <label className="check">
              <input type="radio" name="refundMonth" checked={!inPurchase} onChange={() => setInPurchase(false)} />
              {refundMonth ? monthTitle(`${refundMonth}-01`) : "Месяц возврата"}: как приход денег сейчас
            </label>
          </fieldset>
        )}
        <Field label="Комментарий">{(id) => <input id={id} name="note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Например, вернул куртку" />}</Field>
        <p className="hint">Деньги прибавятся к счёту, а в бюджете и отчётах расход «{p.categoryName}» уменьшится.</p>
        <ErrorText error={save.error ?? remove.error} />
        <div className="actions">
          {refund && (
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
