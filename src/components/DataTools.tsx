import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, type BackupInfo, type ImportPreview, type UpdateInfo } from "../lib/api";
import { formatDate, monthBounds, today } from "../lib/dates";
import { baseName, CSV, DB, pickFolder, pickOpen, pickSave, STATEMENT, XLSX } from "../lib/files";
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
  const run = useAction(async () => {
    const path = await pickSave(`P-Treasury — сводка ${from} — ${to}.xlsx`, [XLSX]);
    if (!path) return;
    await api.exportSummary(from, to, path);
    setDone(path);
  });
  const choose = (k: Kind) => {
    setKind(k);
    if (k !== "custom") setRange(periodOf(k, today()));
  };
  return (
    <Modal title="Сводка в Excel" onClose={onClose}>
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
        <p className="hint">Листы: Сводка, По категориям, Бюджет, По месяцам, Долги, Операции. Суммы записываются числами: работают формулы и сводные таблицы.</p>
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
          <button type="button" className="btn primary" aria-busy={run.busy} data-done={run.done || undefined} disabled={run.busy || !from || !to} onClick={() => run.run()}>
            Скачать
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Импорт: выписка Сбера или Т-Банка либо CSV по шаблону → предпросмотр с ошибками и повторами → загрузка. */
export function ImportDialog({ onClose }: { onClose: () => void }) {
  const [path, setPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const accounts = (useAccounts().data ?? []).filter((a) => !a.archived);
  const qc = useQueryClient();

  const load = async (p: string, account: string | null = accountId) => {
    setError(null);
    setLoaded(null);
    try {
      const r = await api.importPreview(p, account);
      setPreview(r);
      setAccountId(r.accountId);
      setPath(p);
    } catch (e) {
      setPreview(null);
      setError(String(e));
    }
  };
  const choose = async () => {
    const p = await pickOpen([STATEMENT, CSV]);
    if (p) await load(p, null);
  };
  const template = async () => {
    const p = await pickSave("P-Treasury — шаблон импорта.csv", [CSV]);
    if (p) await api.writeImportTemplate(p).catch((e) => setError(String(e)));
  };
  const commit = async (skipErrors: boolean) => {
    try {
      setLoaded(await api.importCsv(path!, skipErrors, preview?.bank ? accountId : null));
      setPreview(null);
      await qc.invalidateQueries();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <Modal title="Импорт выписки или CSV" onClose={onClose} wide>
      <p className="muted">
        Выписка Сбера (PDF из СберБанк Онлайн), Т-Банка (CSV или Excel из личного кабинета) или CSV по шаблону приложения. Категории подберутся по правилам и по категориям банка, уже загруженные операции пропускаются.
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
      </div>
      {preview?.bank && (
        <div className="row import-bank">
          <span className="bank-chip" data-testid="import-bank">
            Выписка {preview.bank}
          </span>
          <Field label="На какой счёт" hint="Запомним для следующих выписок этого банка. Карта, чьи цифры есть в названии счёта, попадёт на свой счёт.">
            {(id) => <AccountSelect id={id} name="importAccount" accounts={accounts} value={accountId ?? ""} onChange={(v) => load(path!, v || null)} />}
          </Field>
        </div>
      )}
      {preview && (
        <>
          <p data-testid="import-summary" className={preview.errors ? "warn" : undefined}>
            {baseName(path!)}: строк {preview.rows.length}, без ошибок {preview.valid}
            {preview.errors > 0 && `, с ошибками ${preview.errors}`}
            {preview.duplicates > 0 && `, уже загружено раньше ${preview.duplicates}`}
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
                  <tr key={r.line} className={r.error ? "bad" : r.duplicate ? "dup" : undefined} data-testid="import-row" data-error={r.error ? "1" : "0"} data-duplicate={r.duplicate ? "1" : "0"}>
                    <td>{r.line}</td>
                    <td>{/^\d{4}-\d{2}-\d{2}$/.test(r.date) ? formatDate(r.date) : r.date}</td>
                    <td>{r.type}</td>
                    <td>{r.account}</td>
                    <td>{r.category}</td>
                    {preview.bank && <td className="import-payee">{r.payee}</td>}
                    <td className="num">{r.amount}</td>
                    <td className={r.error ? "error" : "muted"}>{r.error ?? (r.duplicate ? "уже есть, пропустим" : "ок")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {loaded !== null && (
        <p className="ok" data-testid="import-done">
          Загружено операций: {loaded}
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

function when(iso: string | null) {
  return iso ? `${formatDate(iso.slice(0, 10))} ${iso.slice(11, 16)}` : "ещё не было";
}

/** Резервные копии: ручная копия, восстановление, автокопия в папку. */
export function BackupCard() {
  const status = useQuery({ queryKey: ["backupStatus"], queryFn: api.backupStatus });
  const setSetting = useAction(api.setSetting);
  const [msg, setMsg] = useState<string | null>(null);
  const [restore, setRestore] = useState<BackupInfo | null>(null);
  const s = status.data;

  const backup = useAction(async () => {
    const path = await pickSave(s?.defaultName ?? "p-treasury.db", [DB]);
    if (!path) return;
    await api.backupNow(path);
    setMsg(`Копия сохранена: ${baseName(path)}`);
  });
  const chooseRestore = useAction(async () => {
    const path = await pickOpen([DB]);
    if (path) setRestore(await api.inspectBackup(path));
  });
  const doRestore = useAction(async () => {
    await api.restoreBackup(restore!.path);
    setRestore(null);
    setMsg("Данные восстановлены из копии. Прежние данные сохранены в папке программы (backups).");
  });
  const folder = useAction(async () => {
    const dir = await pickFolder();
    if (dir) await api.setSetting("autobackup_dir", dir);
  });

  return (
    <div className="card" data-testid="backup-card">
      <h2>
        Резервные копии
        <Hint of="backups" />
      </h2>
      {s?.reminderDue && <p className="warn">Резервной копии давно не было. Сделайте копию или включите автокопию.</p>}
      <dl className="facts">
        <dt>Последняя копия</dt>
        <dd data-testid="last-backup">{when(s?.lastBackupAt ?? null)}</dd>
        <dt>Автокопия при закрытии</dt>
        <dd data-testid="autobackup-dir">{s?.autobackupDir ? <span className="mono">{s.autobackupDir}</span> : "выключена"}</dd>
      </dl>
      <div className="btn-group">
        <button className="btn primary" onClick={() => backup.run()}>
          Сделать копию
        </button>
        <button className="btn" onClick={() => chooseRestore.run()}>
          Восстановить из копии
        </button>
        <button className="btn" onClick={() => folder.run()}>
          {s?.autobackupDir ? "Сменить папку автокопий" : "Включить автокопию"}
        </button>
        {s?.autobackupDir && (
          <>
            <select name="autobackupKeep" aria-label="Сколько копий хранить" value={s.autobackupKeep} onChange={(e) => setSetting.run("autobackup_keep", e.target.value)}>
              {[3, 5, 10, 20, 30].map((n) => (
                <option key={n} value={String(n)}>
                  хранить {n}
                </option>
              ))}
            </select>
            <button className="link" onClick={() => setSetting.run("autobackup_dir", "")}>
              Выключить
            </button>
          </>
        )}
      </div>
      <p className="hint">Автокопия делается при выходе из приложения. Папку можно выбрать на Яндекс.Диске: копии сами попадут в облако.</p>
      {msg && (
        <p className="ok" data-testid="backup-msg">
          {msg}
        </p>
      )}
      <ErrorText error={backup.error ?? chooseRestore.error ?? folder.error ?? setSetting.error} />
      {restore && (
        <Modal title="Восстановить из копии?" onClose={() => setRestore(null)}>
          <p>
            В копии: счетов {restore.accounts}, операций {restore.transactions}
            {restore.lastDate && `, последняя операция ${formatDate(restore.lastDate)}`}.
          </p>
          <p className="muted">Текущие данные заменятся данными из копии. Перед этим они сохранятся отдельной копией в папке программы.</p>
          <ErrorText error={doRestore.error} />
          <div className="actions">
            <span className="spacer" />
            <button className="btn" onClick={() => setRestore(null)}>
              Отмена
            </button>
            <button className="btn primary" onClick={() => doRestore.run()} disabled={doRestore.busy}>
              Восстановить
            </button>
          </div>
        </Modal>
      )}
    </div>
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
        <button className="link" onClick={() => api.changelog().then(setNews)}>
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

/** Выгрузка списка или отчёта: выбрать файл .xlsx или .csv и сохранить. */
export function useExport(name: string, run: (path: string) => Promise<void>) {
  const [done, setDone] = useState<string | null>(null);
  const action = useAction(async () => {
    const path = await pickSave(`${name}.xlsx`, [XLSX, CSV]);
    if (!path) return;
    await run(path);
    setDone(baseName(path));
  });
  return { run: () => action.run(), done, error: action.error, busy: action.busy };
}
