import { useAccounts } from "../lib/queries";
import { DEFAULT_FORM, isDefaultForm, saveForm, useTxnFormPrefs, type TxnFormPrefs } from "../lib/txnFormPrefs";

/** Г9: «Форма операции» в Настройках — что видно без «Ещё» и что подставляется в новую операцию.
 *  Категория по получателю подставляется всегда, как и раньше. */
export function TxnFormCard() {
  const p = useTxnFormPrefs();
  const accounts = (useAccounts().data ?? []).filter((a) => !a.archived);
  const set = (next: Partial<TxnFormPrefs>) => saveForm({ ...p, ...next });
  return (
    <div className="card" data-testid="txn-form-card">
      <h2>Форма операции</h2>
      <p className="muted">Что видно сразу и что подставляется в новую операцию. Категория по получателю подставляется всегда.</p>
      <div className="form-prefs">
        <label className="check">
          <input type="checkbox" name="pinNote" checked={p.pinNote} onChange={(e) => set({ pinNote: e.target.checked })} />
          <span>Комментарий всегда виден</span>
        </label>
        <label className="check">
          <input type="checkbox" name="pinTags" checked={p.pinTags} onChange={(e) => set({ pinTags: e.target.checked })} />
          <span>Теги всегда видны</span>
        </label>
        <div className="field">
          <label htmlFor="formAccount">Счёт новой операции</label>
          <select id="formAccount" name="formAccount" value={accounts.some((a) => a.id === p.account) ? p.account : "last"} onChange={(e) => set({ account: e.target.value })}>
            <option value="last">Последний использованный</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="formDate">Дата новой операции</label>
          <select id="formDate" name="formDate" value={p.date} onChange={(e) => set({ date: e.target.value as TxnFormPrefs["date"] })}>
            <option value="today">Сегодня</option>
            <option value="last">Как в прошлой введённой</option>
          </select>
        </div>
      </div>
      {!isDefaultForm(p) && (
        <button className="btn" data-testid="txn-form-reset" onClick={() => saveForm(DEFAULT_FORM)}>
          Как было
        </button>
      )}
    </div>
  );
}
