import { useQuery } from "@tanstack/react-query";
import { RowMenu } from "../components/RowMenu";
import { openContextMenu } from "../components/ContextMenu";
import { useState } from "react";
import { AccountSelectType } from "./accountParts";
import { AmountInput, amountText, Field } from "../components/Fields";
import { ErrorText, Modal } from "../components/Modal";
import { Money } from "../components/Money";
import { ACCOUNT_TYPES, api, INVEST_KINDS, type Account, type AccountGroup, type AccountInput, type AccountType, type InvestKind } from "../lib/api";
import { CATEGORY_ICONS, isColor, type CategoryColor, type Look } from "../lib/categoryLook";
import { LookMark } from "../components/CategoryMark";
import { LookPicker } from "../components/LookPicker";
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
  const groups = useQuery({ queryKey: ["accountGroups"], queryFn: () => api.listAccountGroups(today()) }).data ?? [];
  const [editing, setEditing] = useState<Account | "new" | null>(null);
  const [adjusting, setAdjusting] = useState<Account | null>(null);
  const [valuing, setValuing] = useState<string | null>(null);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const invest = useQuery({ queryKey: ["investOverview"], queryFn: api.investOverview }).data;
  const reserves = useQuery({ queryKey: ["accountReserves"], queryFn: api.accountReserves }).data;
  const showTransactions = useUi((s) => s.showTransactions);
  const archive = useAction(api.archiveAccount);
  const move = useAction(async (id: string, groupId: string | null, beforeId: string | null) => {
    const a = accounts.find((x) => x.id === id);
    if (!a) return;
    if ((a.groupId ?? null) !== groupId) await api.setAccountGroup(id, groupId);
    const rest = accounts.filter((x) => x.id !== id).map((x) => x.id);
    let at = beforeId ? rest.indexOf(beforeId) : -1;
    if (at < 0) {
      // В конец группы: после последнего счёта этой группы.
      const lastInGroup = accounts.filter((x) => x.id !== id && (x.groupId ?? null) === groupId).at(-1);
      at = lastInGroup ? rest.indexOf(lastInGroup.id) + 1 : rest.length;
    }
    rest.splice(at, 0, id);
    await api.reorderAccounts(rest);
  });
  const [dragId, setDragId] = useState<string | null>(null);
  const visible = accounts.filter((a) => showArchived || !a.archived);
  const known = new Set(groups.map((g) => g.id));
  const sections: { group: AccountGroup | null; items: Account[] }[] = [
    ...groups.map((g) => ({ group: g, items: visible.filter((a) => a.groupId === g.id) })),
    { group: null, items: visible.filter((a) => !a.groupId || !known.has(a.groupId)) },
  ].filter((s) => s.group || s.items.length > 0);

  const drop = (groupId: string | null, beforeId: string | null) => (e: React.DragEvent) => {
    e.preventDefault();
    const id = dragId ?? e.dataTransfer.getData("text/plain");
    setDragId(null);
    if (id && id !== beforeId) move.run(id, groupId, beforeId);
  };

  const row = (a: Account, list: Account[]) => {
    const i = list.indexOf(a);
    return (
      <tr
        key={a.id}
        className={[a.archived ? "archived" : "", dragId === a.id ? "dragging" : ""].filter(Boolean).join(" ") || undefined}
        data-testid="account-row"
        data-name={a.name}
        draggable={!a.archived}
        onDragStart={(e) => {
          setDragId(a.id);
          e.dataTransfer.setData("text/plain", a.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => setDragId(null)}
        onDragOver={(e) => dragId && e.preventDefault()}
        onDrop={drop(a.groupId && known.has(a.groupId) ? a.groupId : null, a.id)}
        onContextMenu={(e) =>
          openContextMenu(e, [
            { text: "Операции счёта", onClick: () => showTransactions({ accountId: a.id }) },
            ...(!a.archived && a.type === "investment" ? [{ text: "Стоимость", onClick: () => setValuing(a.id) }] : []),
            ...(!a.archived && a.type !== "investment" ? [{ text: "Сверить", onClick: () => setAdjusting(a) }] : []),
            { text: "Изменить", onClick: () => setEditing(a) },
            { text: a.archived ? "Вернуть из закрытых" : "Закрыть счёт", onClick: () => archive.run(a.id, !a.archived), danger: !a.archived },
          ])
        }
      >
        <td>
          <div className="account-name">
            <LookMark look={accountLook(a)} size={22} />
            <div>
              <div className="main">{a.name}</div>
              <div className="sub">
                {a.type === "investment" ? investKindLabel(a.investKind) : ACCOUNT_TYPES[a.type]} · {a.currencyCode}
                {!a.includeInTotal && " · не в общем балансе"}
                {!a.inBudget && " · не в бюджете"}
                {a.archived && " · закрыт"}
              </div>
            </div>
          </div>
        </td>
        <td className="num">
          <Money amount={a.value ?? a.balance} symbol={a.currencySymbol} minorUnits={a.minorUnits} />
          <InvestSub account={a} invested={invest?.accounts.find((x) => x.id === a.id)} />
          {(reserves?.[a.id] ?? 0) > 0 && (
            <div className="sub" data-testid="account-reserved">
              в резервах <Money amount={reserves![a.id]} symbol={a.currencySymbol} minorUnits={a.minorUnits} />, свободно{" "}
              <Money amount={a.balance - reserves![a.id]} symbol={a.currencySymbol} minorUnits={a.minorUnits} />
            </div>
          )}
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
          <RowMenu
            label={`Ещё: ${a.name}`}
            items={[
              { text: "Изменить", onClick: () => setEditing(a) },
              ...(i > 0 ? [{ text: "Выше", onClick: () => move.run(a.id, a.groupId && known.has(a.groupId) ? a.groupId : null, list[i - 1].id) }] : []),
              ...(i < list.length - 1 ? [{ text: "Ниже", onClick: () => move.run(a.id, a.groupId && known.has(a.groupId) ? a.groupId : null, list[i + 2]?.id ?? null) }] : []),
              { text: a.archived ? "Вернуть из закрытых" : "Закрыть счёт", onClick: () => archive.run(a.id, !a.archived), danger: !a.archived },
            ]}
          />
        </td>
      </tr>
    );
  };

  return (
    <section className="screen">
      <div className="screen-head">
        <ScreenTitle id="accounts" />
        <button className="btn" onClick={() => setGroupsOpen(true)} data-testid="account-groups-open">
          Группы
        </button>
        <button className="btn primary" onClick={() => setEditing("new")}>
          + Новый счёт
        </button>
      </div>
      <div className="card">
        {visible.length === 0 && <p className="muted">Счетов пока нет.</p>}
        <table className="table accounts-table">
          {sections.map(({ group, items }) => (
            <tbody key={group?.id ?? "none"} data-testid="account-section" data-group={group?.name ?? ""}>
              {(group || groups.length > 0) && (
                <tr className="group-head" data-testid="account-group" onDragOver={(e) => dragId && e.preventDefault()} onDrop={drop(group?.id ?? null, null)}>
                  <td>{group ? group.name : "Без группы"}</td>
                  <td className="num" data-testid="account-group-total">
                    {group && (
                      <>
                        <Money amount={group.total} />
                        {group.missingRates.length > 0 && <span className="muted small"> без {group.missingRates.join(", ")}</span>}
                      </>
                    )}
                  </td>
                  <td className="muted small">{group && items.length === 0 ? "перетащите сюда счёт" : ""}</td>
                </tr>
              )}
              {items.map((a) => row(a, items))}
            </tbody>
          ))}
        </table>
        <ErrorText error={archive.error ?? move.error} />
        <p className="hint">Порядок и группу счёта можно поменять перетаскиванием строки.</p>
        <label className="check small">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Показать закрытые счета
        </label>
      </div>
      <AssetsCard />
      {editing && <AccountForm account={editing === "new" ? null : editing} groups={groups} onClose={() => setEditing(null)} />}
      {adjusting && <AdjustForm account={adjusting} onClose={() => setAdjusting(null)} />}
      {valuing && invest && <ValueForm accounts={invest.accounts} accountId={valuing} onClose={() => setValuing(null)} />}
      {groupsOpen && <GroupsForm groups={groups} onClose={() => setGroupsOpen(false)} />}
    </section>
  );
}

/** Р21: значок и цвет счёта для LookMark. */
export function accountLook(a: Pick<Account, "icon" | "color">): Look {
  return { icon: a.icon && CATEGORY_ICONS[a.icon] ? a.icon : null, color: isColor(a.color) ? (a.color as CategoryColor) : null };
}

/** Р19: свои группы счетов — добавить, переименовать, переставить, удалить. */
function GroupsForm({ groups, onClose }: { groups: AccountGroup[]; onClose: () => void }) {
  const [name, setName] = useState("");
  const [names, setNames] = useState<Record<string, string>>({});
  const add = useAction(() => api.createAccountGroup(name), () => setName(""));
  const rename = useAction((id: string, n: string) => api.renameAccountGroup(id, n));
  const remove = useAction((id: string) => api.deleteAccountGroup(id));
  const order = useAction((ids: string[]) => api.reorderAccountGroups(ids));
  const swap = (i: number, j: number) => {
    const ids = groups.map((g) => g.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    order.run(ids);
  };
  return (
    <Modal title="Группы счетов" onClose={onClose}>
      <p className="hint">Например «Семья», «Отложено», «Наличные». У группы виден итог в основной валюте. Счёт в группу переносится в его окне «Изменить» или перетаскиванием.</p>
      <ul className="group-list" data-testid="group-list">
        {groups.map((g, i) => (
          <li key={g.id} data-testid="group-item" data-name={g.name}>
            <input
              aria-label={`Название группы «${g.name}»`}
              value={names[g.id] ?? g.name}
              onChange={(e) => setNames({ ...names, [g.id]: e.target.value })}
              onBlur={() => names[g.id] !== undefined && names[g.id] !== g.name && rename.run(g.id, names[g.id])}
            />
            <span className="muted small">{g.count} сч.</span>
            <button type="button" className="icon-btn" aria-label={`Выше: ${g.name}`} disabled={i === 0} onClick={() => swap(i, i - 1)}>
              ↑
            </button>
            <button type="button" className="icon-btn" aria-label={`Ниже: ${g.name}`} disabled={i === groups.length - 1} onClick={() => swap(i, i + 1)}>
              ↓
            </button>
            <button type="button" className="link danger" onClick={() => remove.run(g.id)} title="Счета останутся, только без группы">
              Удалить
            </button>
          </li>
        ))}
      </ul>
      <form className="row" onSubmit={(e) => (e.preventDefault(), add.run())}>
        <input name="groupName" placeholder="Новая группа" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="btn" disabled={!name.trim() || add.busy}>
          Добавить
        </button>
      </form>
      <ErrorText error={add.error ?? rename.error ?? remove.error ?? order.error} />
      <div className="actions">
        <span className="spacer" />
        <button type="button" className="btn primary" onClick={onClose}>
          Готово
        </button>
      </div>
    </Modal>
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

function AccountForm({ account, groups, onClose }: { account: Account | null; groups: AccountGroup[]; onClose: () => void }) {
  const currencies = useCurrencies().data ?? [];
  const [name, setName] = useState(account?.name ?? "");
  const [type, setType] = useState<AccountType>(account?.type ?? "debit");
  const [currencyCode, setCurrency] = useState(account?.currencyCode ?? "RUB");
  const minor = currencies.find((c) => c.code === currencyCode)?.minorUnits ?? 2;
  const [opening, setOpening] = useState(amountText(account?.openingBalance ?? null, account?.minorUnits));
  const [openingDate, setOpeningDate] = useState(account?.openingDate ?? today());
  const [limit, setLimit] = useState(amountText(account?.creditLimit ?? null, account?.minorUnits));
  const [include, setInclude] = useState(account?.includeInTotal ?? true);
  const [inBudget, setInBudget] = useState(account?.inBudget ?? true);
  const [inForecast, setInForecast] = useState(account?.inForecast ?? true);
  const [groupId, setGroupId] = useState(account?.groupId ?? "");
  const look0 = account ? accountLook(account) : { icon: null, color: null };
  const [icon, setIcon] = useState<string | null>(look0.icon);
  const [color, setColor] = useState<CategoryColor | null>(look0.color);
  const liquid = type === "cash" || type === "debit" || type === "savings";
  const [investKind, setInvestKind] = useState<InvestKind>(account?.investKind ?? "broker");
  const save = useAction(
    async (input: AccountInput) => {
      const id = account ? (await api.updateAccount(account.id, input), account.id) : await api.createAccount(input);
      // Р19–Р21: группа, куда входит счёт, значок и цвет — отдельными шагами ядра.
      if (!account || account.inBudget !== inBudget || account.inForecast !== inForecast || account.includeInTotal !== include)
        await api.setAccountIncludes(id, include, inBudget, inForecast);
      if (!account || (account.groupId ?? "") !== groupId) await api.setAccountGroup(id, groupId || null);
      if (!account || accountLook(account).icon !== icon || accountLook(account).color !== color) await api.setAccountLook(id, icon, color);
    },
    onClose,
    { celebrate: true },
  );

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
        {groups.length > 0 && (
          <Field label="Группа">
            {(id) => (
              <select id={id} name="accountGroup" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                <option value="">Без группы</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        <div className="field" role="group" aria-label="Куда входит счёт">
          <span className="label">Куда входит</span>
          <label className="check">
            <input type="checkbox" name="includeInTotal" checked={include} onChange={(e) => setInclude(e.target.checked)} />
            В общий баланс
          </label>
          <label className="check" title="Траты и доходы счёта считаются в бюджете и «Можно тратить»">
            <input type="checkbox" name="inBudget" checked={inBudget} onChange={(e) => setInBudget(e.target.checked)} />
            В бюджет
          </label>
          {liquid && (
            <label className="check" title={include ? "Остаток счёта входит в «Взгляд вперёд»" : "В прогноз входят только счета из общего баланса"}>
              <input type="checkbox" name="inForecast" checked={include && inForecast} disabled={!include} onChange={(e) => setInForecast(e.target.checked)} />
              В прогноз
            </label>
          )}
        </div>
        <details className="look-details">
          <summary>
            Значок и цвет <LookMark look={{ icon, color }} size={18} />
          </summary>
          <LookPicker icon={icon} color={color} onIcon={setIcon} onColor={setColor} />
        </details>
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
