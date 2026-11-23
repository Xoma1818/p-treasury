import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { api, type Txn } from "../lib/api";
import { formatDate, monthTitle, today } from "../lib/dates";
import { amountToInput, formatMoney, HIDDEN_AMOUNT, parseAmount } from "../lib/money";
import { useAccounts, useMonthOf, useSettings } from "../lib/queries";
import { useAction } from "../lib/useAction";
import { AccountSelect, AmountInput, Field } from "./Fields";
import { ErrorText, Modal } from "./Modal";
import { Money } from "./Money";

interface RefundDialogProps {
  purchaseId: string;
  receiptPurchase?: Txn;
  choosePart?: boolean;
  refund?: Txn;
  onClose: () => void;
}

/** 0.29: возврат за покупку. Деньги приходят на счёт, а в бюджете это минус
 *  расход категории покупки — в месяце покупки (по умолчанию) или возврата. */
export function RefundDialog({ purchaseId, receiptPurchase, choosePart, refund, onClose }: RefundDialogProps) {
  const [selectedId, setSelectedId] = useState(choosePart ? "" : purchaseId);
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const dismiss = () => { if (!locked.current) onClose(); };
  const submit = async (action: () => Promise<unknown>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    try { await action(); }
    catch { /* useAction показывает ошибку формы. */ }
    finally { locked.current = false; setBusy(false); }
  };
  const splitId = receiptPurchase?.splitId;
  const receipt = useQuery({ queryKey: ["receipt", splitId], queryFn: () => api.getReceipt(splitId!), enabled: !!splitId });
  const info = useQuery({ queryKey: ["refundInfo", selectedId, refund?.id ?? null], queryFn: () => api.refundInfo(selectedId, refund?.id), enabled: !!selectedId });
  const settings = useSettings().data;
  const showAmounts = settings && settings.hide_amounts !== "1";
  const error = receipt.error ?? info.error;
  return (
    <Modal title={refund ? "Возврат" : "Вернуть деньги за покупку"} onClose={dismiss} dismissDisabled={busy}>
      {receiptPurchase && (
        <Field label="За какую строку чека вернуть деньги?">{(id) => (
          <select id={id} name="refundPart" value={selectedId} disabled={busy} onChange={(e) => { if (!locked.current) setSelectedId(e.target.value); }} autoFocus aria-busy={receipt.isFetching}>
            <option value="" disabled>{receipt.isPending ? "Загружаем строки чека…" : "Выберите покупку"}</option>
            {receipt.data?.parts.map((part) => (
              <option key={part.id} value={part.id}>
                {part.categoryName} · {showAmounts ? formatMoney(part.amount, receiptPurchase.currencySymbol, receiptPurchase.minorUnits) : HIDDEN_AMOUNT}
                {part.note ? ` · ${part.note}` : ""}
              </option>
            ))}
          </select>
        )}</Field>
      )}
      <ErrorText error={error ? String(error) : null} />
      {info.data ? <RefundForm key={selectedId} info={info.data} refund={refund} focusAmount={!receiptPurchase} onClose={onClose} onCancel={dismiss} submit={submit} busy={busy} />
        : (info.isFetching || receipt.isFetching) && <p className="hint" role="status">Загрузка…</p>}
    </Modal>
  );
}

function RefundForm({ info, refund, focusAmount, onClose, onCancel, submit, busy }: {
  info: NonNullable<Awaited<ReturnType<typeof api.refundInfo>>>; refund?: Txn; focusAmount: boolean;
  onClose: () => void; onCancel: () => void; submit: (action: () => Promise<unknown>) => Promise<void>; busy: boolean;
}) {
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
      <form
        className="form"
        data-testid="refund-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(save.runAsync);
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
            {(id) => <AmountInput id={id} name="amount" value={amount} onChange={setAmount} minorUnits={p.minorUnits} autoFocus={focusAmount} />}
          </Field>
          <Field label="Дата возврата">{(id) => <input id={id} name="date" type="date" value={date} min={p.date} onChange={(e) => setDate(e.target.value)} />}</Field>
        </div>
        <Field label="Деньги пришли на счёт">
          {(id) => <AccountSelect id={id} name="accountId" accounts={accounts.filter((a) => a.currencyCode === p.currencyCode)} value={accountId} onChange={setAccountId} />}
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
            <button type="button" className="btn danger" onClick={() => void submit(remove.runAsync)} disabled={busy}>
              Удалить
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Отмена
          </button>
          <button type="submit" className="btn primary" aria-busy={save.busy} data-done={save.done || undefined} disabled={busy}>
            Сохранить
          </button>
        </div>
      </form>
  );
}
