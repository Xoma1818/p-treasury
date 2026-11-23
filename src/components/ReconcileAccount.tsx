import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AmountInput, Field } from "./Fields";
import { ErrorText, Modal } from "./Modal";
import { Money } from "./Money";
import { api, TXN_TYPES, type Account } from "../lib/api";
import { formatDate, today } from "../lib/dates";
import { parseAmount } from "../lib/money";
import { useUi } from "../lib/store";
import { useAction } from "../lib/useAction";

export function ReconcileAccount({ account, onClose }: { account: Account; onClose: () => void }) {
  const [actual, setActual] = useState("");
  const maxDate = today();
  const [date, setDate] = useState(maxDate);
  const [showRows, setShowRows] = useState(false);
  const showTransactions = useUi((s) => s.showTransactions);
  const validDate = date !== "" && date <= maxDate;
  const preview = useQuery({
    queryKey: ["reconciliationPreview", account.id, date],
    queryFn: () => api.reconciliationPreview(account.id, date),
    enabled: validDate,
    retry: false,
  });
  const quote = validDate && preview.isSuccess && !preview.isFetching ? preview.data : null;
  const value = parseAmount(actual, account.minorUnits);
  const difference = value === null || quote === null ? null : value - quote.balance;
  const diff = Number.isSafeInteger(difference) ? difference : null;
  const rows = useQuery({
    queryKey: ["reconciliationOperations", account.id, date],
    queryFn: () => api.listTransactions({ accountId: account.id, dateTo: date, limit: 20 }),
    enabled: showRows && !!quote,
    retry: false,
  });
  const complete = useAction(api.completeReconciliation, onClose, { singleSubmit: true });
  const adjust = useAction(api.adjustBalanceChecked, onClose, { singleSubmit: true });
  const busy = complete.busy || adjust.busy;
  const error = complete.error ?? adjust.error;
  const clearErrors = () => {
    adjust.setError(null);
    complete.setError(null);
  };
  const viewOperations = () => {
    if (!quote) return;
    onClose();
    showTransactions({ accountId: account.id, dateTo: quote.date });
  };

  return (
    <Modal title={`Сверка: ${account.name}`} onClose={onClose} dismissDisabled={busy} wide={showRows}>
      <form className="form" onSubmit={(e) => {
        e.preventDefault();
        if (quote && value !== null && diff === 0 && !busy && !error) {
          complete.run(account.id, quote.date, value, quote.revision);
        }
      }}>
        <div className="row">
          <Field label="Остаток по выписке" hint={account.currencyCode}>
            {(id) => (
              <AmountInput id={id} name="actualBalance" value={actual} onChange={(text) => {
                if (!busy) setActual(text);
              }} minorUnits={account.minorUnits} allowNegative autoFocus />
            )}
          </Field>
          <Field label="Дата выписки">
            {(id) => <input id={id} name="date" type="date" value={date} max={maxDate} disabled={busy} onChange={(e) => {
              clearErrors();
              setDate(e.target.value);
            }} />}
          </Field>
        </div>
        {preview.isFetching && <p className="muted" role="status">Считаем остаток…</p>}
        {date > maxDate && <p className="warn">Выберите сегодняшнюю или прошлую дату.</p>}
        {quote && Number.isSafeInteger(quote.balance) && (
          <p data-testid="reconcile-book-balance">
            В Kazna на {formatDate(quote.date)} · <Money amount={quote.balance} symbol={account.currencySymbol} minorUnits={account.minorUnits} />
          </p>
        )}
        {quote && quote.date < quote.openingDate && (
          <p className="warn">Дата выписки раньше начала учёта ({formatDate(quote.openingDate)}). В остаток Kazna включён начальный остаток счёта.</p>
        )}
        {diff !== null && (
          <p className={diff === 0 ? "ok" : "warn"} data-testid="reconcile-difference">
            {diff === 0 ? "Остатки совпадают." : <>Расхождение · <Money amount={diff} symbol={account.currencySymbol} minorUnits={account.minorUnits} signed /></>}
          </p>
        )}
        {((quote && !Number.isSafeInteger(quote.balance)) || (difference !== null && diff === null)) &&
          <p className="warn" role="alert">Сумма выходит за допустимые пределы.</p>}
        <ErrorText error={error ?? (preview.error ? String(preview.error) : null)} />
        {(error || preview.isError) && validDate && (
          <button type="button" className="link" disabled={busy || preview.isFetching} onClick={() => {
            clearErrors();
            void preview.refetch();
          }}>Обновить расчёт</button>
        )}
        {showRows && quote && (
          <div className="card" id="reconcile-operations" data-testid="reconcile-operations">
            <h3>Проведённые операции до {formatDate(quote.date)}</h3>
            {rows.isFetching && <p className="muted" role="status">Загружаем операции…</p>}
            <ErrorText error={rows.error ? String(rows.error) : null} />
            {rows.data?.items.length === 0 && <p className="muted">Операций за этот период нет.</p>}
            {!!rows.data?.items.length && (
              <table className="table">
                <thead><tr><th>Дата</th><th>Операция</th><th className="num">Сумма</th></tr></thead>
                <tbody>
                  {rows.data.items.map((item) => {
                    const amount = item.toAccountId === account.id
                      ? (item.toAmount ?? item.amount)
                      : item.type === "expense" || item.type === "transfer" ? -item.amount : item.amount;
                    return <tr key={item.id}>
                      <td>{formatDate(item.date)}</td>
                      <td>{item.payee || item.categoryName || TXN_TYPES[item.type]}</td>
                      <td className="num"><Money amount={amount} symbol={account.currencySymbol} minorUnits={account.minorUnits} signed /></td>
                    </tr>;
                  })}
                </tbody>
              </table>
            )}
            {!!rows.data && rows.data.total > rows.data.items.length &&
              <button type="button" className="link" disabled={busy} onClick={viewOperations}>Открыть весь список ({rows.data.total})</button>}
          </div>
        )}
        <div className="actions">
          <button type="button" className="link" disabled={!quote || busy} aria-expanded={showRows}
            aria-controls="reconcile-operations" onClick={() => setShowRows(!showRows)}>
            {showRows ? "Скрыть операции" : "Посмотреть операции"}
          </button>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Отмена</button>
          {quote && value !== null && diff !== null && diff !== 0 ? (
            <button type="button" className="btn" data-testid="reconcile-adjust" disabled={busy || !!error} aria-busy={adjust.busy}
              onClick={() => adjust.run(account.id, quote.date, value, quote.revision)}>
              Записать корректировку
            </button>
          ) : (
            <button type="submit" className="btn primary" disabled={busy || !!error || diff !== 0} aria-busy={complete.busy}>
              Завершить сверку
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
