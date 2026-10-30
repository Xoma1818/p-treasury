import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Hint } from "../components/Hint";
import { SelectionBar } from "../components/SelectionBar";
import { isTyping } from "../lib/hotkeys";
import { groupReceipts, rowIds } from "../lib/receipt";
import { clickRow, EMPTY_SEL, keepExisting, selectAll, type SelState } from "../lib/selection";
import { loadAllTransactionIds } from "../lib/transactionSelection";
import { useExport } from "../components/DataTools";
import { AccountSelect, CategorySelect } from "../components/Fields";
import { ErrorText } from "../components/Modal";
import { parseView, SavedViews } from "../components/SavedViews";
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
  const { txnFilter, viewJump, openTxnForm } = useUi();
  const [from, to] = monthBounds(today());
  const [f, setF] = useState<TxnFilter>({ dateFrom: from, dateTo: to });
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const events = useQuery({ queryKey: ["events"], queryFn: api.listEvents }).data ?? [];
  const tags = useQuery({ queryKey: ["tags"], queryFn: api.listTags }).data ?? [];
  const [sel, setSel] = useState<SelState>(EMPTY_SEL);

  // Переход с фильтром со Счетов или Категорий: за всё время.
  useEffect(() => {
    if (txnFilter) {
      setF({ ...txnFilter });
      setSearch(txnFilter.search ?? "");
      useUi.setState({ txnFilter: null });
    }
  }, [txnFilter]);

  const applyView = (v: { filter: TxnFilter; search: string }) => {
    setLimit(PAGE);
    setSearch(v.search ?? "");
    setF({ ...v.filter, search: v.search || undefined });
  };
  // Вид, открытый из бокового меню.
  useEffect(() => {
    if (viewJump?.kind !== "transactions") return;
    const params = parseView<{ filter: TxnFilter; search: string }>(viewJump.params);
    if (params) applyView(params);
    useUi.setState({ viewJump: null });
  }, [viewJump]);

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

  // После Ctrl+A выделены и операции на ещё не показанных страницах: их не чистим.
  const selectAllRef = useRef(false);
  const selectionRequest = useRef<AbortController | null>(null);
  const [selectingAll, setSelectingAll] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const cancelSelection = useCallback(() => {
    selectionRequest.current?.abort();
    selectionRequest.current = null;
    setSelectingAll(false);
  }, []);
  // Г1: выделение. Другой фильтр — выделение снимается; удалённые строки из него уходят.
  const filterKey = JSON.stringify(f);
  const currentFilter = useRef(filterKey);
  currentFilter.current = filterKey;
  useEffect(() => {
    cancelSelection();
    selectAllRef.current = false;
    setSel(EMPTY_SEL);
    setSelectionError(null);
  }, [filterKey, cancelSelection]);
  useEffect(() => () => selectionRequest.current?.abort(), []);
  const items = page.data?.items;
  const rows = useMemo(() => (items ? groupReceipts(items).map((r) => ({ key: r.key, ids: rowIds(r) })) : []), [items]);
  useEffect(() => {
    if (items && !page.isPlaceholderData) setSel((cur) => (cur.ids.size && !selectAllRef.current ? keepExisting(cur, new Set(items.map((t) => t.id))) : cur));
  }, [items, page.isPlaceholderData]);
  const total = page.data?.total ?? 0;
  const txnFormOpen = useUi((s) => s.txnForm !== null);
  useEffect(() => {
    if (txnFormOpen) cancelSelection();
  }, [txnFormOpen, cancelSelection]);
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      if (txnFormOpen || isTyping(e.target) || document.querySelector(".overlay, .palette")) return;
      if (e.code === "KeyA" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        if (!total || page.isPlaceholderData || selectionRequest.current) return;
        const request = new AbortController();
        selectionRequest.current = request;
        setSelectingAll(true);
        setSelectionError(null);
        setSel(EMPTY_SEL);
        // Всё отфильтрованное, а не только первые 5000 строк, которые может вернуть ядро.
        try {
          const ids = await loadAllTransactionIds(api.listTransactions, f, request.signal);
          if (ids && selectionRequest.current === request && currentFilter.current === filterKey) {
            selectAllRef.current = true;
            setSel(selectAll(ids));
          }
        } catch (error) {
          if (!request.signal.aborted && currentFilter.current === filterKey) setSelectionError(`Не удалось выделить все операции: ${String(error)}`);
        } finally {
          if (selectionRequest.current === request) {
            selectionRequest.current = null;
            setSelectingAll(false);
          }
        }
      } else if (e.key === "Escape" && (sel.ids.size || selectionRequest.current)) {
        cancelSelection();
        selectAllRef.current = false;
        setSel(EMPTY_SEL);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [f, filterKey, total, txnFormOpen, sel.ids.size, page.isPlaceholderData, cancelSelection]);
  const onToggle = (key: string, mods: { shift: boolean; ctrl: boolean }) => {
    cancelSelection();
    setSelectionError(null);
    selectAllRef.current = false;
    setSel((cur) => clickRow(cur, rows, key, mods));
  };
  const [defFrom, defTo] = [from, to];
  const filtered =
    !!(f.accountId || f.categoryId || f.types?.length || f.search || f.eventId || f.tagId || f.importId) || f.dateFrom !== defFrom || f.dateTo !== defTo;

  return (
    <section className="screen wide">
      <div className="screen-head">
        <ScreenTitle id="transactions" />
        <span className="spacer" />
        <button className="btn" onClick={exp.run} aria-busy={exp.busy} data-done={exp.done || undefined} disabled={exp.busy} title="Операции по текущему фильтру в Excel или CSV">
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
      <ErrorText error={selectionError} />
      {selectingAll && <p className="hint" role="status" data-testid="select-all-loading">Выделяем все найденные операции…</p>}
      <SavedViews
        kind="transactions"
        current={{ filter: { ...f, search: undefined }, search }}
        onApply={applyView}
      />
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
        {tags.length > 0 && (
          <select name="filterTag" aria-label="Тег" value={f.tagId ?? ""} onChange={(e) => set({ tagId: e.target.value || undefined })}>
            <option value="">Все теги</option>
            {tags.map((t) => (
              <option key={t.id} value={t.id}>
                #{t.name}
              </option>
            ))}
          </select>
        )}
        {f.tagId && !tags.some((t) => t.id === f.tagId) && (
          <span className="view-chip" data-testid="filter-tag">
            <span className="view-apply">Тег</span>
            <button className="view-del" aria-label="Убрать фильтр по тегу" onClick={() => set({ tagId: undefined })}>
              ✕
            </button>
          </span>
        )}
        {f.importId && (
          <span className="view-chip" data-testid="filter-import">
            <span className="view-apply">Один импорт</span>
            <button className="view-del" aria-label="Убрать фильтр по импорту" onClick={() => set({ importId: undefined })}>
              ✕
            </button>
          </span>
        )}
        {f.eventId && (
          <span className="view-chip" data-testid="filter-event">
            <span className="view-apply">{events.find((e) => e.id === f.eventId)?.name ?? "Событие"}</span>
            <button className="view-del" aria-label="Убрать фильтр по событию" onClick={() => set({ eventId: undefined })}>
              ✕
            </button>
          </span>
        )}
        <input type="search" name="search" data-search placeholder="Поиск: получатель, комментарий, сумма" value={search} onChange={(e) => {
          cancelSelection();
          selectAllRef.current = false;
          setSel(EMPTY_SEL);
          setSearch(e.target.value);
        }} />
        <button className="link" onClick={() => (setSearch(""), set({ dateFrom: undefined, dateTo: undefined, accountId: undefined, categoryId: undefined, types: undefined, search: undefined, eventId: undefined, tagId: undefined, importId: undefined }))}>
          Сбросить
        </button>
      </div>
      <div className="card">
        {page.error && <p className="error">{String(page.error)}</p>}
        {page.data && (
          <>
            <TxnTable items={page.data.items} selection={{ sel, onToggle }} />
            <div className="table-foot muted" data-testid="txn-count">
              Показано {page.data.items.length} из {page.data.total}
              {sel.ids.size === 0 && <Hint of="txn.select" />}
              {page.data.items.length < page.data.total && (
                <button className="link" onClick={() => setLimit(limit + PAGE)}>
                  Показать ещё
                </button>
              )}
            </div>
          </>
        )}
      </div>
      <SelectionBar
        ids={[...sel.ids]}
        filter={{ ...f, limit: undefined, offset: undefined }}
        filtered={filtered}
        onClear={() => {
          cancelSelection();
          selectAllRef.current = false;
          setSel(EMPTY_SEL);
        }}
        onDone={() => {
          cancelSelection();
          selectAllRef.current = false;
          setSel(EMPTY_SEL);
        }}
      />
    </section>
  );
}
