import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AccountSelectType } from "./accountParts";
import { AmountInput, amountText, Field } from "../components/Fields";
import { ErrorText, Modal } from "../components/Modal";
import { Money } from "../components/Money";
import { ACCOUNT_TYPES, api, INVEST_KINDS, type Account, type AccountInput, type AccountType, type InvestKind } from "../lib/api";
import { formatDate, today } from "../lib/dates";
import { parseAmount } from "../lib/money";
import { useAccounts, useCurrencies } from "../lib/queries";
import { useUi } from "../lib/store";
import { useAction } from "../lib/useAction";
import { ScreenTitle } from "../components/SectionIcon";
import { AssetsCard } from "../components/Assets";
import { investKindLabel, ValueForm } from "../components/Invest";

export function Accounts() {
  const [showArchived, setShowArchived] = useState(false);
  const accounts = useAccounts(true).data ?? [];
  const [editing, setEditing] = useState<Account | "new" | null>(null);
  const [adjusting, setAdjusting] = useState<Account | null>(null);
  const [valuing, setValuing] = useState<string | null>(null);
  const invest = useQuery({ queryKey: ["investOverview"], queryFn: api.investOverview }).data;
  const showTransactions = useUi((s) => s.showTransactions);
  const archive = useAction(api.archiveAccount);
  const visible = accounts.filter((a) => showArchived || !a.archived);

  return (
    <section className="screen">
      <div className="screen-head">
        <ScreenTitle id="accounts" />
        <button className="btn primary" onClick={() => setEditing("new")}>
          + Новый счёт
        </button>
      </div>
      <div className="card">
        {visible.length === 0 && <p className="muted">Счетов пока нет.</p>}
        <table className="table">
          <tbody>
            {visible.map((a) => (
              <tr key={a.id} className={a.archived ? "archived" : ""} data-testid="account-row">
                <td>
                  <div className="main">{a.name}</div>
                  <div className="sub">
                    {a.type === "investment" ? investKindLabel(a.investKind) : ACCOUNT_TYPES[a.type]} · {a.currencyCode}
                    {!a.includeInTotal && " · не в общем балансе"}
                    {a.archived && " · закрыт"}
                  </div>
                </td>
                <td className="num">
                  <Money amount={a.value ?? a.balance} symbol={a.currencySymbol} minorUnits={a.minorUnits} />
                  <InvestSub account={a} invested={invest?.accounts.find((x) => x.id === a.id)} />
                  {a.available != null && (
                    <div className="sub">
                      доступно <Money amount={a.available} symbol={a.currencySymbol} minorUnits={a.minorUnits} />
                    </div>
                  )}
                </td>
                <td className="row-actions">
                  <button className="link" onClick={() => showTransactions({ accountId: a.id })}>
                    Операции
                  </button>
                  {!a.archived && a.type === "investment" && (
                    <button className="link" onClick={() => setValuing(a.id)} data-testid="account-invest-value">
                      Стоимость
                    </button>
                  )}
                  {!a.archived && a.type !== "investment" && (
                    <button className="link" onClick={() => setAdjusting(a)}>
                      Сверить
                    </button>
                  )}
                  <button className="link" onClick={() => setEditing(a)}>
                    Изменить
                  </button>
                  <button className="link" onClick={() => archive.run(a.id, !a.archived)}>
                    {a.archived ? "Вернуть" : "Закрыть"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <ErrorText error={archive.error} />
        <label className="check small">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Показать закрытые счета
        </label>
      </div>
      <AssetsCard />
      {editing && <AccountForm account={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {adjusting && <AdjustForm account={adjusting} onClose={() => setAdjusting(null)} />}
      {valuing && invest && <ValueForm accounts={invest.accounts} accountId={valuing} onClose={() => setValuing(null)} />}
    </section>
  );
}

/** Под стоимостью брокерского счёта: вложено и результат. */
function InvestSub({ account: a, invested }: { account: Account; invested?: { invested: number; result: number; valuedOn: string | null } }) {
  if (a.type !== "investment" || !invested) return null;
  return (
    <div className="sub" data-testid="account-invest-sub">
      вложено <Money amount={invested.invested} symbol={a.currencySymbol} minorUnits={a.minorUnits} /> ·{" "}
      <span className={invested.result >= 0 ? "plus" : undefined}>
        <Money amount={invested.result} symbol={a.currencySymbol} minorUnits={a.minorUnits} signed />
      </span>
      {invested.valuedOn ? ` · оценка ${formatDate(invested.valuedOn)}` : " · стоимость не вводили"}
    </div>
  );
}

function AccountForm({ account, onClose }: { account: Account | null; onClose: () => void }) {
  const currencies = useCurrencies().data ?? [];
  const [name, setName] = useState(account?.name ?? "");
  const [type, setType] = useState<AccountType>(account?.type ?? "debit");
  const [currencyCode, setCurrency] = useState(account?.currencyCode ?? "RUB");
  const minor = currencies.find((c) => c.code === currencyCode)?.minorUnits ?? 2;
  const [opening, setOpening] = useState(amountText(account?.openingBalance ?? null, account?.minorUnits));
  const [openingDate, setOpeningDate] = useState(account?.openingDate ?? today());
  const [limit, setLimit] = useState(amountText(account?.creditLimit ?? null, account?.minorUnits));
  const [include, setInclude] = useState(account?.includeInTotal ?? true);
  const [investKind, setInvestKind] = useState<InvestKind>(account?.investKind ?? "broker");
  const save = useAction((input: AccountInput) => (account ? api.updateAccount(account.id, input) : api.createAccount(input)), onClose, { celebrate: true });

  const submit = () => {
    const openingValue = opening.trim() === "" ? 0 : parseAmount(opening, minor);
    const limitValue = type === "credit" && limit.trim() !== "" ? parseAmount(limit, minor) : null;
    if (openingValue === null) return save.setError("Проверьте начальный остаток");
    if (type === "credit" && limit.trim() !== "" && limitValue === null) return save.setError("Проверьте кредитный лимит");
    save.run({ name, type, currencyCode, openingBalance: openingValue, openingDate, creditLimit: limitValue, includeInTotal: include, investKind: type === "investment" ? investKind : null });
  };

  return (
    <Modal title={account ? "Счёт" : "Новый счёт"} onClose={onClose}>
      <form className="form" onSubmit={(e) => (e.preventDefault(), submit())}>
        <Field label="Название">{(id) => <input id={id} name="name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />}</Field>
        <div className="row">
          <Field label="Тип">{(id) => <AccountSelectType id={id} name="type" value={type} onChange={setType} />}</Field>
          <Field label="Валюта">
            {(id) => (
              <select id={id} name="currency" value={currencyCode} onChange={(e) => setCurrency(e.target.value)}>
                {currencies.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code} · {c.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <div className="row">
          <Field label="Начальный остаток">
            {(id) => <AmountInput id={id} name="openingBalance" value={opening} onChange={setOpening} minorUnits={minor} allowNegative={type === "credit"} />}
          </Field>
          <Field label="Дата начала учёта">
            {(id) => <input id={id} name="openingDate" type="date" value={openingDate} onChange={(e) => setOpeningDate(e.target.value)} />}
          </Field>
        </div>
        {type === "investment" && (
          <Field label="Вид счёта" hint="ИИС и ПДС: приложение покажет, сколько внесено за год и какой будет вычет (лимит 400 000 ₽ на оба)">
            {(id) => (
              <select id={id} name="investKind" value={investKind} onChange={(e) => setInvestKind(e.target.value as InvestKind)}>
                {(Object.keys(INVEST_KINDS) as InvestKind[]).map((k) => (
                  <option key={k} value={k}>
                    {INVEST_KINDS[k]}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        {type === "credit" && (
          <Field label="Кредитный лимит" hint="Долг банку вводите отрицательным остатком: −15 000">
            {(id) => <AmountInput id={id} name="creditLimit" value={limit} onChange={setLimit} minorUnits={minor} />}
          </Field>
        )}
        <label className="check">
          <input type="checkbox" name="includeInTotal" checked={include} onChange={(e) => setInclude(e.target.checked)} />
          Учитывать в общем балансе
        </label>
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

function AdjustForm({ account, onClose }: { account: Account; onClose: () => void }) {
  const [actual, setActual] = useState(amountText(account.balance, account.minorUnits));
  const [date, setDate] = useState(today());
  const save = useAction(api.adjustBalance, onClose, { celebrate: true });
  const value = parseAmount(actual, account.minorUnits);
  const diff = value === null ? null : value - account.balance;
  return (
    <Modal title={`Сверка: ${account.name}`} onClose={onClose}>
      <form className="form" onSubmit={(e) => (e.preventDefault(), value !== null && save.run(account.id, value, date, null))}>
        <p className="muted">
          В приложении: <Money amount={account.balance} symbol={account.currencySymbol} minorUnits={account.minorUnits} /> на {formatDate(today())}.
          Введите остаток из банка; разница запишется операцией «Корректировка».
        </p>
        <div className="row">
          <Field label="Реальный остаток">
            {(id) => <AmountInput id={id} name="actualBalance" value={actual} onChange={setActual} minorUnits={account.minorUnits} allowNegative autoFocus />}
          </Field>
          <Field label="Дата">{(id) => <input id={id} name="date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
        </div>
        {diff !== null && diff !== 0 && (
          <p>
            Корректировка: <Money amount={diff} symbol={account.currencySymbol} minorUnits={account.minorUnits} signed />
          </p>
        )}
        <ErrorText error={save.error} />
        <div className="actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn primary" aria-busy={save.busy} data-done={save.done || undefined} disabled={save.busy || value === null}>
            Сверить
          </button>
        </div>
      </form>
    </Modal>
  );
}
