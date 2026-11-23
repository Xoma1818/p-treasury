import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SlidersHorizontal, X } from "lucide-react";
import { Hint } from "../components/Hint";
import { SelectionBar } from "../components/SelectionBar";
import { isTyping } from "../lib/hotkeys";
import { rowIds } from "../lib/receipt";
import { clickSort, orderedRows, parseTable, saveTable, sortParam, useTxnTable, type TxnTableLayout } from "../lib/txnTable";
import { TableViewMenu } from "../components/TableViewMenu";
import { clickRow, EMPTY_SEL, keepExisting, selectAll, type SelState } from "../lib/selection";
import { loadAllTransactionIds } from "../lib/transactionSelection";
import { ImportDialog, useExport } from "../components/DataTools";
import { TxnHeadBar } from "../components/TxnHeadBar";
import { onFileDrop, statementOf } from "../lib/fileDrop";
import { ImportSaveGuard } from "../lib/importSaveGuard";
import { AccountSelect, CategorySelect } from "../components/Fields";
import { ErrorText } from "../components/Modal";
import { parseView, SavedViews } from "../components/SavedViews";
import { TxnTable } from "../components/TxnTable";
import { api, QUICK_FILTERS, TXN_TYPES, type QuickFilter, type TxnFilter, type TxnType } from "../lib/api";
import { formatDate, monthBounds, monthTitle, shiftMonth, today } from "../lib/dates";
import { useAccounts, useCategories, useCurrencies, useSettings } from "../lib/queries";
import { AGGREGATE_STALE_MS } from "../lib/queryPolicy";
import { type TxnJump, useUi } from "../lib/store";
import { ScreenTitle } from "../components/SectionIcon";
import { ChecksCard } from "../components/QuickWins";
import "./transactions.css";

const PAGE = 100;
type JournalFilter = TxnFilter & Pick<TxnJump, "subscription">;

/** Р3 «Крупные» по умолчанию: от 10 000 в основной валюте (в целых единицах). */
const LARGE_DEFAULT = 10_000;

function journalPeriod(from?: string, to?: string) {
  if (from && to) return from === to ? formatDate(from) : `С ${formatDate(from)} по ${formatDate(to)}`;
  if (from) return `С ${formatDate(from)}`;
  if (to) return `По ${formatDate(to)} включительно`;
  return "За всё время";
}

export function Transactions() {
  const accounts = useAccounts(true).data ?? [];
  const categories = useCategories(true).data ?? [];
  const { txnFilter, viewJump, openTxnForm, reportOrigin, returnToReport } = useUi();
  const reviewOpen = useUi((s) => s.operationReview);
  const [from, to] = monthBounds(today());
  const [f, setF] = useState<JournalFilter>(() => txnFilter ?? { dateFrom: from, dateTo: to });
  const [search, setSearch] = useState("");
  const [minAmountDraft, setMinAmountDraft] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const events = useQuery({ queryKey: ["events"], queryFn: api.listEvents }).data ?? [];
  const tags = useQuery({ queryKey: ["tags"], queryFn: api.listTags }).data ?? [];
  const [sel, setSel] = useState<SelState>(EMPTY_SEL);
  // Знаков после запятой у валюты: у иены их нет, у рубля два (суммы фильтров — в минимальных единицах).
  const currencies = useCurrencies().data;
  const settings = useSettings().data;
  const baseCode = settings?.base_currency;
  const showAmounts = !!settings && settings.hide_amounts !== "1";
  const unitsOf = (code: string | undefined) => currencies?.find((c) => c.code === code)?.minorUnits ?? 2;
  const baseScale = 10 ** unitsOf(baseCode);

  // Переход с фильтром со Счетов или Категорий: за всё время.
  useEffect(() => {
    if (txnFilter) {
      setMinAmountDraft(null);
      setLimit(PAGE);
      setF({ ...txnFilter });
      setSearch(txnFilter.search ?? "");
      useUi.setState({ txnFilter: null });
    }
  }, [txnFilter]);

  const table = useTxnTable();
  const applyView = (v: { filter: JournalFilter; search: string; table?: TxnTableLayout }) => {
    setMinAmountDraft(null);
    setLimit(PAGE);
    // Вид, сохранённый до Г8, таблицу не трогает.
    if (v.table) saveTable(parseTable(v.table));
    setSearch(v.search ?? "");
    setF({ ...v.filter, search: v.search || undefined });
  };
  // Вид, открытый из бокового меню.
  useEffect(() => {
    if (viewJump?.kind !== "transactions") return;
    const params = parseView<{ filter: JournalFilter; search: string; table?: TxnTableLayout }>(viewJump.params);
    if (params) applyView(params);
    useUi.setState({ viewJump: null });
  }, [viewJump]);

  useEffect(() => {
    const t = setTimeout(() => setF((cur) => ({ ...cur, search: search || undefined })), 250);
    return () => clearTimeout(t);
  }, [search]);

  const selectedSubscription = f.subscription;
  const subscriptions = useQuery({ queryKey: ["subscriptions"], queryFn: api.listSubscriptions, enabled: !!selectedSubscription });
  const series = selectedSubscription && subscriptions.data?.items.find((s) => s.key === selectedSubscription.key && s.currencyCode === selectedSubscription.currencyCode);
  const scopeReady = !selectedSubscription || subscriptions.isSuccess;
  const activeFilter = useMemo<TxnFilter>(() => {
    const { subscription, ...filter } = f;
    return subscription ? { ...filter, paymentIds: series?.paymentIds ?? [] } : filter;
  }, [f, series]);
  const query = { ...activeFilter, sort: sortParam(table), limit };
  const page = useQuery({ queryKey: ["transactions", query], queryFn: () => api.listTransactions(query), enabled: scopeReady, placeholderData: f.subscription ? undefined : keepPreviousData, staleTime: AGGREGATE_STALE_MS });
  const finding = !scopeReady || search !== (f.search ?? "") || page.isPlaceholderData;
  const exp = useExport(`Kazna — операции ${today()}`, (path) => api.exportTransactions({ ...activeFilter, search: search || undefined }, path), ["csv", "xlsx", "ofx"], scopeReady);
  // Импорт выписки: кнопкой или файлом, брошенным в окно (undefined — окно закрыто).
  const [importFile, setImportFile] = useState<string | null | undefined>(undefined);
  const [importKey, setImportKey] = useState(0);
  const [importSaveGuard] = useState(() => new ImportSaveGuard());
  const [dropping, setDropping] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  useEffect(
    () =>
      onFileDrop((s) => {
        if (s === "over") return setDropping(!importSaveGuard.busy);
        setDropping(false);
        if (s === "leave" || importSaveGuard.busy) return;
        const file = statementOf(s.paths);
        if (!file) return setDropError("Этот файл не выписка: подойдёт Excel (.xlsx, .xls), CSV или PDF");
        setDropError(null);
        setImportKey((k) => k + 1);
        setImportFile(file);
      }),
    [importSaveGuard],
  );
  const set = (patch: Partial<JournalFilter>) => {
    setLimit(PAGE);
    const next = { ...f, ...patch };
    if (!next.counted || next.dateFrom !== f.dateFrom || next.dateTo !== f.dateTo) delete next.budgetMonth;
    setF(next);
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
  const filterKey = JSON.stringify(activeFilter);
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
  const rows = useMemo(() => (items ? orderedRows(items, table.group).map((r) => ({ key: r.key, ids: rowIds(r) })) : []), [items, table.group]);
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
        if (!total || finding || page.isError || selectionRequest.current) return;
        const request = new AbortController();
        selectionRequest.current = request;
        setSelectingAll(true);
        setSelectionError(null);
        setSel(EMPTY_SEL);
        // Всё отфильтрованное, а не только первые 5000 строк, которые может вернуть ядро.
        try {
          const ids = await loadAllTransactionIds(api.listTransactions, activeFilter, request.signal);
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
  }, [activeFilter, filterKey, total, txnFormOpen, sel.ids.size, finding, page.isError, cancelSelection]);
  const onToggle = (key: string, mods: { shift: boolean; ctrl: boolean }) => {
    if (finding || page.isError) return;
    cancelSelection();
    setSelectionError(null);
    selectAllRef.current = false;
    setSel((cur) => clickRow(cur, rows, key, mods));
  };

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
  const toggleQuick = (q: QuickFilter) => {
    const now = f.quick ?? [];
    const next = now.includes(q) ? now.filter((x) => x !== q) : [...now, q];
    set({ quick: next.length ? next : undefined });
  };
  // Включённые фильтры — плашками с крестиком, видны и при свёрнутой панели.
  const chips: { id: string; label: string; clear: () => void }[] = [];
  if (f.subscription) chips.push({ id: "chip-subscription", label: `Подписка · ${series?.payee ?? f.subscription.key} · ${f.subscription.currencyCode}`, clear: () => set({ subscription: undefined }) });
  if (f.budgetMonth) chips.push({ id: "chip-budget", label: `Бюджет · ${monthTitle(f.budgetMonth)}`, clear: () => set({ budgetMonth: undefined }) });
  if (f.accountId) chips.push({ id: "chip-account", label: accounts.find((a) => a.id === f.accountId)?.name ?? "Счёт", clear: () => set({ accountId: undefined }) });
  if (f.categoryId) chips.push({ id: "chip-category", label: categories.find((c) => c.id === f.categoryId)?.name ?? "Категория", clear: () => set({ categoryId: undefined }) });
  if (f.types?.length) {
    const label = f.types.map((type) => {
      if (f.counted && type === "expense") return "Расход с возвратами";
      if (f.counted && type === "income") return "Доход без возвратов";
      return TXN_TYPES[type];
    }).join(", ");
    chips.push({ id: "chip-type", label, clear: () => set({ types: undefined, counted: undefined }) });
  } else if (f.counted) {
    chips.push({ id: "chip-counted", label: "По дате учёта", clear: () => set({ counted: undefined }) });
  }
  if (f.tagId) chips.push({ id: tags.some((t) => t.id === f.tagId) ? "chip-tag" : "filter-tag", label: tags.find((t) => t.id === f.tagId) ? `#${tags.find((t) => t.id === f.tagId)!.name}` : "Тег", clear: () => set({ tagId: undefined }) });
  if (f.importId) chips.push({ id: "filter-import", label: "Один импорт", clear: () => set({ importId: undefined }) });
  if (f.payee) chips.push({ id: "filter-payee", label: `Получатель: ${f.payee}`, clear: () => set({ payee: undefined }) });
  for (const q of f.quick ?? []) {
    const label = QUICK_FILTERS.find((x) => x.key === q)?.label ?? q;
    chips.push({ id: `chip-quick-${q}`, label, clear: () => toggleQuick(q) });
  }
  if (f.amount) {
    const currency = currencies?.find((c) => c.code === f.currency);
    const label = showAmounts && currency
      ? `Сумма: ${(f.amount / 10 ** currency.minorUnits).toLocaleString("ru-RU")} ${currency.code}` : "Точная сумма";
    chips.push({ id: "chip-amount", label, clear: () => set({ amount: undefined, currency: undefined }) });
  } else if (f.currency) {
    chips.push({ id: "chip-currency", label: `Валюта: ${f.currency}`, clear: () => set({ currency: undefined }) });
  }
  if (f.minAmount) chips.push({ id: "chip-large", label: showAmounts && currencies && baseCode ? `Крупные: от ${(f.minAmount / baseScale).toLocaleString("ru-RU")} ${baseCode}` : "Крупные операции", clear: () => set({ minAmount: undefined }) });
  if (f.eventId) chips.push({ id: "filter-event", label: events.find((e) => e.id === f.eventId)?.name ?? "Событие", clear: () => set({ eventId: undefined }) });

  const hasConditions = chips.length > 0 || !!f.search;
  const hasScope = hasConditions || !!f.dateFrom || !!f.dateTo;
  // Итог найденного исторически показывается при отклонении от исходного текущего месяца.
  const showFilteredTotal = hasConditions || f.dateFrom !== from || f.dateTo !== to;
  const emptyPage = page.isSuccess && !page.isFetching && !finding && page.data.total === 0;
  const journal = useQuery({
    queryKey: ["transactions", { limit: 1 }],
    queryFn: () => api.listTransactions({ limit: 1 }),
    select: (result) => result.total,
    enabled: emptyPage && hasScope,
    staleTime: AGGREGATE_STALE_MS,
  });
  const checkingEmpty = emptyPage && hasScope && (journal.isPending || journal.isFetching);
  const emptyJournal = emptyPage && (!hasScope || (journal.isSuccess && journal.data === 0));
  const showAllInEmpty = emptyPage && hasScope && !checkingEmpty && journal.isSuccess && journal.data > 0;
  const resultsTitle = useRef<HTMLHeadingElement>(null);
  let resultStatus = "";
  if (!scopeReady) {
    if (subscriptions.isPending) resultStatus = "Загружаем платежи подписки…";
  } else if (page.isPending || checkingEmpty || (page.isFetching && page.data?.total === 0)) {
    resultStatus = "Загружаем операции…";
  } else if (finding && page.data) {
    resultStatus = "Обновляем список. Пока показаны предыдущие результаты.";
  }
  const showAll = () => {
    if (!hasScope && !search) return;
    if (showAllInEmpty) resultsTitle.current?.focus();
    cancelSelection();
    selectAllRef.current = false;
    setSel(EMPTY_SEL);
    setSearch("");
    setMinAmountDraft(null);
    setLimit(PAGE);
    setF({});
  };
  const showAllButton = (
    <button type="button" className="link" data-testid="txn-show-all" onClick={showAll}>
      Показать все операции
    </button>
  );

  return (
    <section className="screen wide txn-screen">
      {reportOrigin && <button type="button" className="link" autoFocus data-testid="back-to-report" onClick={returnToReport}>Вернуться к отчёту</button>}
      <div className="screen-head txn-screen-head">
        <ScreenTitle id="transactions" />
        <div className="txn-actions">
          <button type="button" className={reviewOpen ? "btn active" : "btn"} aria-expanded={reviewOpen} aria-controls={reviewOpen ? "operations-review" : undefined} data-testid="transactions-review-toggle"
            onClick={() => useUi.setState({ operationReview: !reviewOpen })}>На проверке</button>
          <TxnHeadBar onImport={() => setImportFile(null)} exp={exp} />
          <button className="btn primary" onClick={() => openTxnForm({ mode: "new", type: "expense" })} title="Ctrl+N">
            + Операция
          </button>
        </div>
      </div>
      {reviewOpen && <ChecksCard inOperations />}
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
      {importFile !== undefined && <ImportDialog key={importKey} initialPath={importFile ?? undefined} saveGuard={importSaveGuard} onClose={() => setImportFile(undefined)} />}
      <ErrorText error={selectionError} />
      {selectingAll && <p className="hint" role="status" data-testid="select-all-loading">Выделяем все найденные операции…</p>}
      <SavedViews
        kind="transactions"
        current={{ filter: { ...f, search: undefined }, search, table }}
        onApply={applyView}
      />
      <div className="card filters" data-testid="filters">
        <div className="filters-row txn-search-row">
          <input type="search" name="search" data-search aria-label="Поиск операций" placeholder="Поиск: получатель, комментарий, сумма" value={search} onChange={(e) => {
            cancelSelection();
            selectAllRef.current = false;
            setSel(EMPTY_SEL);
            setSearch(e.target.value);
          }} />
          <button type="button" className={panelOpen ? "btn small active" : "btn small"} aria-expanded={panelOpen} data-open={panelOpen || undefined} data-testid="filters-toggle" onClick={() => togglePanel(!panelOpen)} title="Счёт, категория, тип и другие условия">
            <SlidersHorizontal size={14} strokeWidth={1.75} aria-hidden="true" /> Фильтры{chips.length > 0 ? ` · ${chips.length}` : ""}
          </button>
          <TableViewMenu layout={table} />
        </div>
        <div className="filters-row txn-period-row">
          <div className="tabs small motion-segments" role="group" aria-label="Период" data-testid="period">
            {periods.map((p) => (
              <button key={p.key} type="button" className={periodKey === p.key ? "tab active" : "tab"} aria-pressed={periodKey === p.key} onClick={() => set({ dateFrom: p.from, dateTo: p.to })}>
                {p.label}
              </button>
            ))}
          </div>
          <input type="date" aria-label="С даты" name="dateFrom" value={f.dateFrom ?? ""} onChange={(e) => set({ dateFrom: e.target.value || undefined })} />
          <span className="muted">—</span>
          <input type="date" aria-label="По дату" name="dateTo" value={f.dateTo ?? ""} onChange={(e) => set({ dateTo: e.target.value || undefined })} />
          {!showAllInEmpty && showAllButton}
        </div>
        {panelOpen && (
          <div className="filters-row" data-testid="filters-panel">
            <AccountSelect name="filterAccount" accounts={accounts} value={f.accountId ?? ""} onChange={(v) => set({ accountId: v || undefined })} placeholder="Все счета" />
            <CategorySelect name="filterCategory" categories={categories} value={f.categoryId ?? ""} onChange={(v) => set({ categoryId: v || undefined })} placeholder="Все категории" />
            <select name="filterType" aria-label="Тип" value={f.types && f.types.length > 1 ? "multiple" : f.types?.[0] ?? ""} onChange={(e) => set({ types: e.target.value ? [e.target.value as TxnType] : undefined, counted: undefined })}>
              <option value="">Все типы</option>
              {f.types && f.types.length > 1 && <option value="multiple" disabled>Несколько типов</option>}
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
            <div className="tabs small quick-filters" role="group" aria-label="Готовые фильтры" data-testid="quick-filters">
              {QUICK_FILTERS.map((q) => {
                const on = f.quick?.includes(q.key) ?? false;
                return (
                  <button key={q.key} type="button" className={on ? "tab active" : "tab"} aria-pressed={on} title={q.hint} data-testid={`quick-${q.key}`} onClick={() => toggleQuick(q.key)}>
                    {q.label}
                  </button>
                );
              })}
              <button type="button" className={f.minAmount ? "tab active" : "tab"} aria-pressed={!!f.minAmount} title="Операции от суммы в основной валюте; валютные — по курсу" data-testid="quick-large" onClick={() => set({ minAmount: f.minAmount ? undefined : LARGE_DEFAULT * baseScale })}>
                Крупные
              </button>
            </div>
            {!!f.minAmount && showAmounts && currencies && baseCode && (
              <label className="inline-field">
                <span className="muted">от</span>
                <input type="number" name="minAmount" data-testid="quick-large-amount" min={1} step={1000} value={minAmountDraft ?? f.minAmount / baseScale} onBlur={() => setMinAmountDraft(null)} onChange={(e) => {
                  // Пустое поле во время ввода не снимает уже применённый порог.
                  const text = e.target.value;
                  setMinAmountDraft(text);
                  const v = Math.round(Number(text) * baseScale);
                  if (v > 0) set({ minAmount: v });
                }} />
              </label>
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
      <div className="card" role="region" aria-labelledby="txn-results-title">
        <header className="txn-results-header">
          <h2 ref={resultsTitle} tabIndex={-1} id="txn-results-title" data-testid="txn-result-period">{journalPeriod(f.dateFrom, f.dateTo)}</h2>
          <span className="muted txn-results-status" role="status">
            {resultStatus}
          </span>
          {scopeReady && page.data && (
            <div className="muted" data-testid="txn-count">
              Показано {page.data.items.length} из {page.data.total}
              {sel.ids.size === 0 && <Hint of="txn.select" />}
            </div>
          )}
        </header>
        {f.counted && f.types?.includes("expense") && (
          <p className="hint">
            Возвраты подобраны по дате учёта, распределённые расходы — по датам их частей.{" "}
            {f.budgetMonth || f.dateFrom || f.dateTo ? "У распределённой покупки видны полное списание и сумма, учтённая за период." : "В таблице показаны исходные даты и полные суммы операций."}
          </p>
        )}
        {f.subscription && subscriptions.isError && <p className="error">Не удалось загрузить платежи подписки. <button className="link" onClick={() => void subscriptions.refetch()}>Повторить</button></p>}
        {page.error && <p className="error">{String(page.error)}</p>}
        {scopeReady && page.data && (
          <>
            {page.data.items.length > 0 && <TxnTable items={page.data.items} isBudgetPeriod={Boolean(f.budgetMonth)} selection={{ sel, onToggle }} layout={table} onSort={(by) => saveTable(clickSort(table, by))} partial={page.data.items.length < page.data.total} />}
            {emptyPage && !checkingEmpty && (
              <div className="txn-empty" data-testid="txn-empty">
                <strong>{emptyJournal ? "В журнале пока нет операций" : "По этим условиям операций нет"}</strong>
                <p className="muted">{emptyJournal ? "Добавьте первую операцию или загрузите выписку." : "Измените период или снимите фильтры."}</p>
                {showAllInEmpty && showAllButton}
              </div>
            )}
            {page.data.items.length < page.data.total && (
              <div className="table-foot muted">
                <button className="link" disabled={finding} onClick={() => setLimit(limit + PAGE)}>
                  Показать ещё
                </button>
              </div>
            )}
          </>
        )}
      </div>
      <SelectionBar
        ids={finding ? [] : [...sel.ids]}
        filter={{ ...activeFilter, limit: undefined, offset: undefined }}
        filtered={showFilteredTotal && page.isSuccess && !finding}
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
