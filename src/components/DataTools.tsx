import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, type ImportPreview, type ImportSaved, type UpdateInfo } from "../lib/api";
import { ImportHistoryDialog, MatchesDialog } from "./ImportHistory";
import { formatDate, monthBounds, today } from "../lib/dates";
import { baseName, CSV, OFX, pickOpen, pickSave, STATEMENT, XLSX } from "../lib/files";
import { useAccounts, useSettings } from "../lib/queries";
import { useAction } from "../lib/useAction";
import { AccountSelect, Field } from "./Fields";
import { ErrorText, Modal } from "./Modal";
import { Hint } from "./Hint";

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

/** Импорт: выписка Сбера или Т-Банка либо CSV по шаблону → предпросмотр с ошибками и повторами → загрузка. */
export function ImportDialog({ onClose, initialPath }: { onClose: () => void; initialPath?: string }) {
  const [path, setPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  // Второй счёт для переводов себе: null — запомненный, "" — «не перевод».
  const [selfId, setSelfId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<ImportSaved | null>(null);
  const [next, setNext] = useState<"history" | "matches" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const accounts = (useAccounts().data ?? []).filter((a) => !a.archived);
  const qc = useQueryClient();

  const load = async (p: string, account: string | null = accountId, self: string | null = selfId) => {
    setError(null);
    setLoaded(null);
    setSelfId(self);
    try {
      const r = await api.importPreview(p, account, self);
      setPreview(r);
      setAccountId(r.accountId);
      setPath(p);
    } catch (e) {
      setPreview(null);
      setError(String(e));
    }
  };
  // Файл, брошенный в окно: сразу предпросмотр.
  useEffect(() => {
    if (initialPath) void load(initialPath, null, null);
  }, [initialPath]);
  const choose = async () => {
    const p = await pickOpen([STATEMENT, CSV]);
    if (p) await load(p, null, null);
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
    try {
      setLoaded(await api.importCsv(path!, skipErrors, preview?.bank ? accountId : null, preview?.bank ? selfId : null));
      setPreview(null);
      await qc.invalidateQueries();
    } catch (e) {
      setError(String(e));
    }
  };

  if (next === "history") return <ImportHistoryDialog onClose={onClose} />;
  if (next === "matches") return <MatchesDialog onClose={onClose} />;
  return (
    <Modal title="Импорт выписки или CSV" onClose={onClose} wide>
      <p className="muted">
        Выписка Сбера (PDF из СберБанк Онлайн), Т-Банка (CSV или Excel из личного кабинета, в том числе «Operations …») или таблица по шаблону приложения (CSV или Excel, подойдёт и выгрузка «Операций»). Категории подберутся по правилам и по категориям банка. Если в файле есть категория, которой нет в программе, возьмётся похожая, а если похожей нет, создастся новая: в таблице ниже она помечена «(новая)», поправить можно потом в «Категориях». Возврат покупки (деньги от того же магазина после покупки) записывается возвратом, а не доходом. Уже загруженные операции пропускаются, а покупки, которые вы уже записали вручную, свяжутся с вашими записями.
      </p>
      <div className="btn-group">
        <button className="btn primary" onClick={choose}>
          Выбрать файл
        </button>
        {path && (
          <button className="btn" onClick={() => load(path)} title="Перечитать файл после исправлений">
            Проверить снова
          </button>
        )}
        <button className="link" onClick={template}>
          Скачать шаблон CSV
        </button>
        <button className="link" data-testid="open-import-history" onClick={() => setNext("history")}>
          История импорта
        </button>
      </div>
      {preview?.bank && (
        <div className="row import-bank">
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
        </div>
      )}
      {preview && (
        <>
          <p data-testid="import-summary" className={preview.errors ? "warn" : undefined}>
            {baseName(path!)}: строк {preview.rows.length}, без ошибок {preview.valid}
            {preview.errors > 0 && `, с ошибками ${preview.errors}`}
            {preview.duplicates > 0 && `, уже загружено раньше ${preview.duplicates}`}
            {preview.toTransfers > 0 && `, станут переводами ${preview.toTransfers}`}
            {preview.linked > 0 && `, свяжутся с вашими записями ${preview.linked}`}
            {preview.doubtful > 0 && `, спросим про совпадения ${preview.doubtful}`}
          </p>
          <div className="import-table">
            <table className="table" data-testid="import-preview">
              <thead>
                <tr>
                  <th>Строка</th>
                  <th>Дата</th>
                  <th>Тип</th>
                  <th>Счёт</th>
                  <th>Категория</th>
                  {preview.bank && <th>Получатель</th>}
                  <th>Сумма</th>
                  <th>Проверка</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.line} className={r.error ? "bad" : r.duplicate || r.linkedTo || r.toTransfer ? "dup" : undefined} data-testid="import-row" data-error={r.error ? "1" : "0"} data-duplicate={r.duplicate ? "1" : "0"} data-linked={r.linkedTo ? "1" : "0"}>
                    <td>{r.line}</td>
                    <td>{/^\d{4}-\d{2}-\d{2}$/.test(r.date) ? formatDate(r.date) : r.date}</td>
                    <td>{r.type}</td>
                    <td>{r.account}</td>
                    <td>{r.category}</td>
                    {preview.bank && <td className="import-payee">{r.payee}</td>}
                    <td className="num">{r.amount}</td>
                    <td className={r.error ? "error" : "muted"}>{r.error ?? (r.toTransfer ? "уже есть, станет переводом" : r.duplicate ? "уже есть, пропустим" : r.linkedTo ? `ваша запись ${r.linkedTo}` : r.maybe > 0 ? `похоже на ваши записи (${r.maybe}), спросим` : "ок")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {saved && (
        <p className="ok" data-testid="template-saved">
          {saved}
        </p>
      )}
      {loaded !== null && (
        <p className="ok" data-testid="import-done">
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
        </p>
      )}
      <ErrorText error={error} />
      <div className="actions">
        {preview && preview.errors > 0 && preview.valid > 0 && (
          <button className="link" onClick={() => commit(true)}>
            Загрузить только правильные ({preview.valid})
          </button>
        )}
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          Закрыть
        </button>
        {preview && (
          <button className="btn primary" disabled={preview.errors > 0 || preview.valid === 0} onClick={() => commit(false)} title={preview.errors ? "Сначала исправьте строки с ошибками" : undefined}>
            Загрузить {preview.valid}
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
