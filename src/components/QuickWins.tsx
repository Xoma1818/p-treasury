import { AGGREGATE_STALE_MS } from "../lib/queryPolicy";
// Карточки Главной 0.16: «Необычно в этом месяце» (А2) и «Проверьте» (А3).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useRef, useState } from "react";
import { Check as CheckIcon, CircleAlert } from "lucide-react";
import { api, type Budget, type BudgetLine, type BudgetWarning, type Check } from "../lib/api";
import { MatchesDialog, useSuggestions } from "./ImportHistory";
import { formatDate, today } from "../lib/dates";
import { backupRow, ratesRow, uncategorizedRow, type StatusRow } from "../lib/dataStatus";
import { budgetQuery, useAccounts, useCurrencies, useMonthOf, useSettings, useSpendingVsUsual } from "../lib/queries";
import { warningCoverTarget } from "../lib/budgetCover";
import { BudgetCoverDialog } from "./BudgetCoverDialog";
import { useUi } from "../lib/store";
import { useAction } from "../lib/useAction";
import { Hint } from "./Hint";
import { ErrorText } from "./Modal";
import { Money } from "./Money";
import { Sparkline } from "./Dashboard";

/** А2: до трёх категорий, где траты с начала месяца заметно не как обычно. */
export function UnusualCard() {
  const month = useMonthOf(today()).data?.month;
  const r = useSpendingVsUsual(month).data;
  const showTransactions = useUi((s) => s.showTransactions);
  const editPlan = useUi((s) => s.editPlan);
  return (
    <div className="card qw-card" data-testid="home-unusual">
      <h2>
        Необычно в этом месяце
        <Hint of="home.unusual" />
      </h2>
      {r && r.monthsCounted === 0 && <p className="muted">Сравнивать пока не с чем: нужна история хотя бы за один прошлый месяц.</p>}
      {r && r.monthsCounted > 0 && r.home.length === 0 && <p className="muted qw-calm">Траты идут как обычно.</p>}
      {r && r.home.length > 0 && (
        <ul className="qw-list">
          {r.home.map((u) => {
            const up = (u.percent ?? 0) > 0;
            return (
              <li key={u.categoryId} className="qw-unusual">
                <button
                  className="qw-row clickable"
                  data-testid="unusual-row"
                  title="Показать операции категории за месяц"
                  onClick={() => showTransactions({ categoryId: u.categoryId, dateFrom: r.from, dateTo: r.to })}
                >
                  <span className="qw-main">
                    <b>{u.name}</b>: <Money amount={u.current} symbol={r.baseSymbol} />
                  </span>
                  <span className={up ? "usual-pill up" : "usual-pill down"}>
                    {u.percent == null ? "раньше не было" : `на ${Math.abs(u.percent)} % ${up ? "больше" : "меньше"} обычного`}
                  </span>
                  <span className="qw-sub muted">
                    {up ? "Почему: " : ""}обычно за это время <Money amount={u.usual} symbol={r.baseSymbol} />
                    {u.percent == null ? ", в прошлые месяцы трат здесь не было" : ""}
                  </span>
                </button>
                <span className="qw-actions">
                  <button className="btn small" onClick={() => showTransactions({ categoryId: u.categoryId, dateFrom: r.from, dateTo: r.to })}>
                    Посмотреть операции
                  </button>
                  {up && (
                    <button className="btn small" onClick={() => editPlan(u.categoryId)} title="Открыть бюджет месяца на лимите этой категории">
                      Изменить план
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {r && r.monthsCounted > 0 && r.monthsCounted < 3 && <p className="hint">Сравнение по {r.monthsCounted === 1 ? "одному прошлому месяцу" : "двум прошлым месяцам"}.</p>}
    </div>
  );
}

const KIND: Record<Check["kind"], string> = {
  duplicate: "Дубль?",
  large: "Крупнее обычного",
  price: "Подорожало",
};

/** Прячет суммы в готовом тексте ядра, когда включено «Скрыть суммы». */
export function maskAmounts(text: string): string {
  return text
    .replace(/[−+-]?\d+(?:[ \u00a0\u202f]\d{3})*(?:[.,]\d+)?\s?(?:₽|\$|€|¥|£|₸|₺|Br\b|AED\b)/g, "•••")
    .replace(/[−+-]?\d+(?:[ \u00a0\u202f]\d{3})*(?:[.,]\d+)?(?= из •••)/g, "•••");
}

/** Сколько строк «Проверьте» видно сразу; остальные — по «Показать все». */
const CHECKS_SHOWN = 5;

/** А3: странные списания за 30 дней. */
export function ChecksCard({ inOperations = false, budget }: { inOperations?: boolean; budget?: Budget } = {}) {
  const date = today();
  const settings = useSettings().data;
  const hidden = !settings || settings.hide_amounts === "1";
  const show = (t: string) => (hidden ? maskAmounts(t) : t);
  const checkQuery = useQuery({ staleTime: AGGREGATE_STALE_MS, queryKey: ["checks", date], queryFn: api.listChecks });
  const checks = checkQuery.data;
  const warnings = useQuery({ staleTime: AGGREGATE_STALE_MS, queryKey: ["budgetWarnings", date], queryFn: api.budgetWarnings, enabled: !inOperations }).data ?? [];
  const openTxnForm = useUi((s) => s.openTxnForm);
  const showTransactions = useUi((s) => s.showTransactions);
  const openOperationReview = useUi((s) => s.openOperationReview);
  const editPlan = useUi((s) => s.editPlan);
  const heading = useRef<HTMLHeadingElement>(null);
  const coverOpener = useRef<HTMLButtonElement | null>(null);
  const currencies = useCurrencies().data;
  const minor = currencies?.find((c) => c.code === budget?.currencyCode)?.minorUnits;
  const [cover, setCover] = useState<{ budget: Budget; target: BudgetLine; minor: number } | null>(null);
  const queries = useQueryClient();
  const preview = useMutation({
    mutationFn: async (warning: BudgetWarning) => {
      const latest = await queries.fetchQuery({ ...budgetQuery(warning.month), staleTime: 0 });
      const target = warningCoverTarget(latest, warning);
      if (!budget || !target || latest.id !== budget.id || latest.currencyCode !== budget.currencyCode || minor === undefined) {
        void queries.invalidateQueries({ queryKey: ["budgetWarnings"] });
        throw new Error("Бюджет изменился. Проверьте актуальные лимиты.");
      }
      return { budget: latest, target, minor };
    },
  });
  const closeCover = () => {
    setCover(null);
    requestAnimationFrame(() => (coverOpener.current?.isConnected ? coverOpener.current : heading.current)?.focus());
  };
  const dismiss = useAction(api.dismissCheck);
  const removeSecond = useAction(api.deleteDuplicate);
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const shown = checks && !showAll && !inOperations ? checks.slice(0, CHECKS_SHOWN) : checks;
  const matchQuery = useSuggestions();
  const matches = matchQuery.data?.length ?? 0;
  const [matchesOpen, setMatchesOpen] = useState(false);
  const period = useMonthOf(date).data;
  const uncategorized = useQuery({
    queryKey: ["transactions", "uncategorized", period?.start, period?.end],
    queryFn: () => api.listTransactions({ dateFrom: period!.start, dateTo: period!.end, quick: ["uncategorized"], limit: 1 }),
    enabled: inOperations && !!period,
  });

  // Операцию находим среди операций её дня: отдельной команды «одна операция» нет.
  const open = async (c: Check) => {
    setOpening(c.key);
    setOpenError(null);
    try {
      const page = await api.listTransactions({ dateFrom: c.date, dateTo: c.date, limit: 1000 });
      const t = page.items.find((x) => x.id === c.transactionId);
      if (t) openTxnForm({ mode: "edit", txn: t });
      else setOpenError("Операция не найдена: возможно, её уже удалили.");
    } catch (e) {
      setOpenError(String(e));
    } finally {
      setOpening(null);
    }
  };

  return (
    <div className="card qw-card" id={inOperations ? "operations-review" : undefined} data-testid={inOperations ? "operations-review" : "home-checks"}>
      <h2 ref={heading} tabIndex={-1}>
        {inOperations ? "Операции на проверке" : "Проверьте"}
        {!inOperations && <Hint of="home.checks" />}
      </h2>
      {matches > 0 && (
        <p className="warn" data-testid="checks-matches">
          Выписка: совпадений на подтверждение — {matches}.{" "}
          <button className="link" onClick={() => setMatchesOpen(true)}>
            Разобрать
          </button>
        </p>
      )}
      {matchesOpen && <MatchesDialog onClose={() => setMatchesOpen(false)} />}
      {inOperations && period && !!uncategorized.data?.total && (
        <p data-testid="review-uncategorized">
          Без категории за бюджетный месяц · {uncategorized.data.total}.{" "}
          <button type="button" className="link" onClick={() => showTransactions({ dateFrom: period.start, dateTo: period.end, quick: ["uncategorized"] })}>
            Открыть операции
          </button>
        </p>
      )}
      {!inOperations && warnings.length > 0 && (
        <ul className="qw-list" data-testid="budget-warnings">
          {warnings.map((w) => {
            const target = warningCoverTarget(budget, w);
            const planAction = target && budget && minor !== undefined ? (
              <button key="cover" className="btn small" type="button" aria-haspopup="dialog" data-testid="warning-cover"
                disabled={preview.isPending} aria-busy={preview.isPending && preview.variables?.key === w.key}
                onClick={(e) => { coverOpener.current = e.currentTarget; preview.mutate(w, { onSuccess: setCover }); }}>
                Покрыть <Money amount={-target.remaining} symbol={budget.currencySymbol} currencyCode={budget.currencyCode} minorUnits={minor} />…
              </button>
            ) : (
              <button key="edit" className="btn small" onClick={() => editPlan(w.categoryId)} data-testid="warning-plan">Изменить план</button>
            );
            return <WarningRow key={w.key} w={w} hidden={hidden} planAction={planAction}
              onOps={() => showTransactions({ categoryId: w.categoryId, dateFrom: w.start, dateTo: w.end })}
              onOk={() => dismiss.run(w.key)} busy={dismiss.busy} />;
          })}
        </ul>
      )}
      {cover && <BudgetCoverDialog {...cover} onClose={closeCover} />}
      {!inOperations && checks && checks.length === 0 && warnings.length === 0 && (
        <p className="qw-calm" data-testid="checks-calm">
          <CheckIcon className="qw-ok" size={16} aria-hidden />
          Всё спокойно: странных списаний за 30 дней нет.
        </p>
      )}
      {inOperations && checkQuery.isSuccess && matchQuery.isSuccess && uncategorized.isSuccess &&
        checks?.length === 0 && matches === 0 && uncategorized.data.total === 0 && (
          <p className="qw-calm" data-testid="review-empty">Всё проверено.</p>
        )}
      {checks && checks.length > 0 && (
        <ul className="qw-list">
          {shown!.map((c) => (
            <li key={c.key} className="qw-check" data-testid="check-row" data-kind={c.kind}>
              <span className={`qw-kind ${c.kind}`}>{KIND[c.kind]}</span>
              <span className="qw-text">
                <span className="qw-main">{show(c.title)}</span>
                <span className="qw-sub muted">
                  {show(c.detail)} · {formatDate(c.date)}
                </span>
              </span>
              <span className="qw-actions">
                <button className="btn small" onClick={() => open(c)} disabled={opening === c.key} aria-busy={opening === c.key}>
                  Открыть
                </button>
                {c.kind === "duplicate" && c.secondId && (
                  <button
                    className="btn small danger"
                    title="Удалить более позднюю из двух операций. Отмена — Ctrl+Z"
                    onClick={() => removeSecond.run(c.secondId!)}
                    disabled={removeSecond.busy}
                  >
                    Удалить второй
                  </button>
                )}
                <button className="btn small" onClick={() => dismiss.run(c.key)} disabled={dismiss.busy} data-testid="check-ok">
                  Всё в порядке
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {!inOperations && checks && checks.length > CHECKS_SHOWN && (
        <button type="button" className="link qw-more" data-testid="checks-more" onClick={() => setShowAll(!showAll)}>
          {showAll ? "Свернуть" : `Показать все (${checks.length})`}
        </button>
      )}
      {inOperations && (checkQuery.isLoading || matchQuery.isLoading || uncategorized.isLoading) &&
        <p className="muted" role="status">Ищем операции…</p>}
      <ErrorText error={dismiss.error ?? removeSecond.error ?? openError ?? (preview.error ? String(preview.error instanceof Error ? preview.error.message : preview.error) : null) ??
        (inOperations && (checkQuery.error ?? matchQuery.error ?? uncategorized.error)
          ? String(checkQuery.error ?? matchQuery.error ?? uncategorized.error) : null)} />
      {!inOperations && (
        <>
          <button type="button" className="link" data-testid="open-operations-review" onClick={openOperationReview}>Перейти к проверке операций</button>
          <DataStatus />
        </>
      )}
    </div>
  );
}

/** Состояние данных: когда была копия, свежи ли курсы, есть ли операции без категории. */
export function DataStatus() {
  const date = today();
  const settings = useSettings().data;
  const period = useMonthOf(date).data;
  const backup = useQuery({ queryKey: ["backupStatus"], queryFn: api.backupStatus }).data;
  const vault = useQuery({ queryKey: ["vaultStatus"], queryFn: api.vaultStatus }).data;
  const rates = useQuery({ queryKey: ["ratesOverview", date], queryFn: () => api.ratesOverview(date) }).data;
  const accounts = useAccounts().data;
  const uncategorized = useQuery({
    queryKey: ["transactions", "uncategorized", period?.start, period?.end],
    queryFn: () => api.listTransactions({ dateFrom: period!.start, dateTo: period!.end, quick: ["uncategorized"], limit: 1 }),
    enabled: !!period,
  }).data?.total;
  const { showTransactions, openSettings } = useUi();
  const base = rates?.base ?? settings?.base_currency;
  const used = [...new Set((accounts ?? []).map((a) => a.currencyCode).filter((c) => c !== base))].sort();
  const rows = [
    backupRow(backup, vault, date, formatDate),
    accounts && base ? ratesRow(used, rates?.rates, rates?.checkedAt, settings?.rates_auto !== "0", date, formatDate) : null,
    uncategorizedRow(uncategorized),
  ].filter((r): r is StatusRow => r !== null);
  const action: Record<StatusRow["key"], { label: string; run: () => void }> = {
    backup: { label: "Копии", run: () => openSettings({ section: "vault" }) },
    rates: { label: "Курсы", run: () => openSettings({ section: "rates" }) },
    uncategorized: { label: "Разобрать", run: () => period && showTransactions({ dateFrom: period.start, dateTo: period.end, quick: ["uncategorized"] }) },
  };
  if (rows.length === 0) return null;
  return (
    <div className="data-status" data-testid="data-status">
      <h3 className="sub-head">
        Состояние данных
        <Hint of="home.dataStatus" />
      </h3>
      <ul>
        {rows.map((r) => (
          <li key={r.key} data-testid="data-status-row" data-key={r.key} data-level={r.level}>
            {r.level === "ok" ? <CheckIcon className="qw-ok" size={16} aria-hidden /> : <CircleAlert className="ds-warn" size={16} aria-hidden />}
            <span>{r.text}</span>
            {(r.level === "warn" || r.key !== "uncategorized") && (
              <button type="button" className="link" onClick={action[r.key].run}>
                {action[r.key].label}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Предупреждение бюджета: что случилось, почему и что сделать. */
export function WarningRow({ w, hidden, onOps, planAction, onOk, busy }: { w: BudgetWarning; hidden: boolean; onOps: () => void; planAction: ReactNode; onOk: () => void; busy: boolean }) {
  const used = w.actual === w.limit;
  return (
    <li className="qw-check" data-testid="warning-row" data-level={w.level}>
      <span className={`qw-kind ${used ? "used" : w.level === 100 ? "over" : "warn"}`}>
        {used ? "Лимит использован" : w.level === 100 ? "Лимит превышен" : "Скоро лимит"}
      </span>
      <span className="qw-text">
        <span className="qw-main">{hidden ? `${w.categoryName} · ${w.percent} % лимита` : w.text}</span>
        <span className="qw-sub muted" data-testid="warning-reason">
          {hidden ? "В операциях можно проверить расходы этой категории за бюджетный месяц." : w.reason}
        </span>
      </span>
      <span className="qw-actions">
        <button className="btn small" onClick={onOps} data-testid="warning-ops">
          Посмотреть операции
        </button>
        {planAction}
        <button className="btn small" onClick={onOk} disabled={busy} title="Скрыть до следующего порога в этом месяце">
          Понятно
        </button>
      </span>
    </li>
  );
}

/** В3: мини-график чистых активов за 12 месяцев у плитки баланса; нажатие открывает отчёт. */
export function NetWorthSpark() {
  const h = useQuery({ staleTime: AGGREGATE_STALE_MS, queryKey: ["netWorth", 12, today()], queryFn: () => api.netWorthHistory(12) }).data;
  const openReport = useUi((s) => s.openReport);
  const values = h?.points.map((p) => p.net) ?? [];
  if (values.length < 2) return null;
  return (
    <button className="nw-spark" data-testid="home-net-worth-spark" title="Чистые активы за 12 месяцев — открыть отчёт" onClick={() => openReport("networth")}>
      <Sparkline values={values} className="networth" />
    </button>
  );
}
