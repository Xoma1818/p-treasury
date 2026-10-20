import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useExport } from "../components/DataTools";
import { AccountSelect, CategorySelect } from "../components/Fields";
import { ErrorText } from "../components/Modal";
import { TxnTable } from "../components/TxnTable";
import { api, TXN_TYPES, type TxnFilter, type TxnType } from "../lib/api";
import { monthBounds, today } from "../lib/dates";
import { useAccounts, useCategories } from "../lib/queries";
import { useUi } from "../lib/store";
import { ScreenTitle } from "../components/SectionIcon";

const PAGE = 100;

export function Transactions() {
  const accounts = useAccounts(true).data ?? [];
  const categories = useCategories(true).data ?? [];
  const { txnFilter, openTxnForm } = useUi();
  const [from, to] = monthBounds(today());
  const [f, setF] = useState<TxnFilter>({ dateFrom: from, dateTo: to });
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(PAGE);

  // Переход с фильтром со Счетов или Категорий: за всё время.
  useEffect(() => {
    if (txnFilter) {
      setF({ ...txnFilter });
      useUi.setState({ txnFilter: null });
    }
  }, [txnFilter]);

  useEffect(() => {
    const t = setTimeout(() => setF((cur) => ({ ...cur, search: search || undefined })), 250);
    return () => clearTimeout(t);
  }, [search]);

  const query = { ...f, limit };
  const page = useQuery({ queryKey: ["transactions", query], queryFn: () => api.listTransactions(query), placeholderData: keepPreviousData });
  const exp = useExport(`P-Treasury — операции ${today()}`, (path) => api.exportTransactions(f, path));
  const set = (patch: Partial<TxnFilter>) => {
    setLimit(PAGE);
    setF({ ...f, ...patch });
  };

  return (
    <section className="screen wide">
      <div className="screen-head">
        <ScreenTitle id="transactions" />
        <span className="spacer" />
        <button className="btn" onClick={exp.run} aria-busy={exp.busy} disabled={exp.busy} title="Операции по текущему фильтру в Excel или CSV">
          Выгрузить
        </button>
        <button className="btn primary" onClick={() => openTxnForm({ mode: "new", type: "expense" })} title="Ctrl+N">
          + Операция
        </button>
      </div>
      {exp.done && (
        <p className="ok" data-testid="export-done">
          Выгружено: {exp.done}
        </p>
      )}
      <ErrorText error={exp.error} />
      <div className="card filters">
        <input type="date" aria-label="С даты" name="dateFrom" value={f.dateFrom ?? ""} onChange={(e) => set({ dateFrom: e.target.value || undefined })} />
        <span className="muted">—</span>
        <input type="date" aria-label="По дату" name="dateTo" value={f.dateTo ?? ""} onChange={(e) => set({ dateTo: e.target.value || undefined })} />
        <AccountSelect name="filterAccount" accounts={accounts} value={f.accountId ?? ""} onChange={(v) => set({ accountId: v || undefined })} placeholder="Все счета" />
        <CategorySelect name="filterCategory" categories={categories} value={f.categoryId ?? ""} onChange={(v) => set({ categoryId: v || undefined })} placeholder="Все категории" />
        <select name="filterType" aria-label="Тип" value={f.types?.[0] ?? ""} onChange={(e) => set({ types: e.target.value ? [e.target.value as TxnType] : undefined })}>
          <option value="">Все типы</option>
          {(Object.keys(TXN_TYPES) as TxnType[]).map((t) => (
            <option key={t} value={t}>
              {TXN_TYPES[t]}
            </option>
          ))}
        </select>
        <input type="search" name="search" data-search placeholder="Поиск: получатель, комментарий, сумма" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button className="link" onClick={() => (setSearch(""), set({ dateFrom: undefined, dateTo: undefined, accountId: undefined, categoryId: undefined, types: undefined, search: undefined }))}>
          Сбросить
        </button>
      </div>
      <div className="card">
        {page.error && <p className="error">{String(page.error)}</p>}
        {page.data && (
          <>
            <TxnTable items={page.data.items} />
            <div className="table-foot muted" data-testid="txn-count">
              Показано {page.data.items.length} из {page.data.total}
              {page.data.items.length < page.data.total && (
                <button className="link" onClick={() => setLimit(limit + PAGE)}>
                  Показать ещё
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
