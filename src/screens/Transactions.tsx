import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SlidersHorizontal, X } from "lucide-react";
import { Hint } from "../components/Hint";
import { SelectionBar } from "../components/SelectionBar";
import { isTyping } from "../lib/hotkeys";
import { groupReceipts, rowIds } from "../lib/receipt";
import { clickRow, EMPTY_SEL, keepExisting, selectAll, type SelState } from "../lib/selection";
import { loadAllTransactionIds } from "../lib/transactionSelection";
import { ImportDialog, useExport } from "../components/DataTools";
import { TxnHeadBar } from "../components/TxnHeadBar";
import { onFileDrop, statementOf } from "../lib/fileDrop";
import { AccountSelect, CategorySelect } from "../components/Fields";
import { ErrorText } from "../components/Modal";
import { parseView, SavedViews } from "../components/SavedViews";
import { TxnTable } from "../components/TxnTable";
import { api, TXN_TYPES, type TxnFilter, type TxnType } from "../lib/api";
import { monthBounds, shiftMonth, today } from "../lib/dates";
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
  const exp = useExport(`Kazna — операции ${today()}`, (path) => api.exportTransactions(f, path), ["csv", "xlsx", "ofx"]);
  // Импорт выписки: кнопкой или файлом, брошенным в окно (undefined — окно закрыто).
  const [importFile, setImportFile] = useState<string | null | undefined>(undefined);
  const [importKey, setImportKey] = useState(0);
  const [dropping, setDropping] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  useEffect(
    () =>
      onFileDrop((s) => {
        if (s === "over") return setDropping(true);
        setDropping(false);
        if (s === "leave") return;
        const file = statementOf(s.paths);
        if (!file) return setDropError("Этот файл не выписка: подойдёт Excel (.xlsx, .xls), CSV или PDF");
        setDropError(null);
        setImportKey((k) => k + 1);
        setImportFile(file);
      }),
    [],
  );
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
    !!(f.accountId || f.categoryId || f.types?.length || f.search || f.eventId || f.tagId || f.importId || f.payee) || f.dateFrom !== defFrom || f.dateTo !== defTo;

  // Быстрые периоды (0.29): месяц, прошлый месяц, год и всё время; свои даты — полями рядом.
  const periods = useMemo(() => {
    const now = today();
    const [pf, pt] = monthBounds(`${shiftMonth(now.slice(0, 7), -1)}-01`);
    const y = now.slice(0, 4);
    return [
      { key: "month", label: "Этот месяц", from, to },
      { key: "prev", label: "Прошлый", from: pf, to: pt },
      { key: "year", label: "Год", from: `${y}-01-01`, to: `${y}-12-31` },
      { key: "all", label: "Всё время", from: undefined, to: undefined },
    ] as { key: string; label: string; from?: string; to?: string }[];
  }, [from, to]);
  const periodKey = periods.find((p) => p.from === f.dateFrom && p.to === f.dateTo)?.key ?? "custom";
  const [panelOpen, setPanelOpen] = useState(() => {
    try {
      return localStorage.getItem("kazna.txnFilters") === "1";
    } catch {
      return false;
    }
  });
  const togglePanel = (open: boolean) => {
    setPanelOpen(open);
    try {
      localStorage.setItem("kazna.txnFilters", open ? "1" : "0");
    } catch {
      /* без запоминания */
    }
  };
  const activeCount = [f.accountId, f.categoryId, f.types?.length, f.tagId].filter(Boolean).length;
  const showPanel = panelOpen || activeCount > 0;
  // Включённые фильтры — плашками с крестиком, видны и при свёрнутой панели.
  const chips: { id: string; label: string; clear: () => void }[] = [];
  if (f.accountId) chips.push({ id: "chip-account", label: accounts.find((a) => a.id === f.accountId)?.name ?? "Счёт", clear: () => set({ accountId: undefined }) });
  if (f.categoryId) chips.push({ id: "chip-category", label: categories.find((c) => c.id === f.categoryId)?.name ?? "Категория", clear: () => set({ categoryId: undefined }) });
  if (f.types?.length) chips.push({ id: "chip-type", label: TXN_TYPES[f.types[0]], clear: () => set({ types: undefined }) });
  if (f.tagId) chips.push({ id: tags.some((t) => t.id === f.tagId) ? "chip-tag" : "filter-tag", label: tags.find((t) => t.id === f.tagId) ? `#${tags.find((t) => t.id === f.tagId)!.name}` : "Тег", clear: () => set({ tagId: undefined }) });
  if (f.importId) chips.push({ id: "filter-import", label: "Один импорт", clear: () => set({ importId: undefined }) });
  if (f.payee) chips.push({ id: "filter-payee", label: `Получатель: ${f.payee}`, clear: () => set({ payee: undefined }) });
  if (f.eventId) chips.push({ id: "filter-event", label: events.find((e) => e.id === f.eventId)?.name ?? "Событие", clear: () => set({ eventId: undefined }) });

  return (
    <section className="screen wide">
      <div className="screen-head">
        <ScreenTitle id="transactions" />
        <span className="spacer" />
        <TxnHeadBar onImport={() => setImportFile(null)} exp={exp} />
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
      <ErrorText error={dropError} />
      {dropping && (
        <p className="hint drop-hint" role="status" data-testid="drop-hint">
          Отпустите файл, чтобы загрузить выписку
        </p>
      )}
      {importFile !== undefined && <ImportDialog key={importKey} initialPath={importFile ?? undefined} onClose={() => setImportFile(undefined)} />}
      <ErrorText error={selectionError} />
      {selectingAll && <p className="hint" role="status" data-testid="select-all-loading">Выделяем все найденные операции…</p>}
      <SavedViews
        kind="transactions"
        current={{ filter: { ...f, search: undefined }, search }}
        onApply={applyView}
      />
      <div className="card filters" data-testid="filters">
        <div className="filters-row">
          <input type="search" name="search" data-search placeholder="Поиск: получатель, комментарий, сумма" value={search} onChange={(e) => {
            cancelSelection();
            selectAllRef.current = false;
            setSel(EMPTY_SEL);
            setSearch(e.target.value);
          }} />
          <div className="tabs small" role="group" aria-label="Период" data-testid="period">
            {periods.map((p) => (
              <button key={p.key} type="button" className={periodKey === p.key ? "tab active" : "tab"} aria-pressed={periodKey === p.key} onClick={() => set({ dateFrom: p.from, dateTo: p.to })}>
                {p.label}
              </button>
            ))}
          </div>
          <input type="date" aria-label="С даты" name="dateFrom" value={f.dateFrom ?? ""} onChange={(e) => set({ dateFrom: e.target.value || undefined })} />
          <span className="muted">—</span>
          <input type="date" aria-label="По дату" name="dateTo" value={f.dateTo ?? ""} onChange={(e) => set({ dateTo: e.target.value || undefined })} />
          <button type="button" className={showPanel ? "btn small active" : "btn small"} aria-expanded={showPanel} data-open={panelOpen || undefined} data-testid="filters-toggle" onClick={() => togglePanel(!panelOpen)} title="Счёт, категория, тип и тег">
            <SlidersHorizontal size={14} strokeWidth={1.75} aria-hidden="true" /> Фильтры{activeCount > 0 ? ` · ${activeCount}` : ""}
          </button>
          <button className="link" onClick={() => (setSearch(""), set({ dateFrom: undefined, dateTo: undefined, accountId: undefined, categoryId: undefined, types: undefined, search: undefined, eventId: undefined, tagId: undefined, importId: undefined, payee: undefined }))}>
            Сбросить
          </button>
        </div>
        {showPanel && (
          <div className="filters-row" data-testid="filters-panel">
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
          </div>
        )}
        {chips.length > 0 && (
          <div className="filters-row" data-testid="filter-chips">
            {chips.map((c) => (
              <span key={c.id} className="view-chip" data-testid={c.id}>
                <span className="view-apply">{c.label}</span>
                <button className="view-del" aria-label={`Убрать фильтр «${c.label}»`} onClick={c.clear}>
                  <X size={16} strokeWidth={1.75} aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        )}
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
