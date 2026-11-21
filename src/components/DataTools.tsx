import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileUp } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type BankImportDecision, type CsvMapping, type ImportPreview, type ImportRow, type ImportSaved, type UpdateInfo } from "../lib/api";
import { CsvProfileEditor } from "./CsvProfileEditor";
import { importRowExplanation } from "../lib/importRowExplanation";
import { ImportHistoryDialog, MatchesDialog, StatementMatchSide } from "./ImportHistory";
import { formatDate, monthBounds, today } from "../lib/dates";
import { baseName, CSV, OFX, pickOpen, pickSave, STATEMENT, XLSX } from "../lib/files";
import { useAccounts, useSettings } from "../lib/queries";
import { useUi } from "../lib/store";
import { useAction } from "../lib/useAction";
import { AccountSelect, Field } from "./Fields";
import { ErrorText, Modal } from "./Modal";
import { DecorativeIcon } from "./DecorativeIcon";
import { Hint } from "./Hint";
import { ImportSaveGuard } from "../lib/importSaveGuard";
import "./importOverview.css";

type Kind = "month" | "quarter" | "year" | "custom";

/** Период по виду: текущий месяц, квартал или год. */
function periodOf(kind: Kind, date: string): [string, string] {
  const [y, m] = date.split("-").map(Number);
  if (kind === "year") return [`${y}-01-01`, `${y}-12-31`];
  if (kind === "quarter") {
    const q = Math.floor((m - 1) / 3) * 3 + 1;
    const [, end] = monthBounds(`${y}-${String(q + 2).padStart(2, "0")}-01`);
    return [`${y}-${String(q).padStart(2, "0")}-01`, end];
  }
  return monthBounds(date);
}

/** Диалог «Сводка в Excel»: период и 6 листов. */
export function SummaryDialog({ onClose }: { onClose: () => void }) {
  const [kind, setKind] = useState<Kind>("month");
  const [[from, to], setRange] = useState(periodOf("month", today()));
  const [done, setDone] = useState<string | null>(null);
  const run = useAction(async (format: "xlsx" | "csv") => {
    const path = await pickSave(`Kazna — сводка ${from} — ${to}.${format}`, [format === "csv" ? CSV : XLSX]);
    if (!path) return;
    await api.exportSummary(from, to, path);
    setDone(path);
  });
  const choose = (k: Kind) => {
    setKind(k);
    if (k !== "custom") setRange(periodOf(k, today()));
  };
  return (
    <Modal title="Сводка в Excel или CSV" onClose={onClose}>
      <div className="form">
        <div className="tabs small" role="tablist">
          {(
            [
              ["month", "Месяц"],
              ["quarter", "Квартал"],
              ["year", "Год"],
              ["custom", "Свой период"],
            ] as [Kind, string][]
          ).map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? "tab active" : "tab"} onClick={() => choose(k)}>
              {label}
            </button>
          ))}
        </div>
        <div className="row">
          <Field label="С">{(id) => <input id={id} name="summaryFrom" type="date" value={from} onChange={(e) => (setKind("custom"), setRange([e.target.value, to]))} />}</Field>
          <Field label="По">{(id) => <input id={id} name="summaryTo" type="date" value={to} onChange={(e) => (setKind("custom"), setRange([from, e.target.value]))} />}</Field>
        </div>
        <p className="hint">Листы: Сводка, По категориям, Бюджет, По месяцам, Долги, Операции. В Excel суммы записываются числами: работают формулы и сводные таблицы. В CSV все листы идут друг за другом в одном файле.</p>
        {done && (
          <p className="ok" data-testid="export-done">
            Сохранено: {baseName(done)}
          </p>
        )}
        <ErrorText error={run.error} />
        <div className="actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Закрыть
          </button>
          <button type="button" className="btn" disabled={run.busy || !from || !to} onClick={() => run.run("csv")}>
            Скачать в CSV
          </button>
          <button type="button" className="btn primary" aria-busy={run.busy} data-done={run.done || undefined} disabled={run.busy || !from || !to} onClick={() => run.run("xlsx")}>
            Скачать в Excel
          </button>
        </div>
      </div>
    </Modal>
  );
}

const IMPORT_ROW_FILTERS = [
  { value: "all", label: "Все строки" },
  { value: "error", label: "С ошибками" },
  { value: "review", label: "Возможные совпадения" },
  { value: "duplicate", label: "Пропускаемые повторы" },
  { value: "link", label: "Связь с вашей записью" },
  { value: "conversion", label: "Станут переводами" },
  { value: "add", label: "Новые без совпадений" },
] as const;

type ImportRowFilter = (typeof IMPORT_ROW_FILTERS)[number]["value"];

function importRowFilter(row: ImportRow): Exclude<ImportRowFilter, "all"> {
  if (row.error) return "error";
  if (row.toTransfer) return "conversion";
  if (row.duplicate) return "duplicate";
  if (row.linkedTo) return "link";
  if (row.maybe > 0) return "review";
  return "add";
}

function bankDecisionValue(decision?: BankImportDecision): string {
  return decision?.action === "link" ? `link:${decision.transactionId}` : decision?.action ?? "";
}

/** Импорт: выписка Сбера или Т-Банка либо CSV по шаблону → предпросмотр с ошибками и повторами → загрузка. */
export function ImportDialog({ onClose, initialPath, saveGuard: suppliedSaveGuard }: {
  onClose: () => void;
  initialPath?: string;
  saveGuard?: ImportSaveGuard;
}) {
  const [path, setPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [activeMapping, setActiveMapping] = useState<CsvMapping | null>(null);
  const [mapperOpen, setMapperOpen] = useState(false);
  const [csvDecisions, setCsvDecisions] = useState<Record<number, boolean>>({});
  const [bankDecisions, setBankDecisions] = useState<Record<number, BankImportDecision>>({});
  const [rowFilter, setRowFilter] = useState<ImportRowFilter>("all");
  const rowsByFilter = useMemo(() => {
    const groups: Record<ImportRowFilter, ImportRow[]> = {
      all: preview?.rows ?? [],
      error: [],
      review: [],
      duplicate: [],
      link: [],
      conversion: [],
      add: [],
    };
    for (const row of groups.all) groups[importRowFilter(row)].push(row);
    return groups;
  }, [preview]);
  const csvUnresolved = activeMapping
    ? rowsByFilter.review.filter((row) => csvDecisions[row.line] === undefined).length
    : 0;
  const csvSkipped = activeMapping
    ? rowsByFilter.review.filter((row) => csvDecisions[row.line] === false).length
    : 0;
  const bankReview = preview?.bank ? rowsByFilter.review : [];
  const chosen = bankReview.flatMap(({ line }) => bankDecisions[line] ? [bankDecisions[line]] : []);
  const unresolved = csvUnresolved + bankReview.length - chosen.length;
  const bankAdds = chosen.filter((decision) => decision.action === "add").length;
  const skipped = csvSkipped + chosen.filter((decision) => decision.action === "skip").length;
  const toLoad = preview ? preview.valid - csvSkipped - bankReview.length + bankAdds : 0;
  const toLink = (preview?.linked ?? 0) + chosen.filter((decision) => decision.action === "link").length;
  const actionable = toLoad + (preview?.toTransfers ?? 0) + toLink;
  let saveLabel = `Загрузить ${toLoad}`;
  if (preview && toLoad === 0) {
    if (preview.toTransfers > 0) saveLabel = `Исправить ${preview.toTransfers}`;
    else if (toLink > 0) saveLabel = `Связать ${toLink}`;
  }
  const [accountId, setAccountId] = useState<string | null>(null);
  // Второй счёт для переводов себе: null — запомненный, "" — «не перевод».
  const [selfId, setSelfId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<ImportSaved | null>(null);
  const [loadedAccount, setLoadedAccount] = useState<string | null>(null);
  const [next, setNext] = useState<"history" | "matches" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const accounts = (useAccounts().data ?? []).filter((a) => !a.archived);
  const qc = useQueryClient();

  // Предпросмотр, по которому идёт загрузка: пока новый не пришёл, кнопки
  // загрузки выключены, а ответ на устаревший запрос не показывается.
  const [pending, setPending] = useState(false);
  const request = useRef(0);
  const [localSaveGuard] = useState(() => new ImportSaveGuard());
  const saveGuard = suppliedSaveGuard ?? localSaveGuard;
  const dismiss = () => {
    if (!saveGuard.busy) onClose();
  };
  const [saving, setSaving] = useState(false);
  const load = async (
    p: string,
    account: string | null = accountId,
    self: string | null = selfId,
    mapping: CsvMapping | null = null,
  ) => {
    if (saveGuard.busy) return;
    const n = ++request.current;
    setError(null);
    setLoaded(null);
    setCsvDecisions({});
    setBankDecisions({});
    setLoadedAccount(null);
    setPending(true);
    setPath(p);
    try {
      const r = await api.importPreview(p, account, self, mapping);
      if (n !== request.current) return;
      setPreview(r);
      setRowFilter("all");
      setSelfId(self);
      setAccountId(r.accountId);
      setActiveMapping(mapping);
      if (mapping) setMapperOpen(false);
    } catch (e) {
      if (n !== request.current) return;
      setPreview(null);
      setError(String(e));
    } finally {
      if (n === request.current) setPending(false);
    }
  };
  const loadNew = (p: string) => {
    setMapperOpen(false);
    setActiveMapping(null);
    setAccountId(null);
    setSelfId(null);
    return load(p, null, null);
  };
  // Файл, брошенный в окно: сразу предпросмотр.
  useEffect(() => {
    if (initialPath) void loadNew(initialPath);
  }, [initialPath]);
  const choose = async () => {
    const p = await pickOpen([STATEMENT, CSV]);
    if (p) await loadNew(p);
  };
  const template = async () => {
    setSaved(null);
    const p = await pickSave("Kazna — шаблон импорта.csv", [CSV]);
    if (!p) return;
    try {
      await api.writeImportTemplate(p);
      setSaved(`Шаблон сохранён: ${baseName(p)}`);
    } catch (e) {
      setError(String(e));
    }
  };
  const commit = async (skipErrors: boolean) => {
    if (pending || mapperOpen || unresolved || !preview || !path) return;
    await saveGuard.run(async () => {
    setSaving(true);
    setError(null);
    try {
      setLoaded(await api.importCsv(
        path, preview.fileDigest, skipErrors,
        preview.bank || activeMapping ? accountId : null,
        preview.bank ? selfId : null,
        activeMapping ? { ...activeMapping, decisions: csvDecisions } : null,
        preview.bank ? bankDecisions : undefined,
      ));
      setLoadedAccount(preview.bank || activeMapping ? accountId : null);
      setPreview(null);
      await qc.invalidateQueries();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
    });
  };

  if (next === "history") return <ImportHistoryDialog onClose={onClose} />;
  if (next === "matches") return <MatchesDialog onClose={onClose} />;
  return (
    <Modal title="Импорт выписки или CSV" onClose={dismiss} dismissDisabled={saving} wide>
      <section className="import-overview-source" aria-labelledby="import-source-title">
        <div className="import-overview-intro">
          <h2 id="import-source-title">Файл для загрузки</h2>
          <p className="muted">Сбер — PDF, Т-Банк — CSV или Excel. Для других CSV можно сопоставить столбцы.</p>
        </div>
        <div className="import-overview-controls">
          <button type="button" className="btn primary import-overview-pick" disabled={saving} onClick={choose}>
            <DecorativeIcon icon={FileUp} size="control" />
            Выбрать файл
          </button>
          {path && !mapperOpen && (
            <button type="button" className="btn" disabled={pending || saving} onClick={() => load(path, accountId, selfId, activeMapping)} title="Перечитать файл после исправлений">
              Проверить снова
            </button>
          )}
          {path && /\.csv$/i.test(path) && !preview?.bank && !mapperOpen && (
            <button type="button" className="btn" disabled={pending || saving} onClick={() => {
              setError(null);
              setMapperOpen(true);
            }}>Настроить столбцы CSV</button>
          )}
          <button type="button" className="link" disabled={saving} onClick={template}>Скачать шаблон CSV</button>
          <button type="button" className="link" disabled={saving} data-testid="open-import-history" onClick={() => {
            if (!saveGuard.busy) setNext("history");
          }}>История импорта</button>
        </div>
        <details className="import-overview-help">
          <summary>Как Kazna разбирает файл</summary>
          <p className="muted">
            Можно использовать таблицу CSV или Excel, в том числе выгрузку из «Операций».
            Kazna подбирает категории по правилам и данным банка, а новые помечает «(новая)».
            Повторы пропускаются, возвраты отмечаются отдельно. Найденные ручные операции связываются со строками выписки.
          </p>
        </details>
        {pending && <p className="muted import-overview-progress" role="status">Проверяем файл…</p>}
      </section>
      {path && mapperOpen && (
        <CsvProfileEditor
          key={path}
          path={path}
          accounts={accounts}
          initial={activeMapping && accountId ? { mapping: activeMapping, accountId } : null}
          pending={pending}
          onPreview={({ mapping, accountId }) => { void load(path, accountId, null, mapping); }}
          onClose={() => { setMapperOpen(false); setError(null); }}
        />
      )}
      {preview?.bank && (
        <fieldset className="row import-bank" disabled={saving} style={{ border: 0, padding: 0, margin: 0 }}>
          <span className="bank-chip" data-testid="import-bank">
            Выписка {preview.bank}
          </span>
          <Field label="На какой счёт" hint="Запомним для следующих выписок этого банка. Карта, чьи цифры есть в названии счёта, попадёт на свой счёт.">
            {(id) => <AccountSelect id={id} name="importAccount" accounts={accounts} value={accountId ?? ""} onChange={(v) => load(path!, v || null)} />}
          </Field>
          {preview.selfTransfers > 0 && (
            <Field label={`Переводы своих денег (${preview.selfTransfers}) — второй счёт`} hint="«Между своими счетами», копилка, пополнение из другого банка: строки, которые банк не считает тратами и доходами («Учёт в аналитике: Нет»). Выберите, куда уходят и откуда приходят эти деньги, и они запишутся переводами, а траты и доходы совпадут с банком. Уже загруженные раньше такие строки тоже станут переводами. Если вторая сторона есть в этой же выписке, перевод найдётся сам. Запомним для следующих выписок.">
              {(id) => <AccountSelect id={id} name="importSelfAccount" placeholder="Не знаю — записать расходом и доходом" accounts={accounts} exclude={accountId ?? undefined} value={preview.selfAccountId ?? ""} onChange={(v) => load(path!, accountId, v)} />}
            </Field>
          )}
        </fieldset>
      )}
      {preview && !mapperOpen && (
        <section className="import-overview-preview" aria-labelledby="import-preview-title">
          <div className="import-overview-heading">
            <h2 id="import-preview-title">Проверка перед загрузкой</h2>
            <p data-testid="import-summary" className={preview.errors ? "warn" : "muted"}>
              {baseName(path!)}: строк {preview.rows.length}, без ошибок {preview.valid}
              {preview.errors > 0 && `, с ошибками ${preview.errors}`}
              {preview.duplicates > 0 && `, уже загружено раньше ${preview.duplicates}`}
              {preview.toTransfers > 0 && `, станут переводами ${preview.toTransfers}`}
              {toLink > 0 && `, свяжутся с вашими записями ${toLink}`}
              {preview.doubtful > 0 && (activeMapping
                ? `, похожие строки ${preview.doubtful}`
                : `, возможные совпадения ${preview.doubtful}`)}
              {skipped > 0 && `, выбрано пропустить ${skipped}`}
            </p>
          </div>
          {preview.rows.length > 0 && (
            <div className="row import-overview-filter">
              <Field label="Показать строки" hint="Фильтр меняет только вид таблицы. При загрузке учитывается весь файл.">
                {(id) => (
                  <select id={id} name="importRowFilter" value={rowFilter} disabled={pending || saving}
                    onChange={(e) => setRowFilter(e.target.value as ImportRowFilter)}>
                    {IMPORT_ROW_FILTERS.filter(({ value }) => value === "all" || rowsByFilter[value].length > 0)
                      .map(({ value, label }) => <option key={value} value={value}>{label} ({rowsByFilter[value].length})</option>)}
                  </select>
                )}
              </Field>
            </div>
          )}
          <div className="import-table" role="region" aria-label="Строки файла" tabIndex={0}>
            <table className="table" data-testid="import-preview">
              <thead>
                <tr>
                  <th>Строка</th>
                  <th>Дата</th>
                  <th>Тип</th>
                  <th>Счёт</th>
                  <th>Категория</th>
                  {(preview.bank || activeMapping) && <th>{activeMapping ? "Получатель и комментарий" : "Получатель"}</th>}
                  <th>Сумма</th>
                  <th>Проверка</th>
                </tr>
              </thead>
              <tbody>
                {rowsByFilter[rowFilter].map((r) => (
                  <tr key={r.line} className={r.error ? "bad" : r.duplicate || r.linkedTo || r.toTransfer ? "dup" : undefined} data-testid="import-row" data-error={r.error ? "1" : "0"} data-duplicate={r.duplicate ? "1" : "0"} data-linked={r.linkedTo ? "1" : "0"}>
                    <td>{r.line}</td>
                    <td>{/^\d{4}-\d{2}-\d{2}$/.test(r.date) ? formatDate(r.date) : r.date}</td>
                    <td>{r.type}</td>
                    <td>{r.account}</td>
                    <td>
                      {r.category}
                      {r.categorySource && <div className="hint" data-testid="import-category-source">{r.categorySource}</div>}
                    </td>
                    {(preview.bank || activeMapping) && (
                      <td className="import-payee">
                        {r.payee}
                        {r.sourceNote && <div className="muted">{r.sourceNote}</div>}
                      </td>
                    )}
                    <td className="num">{r.amount}</td>
                    <td className={r.error ? "error" : "muted"}>
                      {activeMapping && r.duplicate
                        ? "Эта строка из того же файла уже была загружена."
                        : activeMapping && r.maybe > 0
                          ? "Похожа на запись в Kazna."
                          : importRowExplanation(r, Boolean(preview.bank))}
                      {preview.matches?.[r.line]?.length ? (
                        <details data-testid="import-preview-matches">
                          <summary>Сравнить с учётом</summary>
                          <p className="hint">{activeMapping
                            ? "Совпали счёт, дата и сумма."
                            : "Совпали счёт и сумма операции или её стороны. Даты могут отличаться."}</p>
                          {preview.matches[r.line].map((s, i) => (
                            <StatementMatchSide key={s.id} s={s} label={r.linkedTo ? "Запись в Kazna" : `Вариант ${i + 1}`} />
                          ))}
                          {!activeMapping && r.maybe > preview.matches[r.line].length &&
                            <p className="hint">Показаны ближайшие варианты. Если нужной записи нет, пропустите строку в этой загрузке.</p>}
                        </details>
                      ) : null}
                      {preview.bank && r.maybe > 0 && (
                        <select
                          aria-label={`Что сделать со строкой ${r.line}`}
                          disabled={pending || saving}
                          data-testid="bank-similar-decision"
                          value={bankDecisionValue(bankDecisions[r.line])}
                          onChange={(e) => {
                            const value = e.target.value;
                            setBankDecisions((old) => {
                              const next = { ...old };
                              if (!value) delete next[r.line];
                              else if (value === "add" || value === "skip") next[r.line] = { action: value };
                              else next[r.line] = { action: "link", transactionId: value.slice(5) };
                              return next;
                            });
                          }}
                        >
                          <option value="">Выберите действие</option>
                          {(preview.matches?.[r.line] ?? []).map((s, index) => (
                            <option key={s.id} value={`link:${s.id}`}>
                              {`Связать с вариантом ${index + 1} · ${formatDate(s.date)} · ${s.payee ?? s.category ?? s.account}`}
                            </option>
                          ))}
                          <option value="add">Добавить отдельно</option>
                          <option value="skip">Пропустить в этой загрузке</option>
                        </select>
                      )}
                      {activeMapping && r.maybe > 0 && (
                        <select
                          aria-label={`Что сделать со строкой ${r.line}`}
                          disabled={pending || saving}
                          data-testid="csv-similar-decision"
                          value={csvDecisions[r.line] === undefined ? "" : csvDecisions[r.line] ? "add" : "skip"}
                          onChange={(e) => {
                            const value = e.target.value;
                            setCsvDecisions((old) => {
                              const next = { ...old };
                              if (!value) delete next[r.line];
                              else next[r.line] = value === "add";
                              return next;
                            });
                          }}
                        >
                          <option value="">Выберите действие</option>
                          <option value="add">Добавить отдельно</option>
                          <option value="skip">Пропустить в этой загрузке</option>
                        </select>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {saved && (
        <p className="ok" data-testid="template-saved">
          {saved}
        </p>
      )}
      {loaded !== null && (
        <div className="ok" data-testid="import-done">
          Загружено операций: {loaded.added}
          {loaded.converted > 0 && `, стали переводами: ${loaded.converted}`}
          {loaded.linked > 0 && `, связано с вашими записями: ${loaded.linked}`}
          {loaded.suggested > 0 && (
            <>
              {`. Совпадений на проверку: ${loaded.suggested}. `}
              <button className="link" data-testid="open-matches" onClick={() => setNext("matches")}>
                Разобрать
              </button>
            </>
          )}
          {loadedAccount && accounts.some((account) => account.id === loadedAccount && account.type !== "investment") && (
            <div><button type="button" className="link" data-testid="import-reconcile" disabled={saving} onClick={() => {
              onClose();
              useUi.getState().openReconciliation(loadedAccount);
            }}>Сверить остаток по выписке</button></div>
          )}
        </div>
      )}
      {saving && <p className="muted" role="status">Сохраняем операции…</p>}
      <ErrorText error={error} />
      {unresolved > 0 && <p className="warn" role="status">Выберите действие для похожих строк. Осталось: {unresolved}.</p>}
      <div className="actions import-overview-actions">
        {preview && !mapperOpen && preview.errors > 0 && actionable > 0 && (
          <button className="link" disabled={pending || saving || unresolved > 0} onClick={() => commit(true)}>
            Загрузить только правильные ({actionable})
          </button>
        )}
        <span className="spacer" />
        <button className="btn" disabled={saving} onClick={dismiss}>
          Закрыть
        </button>
        {preview && !mapperOpen && (
          <button className="btn primary" disabled={pending || saving || unresolved > 0 || preview.errors > 0 || actionable === 0} onClick={() => commit(false)} title={preview.errors ? "Сначала исправьте строки с ошибками" : undefined}>
            {saveLabel}
            {toLoad > 0 && preview.toTransfers > 0 && ` и исправить ${preview.toTransfers}`}
          </button>
        )}
      </div>
    </Modal>
  );
}

/** Окно «Доступна версия …». */
function UpdateModal({ info, onClose }: { info: UpdateInfo; onClose: () => void }) {
  const install = useAction(() => api.installUpdate());
  return (
    <Modal title="Доступно обновление" onClose={onClose}>
      <p data-testid="update-version">
        Доступна версия {info.version} (у вас {info.current}).
      </p>
      {info.notes && <div className="update-notes">{info.notes}</div>}
      <p className="hint">Перед обновлением приложение сделает копию данных. После установки оно перезапустится, все данные останутся на месте.</p>
      <ErrorText error={install.error} />
      <div className="actions">
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          Позже
        </button>
        <button className="btn primary" onClick={() => install.run()} disabled={install.busy}>
          {install.busy ? "Обновляю…" : "Обновить"}
        </button>
      </div>
    </Modal>
  );
}

/** Проверка обновлений при запуске (если включена в настройках). */
export function UpdatePrompt() {
  const settings = useSettings().data;
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const portable = useQuery({ queryKey: ["appInfo"], queryFn: api.appInfo }).data?.portable;
  const enabled = settings?.update_check !== "0" && portable === false;
  useEffect(() => {
    if (!settings || !enabled) return;
    // Без интернета проверка просто не удаётся — приложение работает дальше.
    api.checkUpdate().then((i) => i.version && setInfo(i), () => {});
    // Проверяем один раз при запуске.
  }, [!!settings, enabled]);
  return info ? <UpdateModal info={info} onClose={() => setInfo(null)} /> : null;
}

/** Блок «Обновления» в настройках. */
export function UpdatesCard() {
  const settings = useSettings().data;
  const setSetting = useAction(api.setSetting);
  const [result, setResult] = useState<string | null>(null);
  const [found, setFound] = useState<UpdateInfo | null>(null);
  const [news, setNews] = useState<string | null>(null);
  const check = useAction(async () => {
    setResult(null);
    const i = await api.checkUpdate();
    if (!i.configured) setResult("Адрес обновлений появится с первой опубликованной версией.");
    else if (i.version) setFound(i);
    else setResult(`У вас последняя версия (${i.current}).`);
  });
  return (
    <div className="card" data-testid="updates-card">
      <h2>
        Обновления
        <Hint of="updates" />
      </h2>
      <div className="btn-group">
        <button className="btn" onClick={() => check.run()} disabled={check.busy}>
          Проверить обновления
        </button>
        <button className="link" onClick={() => api.changelog().then(setNews, (e) => setResult(String(e)))}>
          Что нового
        </button>
        <select name="updateCheck" aria-label="Проверять при запуске" value={settings?.update_check ?? "1"} onChange={(e) => setSetting.run("update_check", e.target.value)}>
          <option value="1">Проверять при запуске</option>
          <option value="0">Только по кнопке</option>
        </select>
      </div>
      {result && (
        <p className="muted" data-testid="update-result">
          {result}
        </p>
      )}
      <ErrorText error={check.error ?? setSetting.error} />
      {found && <UpdateModal info={found} onClose={() => setFound(null)} />}
      {news && (
        <Modal title="Что нового" onClose={() => setNews(null)} wide>
          <div className="update-notes">{news.replace(/^# .*\n+/, "")}</div>
        </Modal>
      )}
    </div>
  );
}

export type ExportFormat = "csv" | "xlsx" | "ofx";
export const FORMATS: Record<ExportFormat, { label: string; filter: typeof XLSX }> = {
  csv: { label: "Скачать в CSV", filter: CSV },
  xlsx: { label: "Скачать в Excel", filter: XLSX },
  ofx: { label: "Скачать в OFX", filter: OFX },
};

/** Выгрузка списка или отчёта: формат выбирается в меню кнопки, затем — куда сохранить. */
export function useExport(name: string, run: (path: string) => Promise<void>, formats: ExportFormat[] = ["csv", "xlsx"]) {
  const [done, setDone] = useState<string | null>(null);
  const action = useAction(async (format: ExportFormat) => {
    const path = await pickSave(`${name}.${format}`, [FORMATS[format].filter]);
    if (!path) return;
    await run(path);
    setDone(baseName(path));
  });
  return { run: (format: ExportFormat) => action.run(format), formats, done, error: action.error, busy: action.busy };
}

/** Кнопка «Выгрузить» с меню форматов: «Скачать в CSV», «Скачать в Excel», «Скачать в OFX». */
export function ExportButton({ exp, disabled, title }: { exp: ReturnType<typeof useExport>; disabled?: boolean; title?: string }) {
  return <FormatMenu label="Выгрузить" formats={exp.formats} onPick={exp.run} busy={exp.busy} done={!!exp.done} disabled={disabled} title={title} />;
}

/** Кнопка с меню форматов файла; выбор пункта вызывает `onPick`. */
export function FormatMenu({ label, formats, onPick, busy, done, disabled, title, className = "btn" }: { label: string; formats: ExportFormat[]; onPick: (f: ExportFormat) => void; busy?: boolean; done?: boolean; disabled?: boolean; title?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc, true);
    };
  }, [open]);
  return (
    <div className="export-menu" ref={ref}>
      <button type="button" className={className} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} aria-busy={busy} data-done={done || undefined} disabled={disabled || busy} title={title}>
        {label}
      </button>
      {open && (
        <div className="export-pop" role="menu" data-testid="export-menu">
          {formats.map((f) => (
            <button
              key={f}
              type="button"
              role="menuitem"
              data-format={f}
              onClick={() => {
                setOpen(false);
                onPick(f);
              }}
            >
              {FORMATS[f].label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
