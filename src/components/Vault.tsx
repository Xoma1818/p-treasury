import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, type VaultFound } from "../lib/api";
import { formatDate } from "../lib/dates";
import { baseName, DB, pickFolder, pickOpen, pickSave, TRANSFER } from "../lib/files";
import { useAction } from "../lib/useAction";
import { Hint } from "./Hint";
import { ErrorText, Modal } from "./Modal";

/** Метка времени UTC (ISO) по местному времени: «21.10.2026 23:10». */
function localWhen(iso: string | null | undefined) {
  if (!iso) return "ещё не было";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${formatDate(date)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** «счетов 6, операций 1 240, последняя 21.10.2026». */
function contents(f: { accounts: number; transactions: number; lastDate: string | null }) {
  const n = (x: number) => x.toLocaleString("ru-RU");
  return `счетов ${n(f.accounts)}, операций ${n(f.transactions)}${f.lastDate ? `, последняя ${formatDate(f.lastDate)}` : ""}`;
}

/** Найденные данные одной строкой с кнопкой «Перенести». */
function FoundRow({ f, onPick }: { f: VaultFound; onPick: (f: VaultFound) => void }) {
  return (
    <li className="found-row" data-testid="found-row">
      <div>
        <b>{f.name}</b> <span className={f.kind === "excel" ? "kind-chip warn" : "kind-chip"}>{f.kind === "excel" ? "из Excel" : "копия"}</span>
        <div className="hint">
          {contents(f)}
          {f.savedAt && `; сохранено ${formatDate(f.savedAt.slice(0, 10))} ${f.savedAt.slice(11)}`}
        </div>
        <div className="hint mono">{f.path}</div>
      </div>
      <button className="btn primary" onClick={() => onPick(f)}>
        Перенести
      </button>
    </li>
  );
}

/**
 * Перенос данных с другого компьютера: программа сама ищет папку сохранности
 * (Документы, облака), её можно показать или выбрать файл копии.
 */
export function TransferDialog({ onClose, onDone, fresh }: { onClose: () => void; onDone?: (msg: string) => void; fresh?: boolean }) {
  const [found, setFound] = useState<VaultFound[] | null>(null);
  const [chosen, setChosen] = useState<VaultFound | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.vaultScan().then(setFound, (e) => setError(String(e)));
  }, []);
  const folder = async () => {
    setError(null);
    const dir = await pickFolder();
    if (!dir) return;
    const list = await api.vaultScan([dir]);
    if (list.length === 0) setError("В этой папке нет данных P-Treasury. Покажите папку P-Treasury или выберите файл копии.");
    else setFound(list);
  };
  const file = async () => {
    setError(null);
    const path = await pickOpen([TRANSFER]);
    if (!path) return;
    try {
      setChosen(await api.vaultInspect(path));
    } catch (e) {
      setError(String(e));
    }
  };
  const transfer = useAction(
    () => api.vaultTransfer(chosen!),
    () => {
      onDone?.(`Данные перенесены: ${contents(chosen!)}. Прежние данные этого компьютера сохранены в папке программы (backups).`);
      onClose();
    },
  );

  if (chosen) {
    return (
      <Modal title="Перенести эти данные?" onClose={() => setChosen(null)}>
        <p data-testid="transfer-summary">
          {chosen.name}: {contents(chosen)}.
        </p>
        {chosen.kind === "excel" && <p className="muted">Копии нет, данные загрузятся из Excel-файла «Все данные». Если в нём что-то правили руками, программа проверит связи и скажет, если что-то не сходится.</p>}
        {!fresh && <p className="muted">Текущие данные заменятся. Перед этим они сохранятся отдельной копией в папке программы.</p>}
        {chosen.folder && <p className="hint">Дальше копии будут сохраняться в ту же папку: {chosen.folder}</p>}
        <ErrorText error={transfer.error} />
        <div className="actions">
          <span className="spacer" />
          <button className="btn" onClick={() => setChosen(null)}>
            Назад
          </button>
          <button className="btn primary" onClick={() => transfer.run()} disabled={transfer.busy} aria-busy={transfer.busy}>
            Перенести
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Данные с другого компьютера" onClose={onClose} wide>
      <p className="muted">
        Скопируйте папку P-Treasury со старого компьютера в «Документы» (или войдите в облачный диск, если папка лежит там). Программа ищет её сама.
      </p>
      {found === null && !error && <p className="hint">Ищу…</p>}
      {found && found.length > 0 && (
        <ul className="found-list" data-testid="found-list">
          {found.map((f) => (
            <FoundRow key={f.path} f={f} onPick={setChosen} />
          ))}
        </ul>
      )}
      {found && found.length === 0 && (
        <p data-testid="found-none">В Документах и облачных папках данных P-Treasury не нашлось. Покажите папку или файл копии.</p>
      )}
      <ErrorText error={error} />
      <div className="actions">
        <button className="btn" onClick={() => folder()}>
          Показать папку…
        </button>
        <button className="btn" onClick={() => file()}>
          Выбрать файл…
        </button>
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </Modal>
  );
}

/** Выбор места папки: Документы, облака, своя папка (флешка). */
function PlaceDialog({ current, onClose }: { current: string; onClose: () => void }) {
  const places = useQuery({ queryKey: ["vaultPlaces"], queryFn: api.vaultPlaces }).data ?? [];
  const set = useAction((path: string | null) => api.setVaultDir(path), onClose, { celebrate: true });
  const other = async () => {
    const dir = await pickFolder();
    if (dir) set.run(dir);
  };
  return (
    <Modal title="Где хранить папку сохранности" onClose={onClose}>
      <ul className="place-list">
        {places.map((p, i) => (
          <li key={p.path}>
            <button className={p.path === current ? "place active" : "place"} onClick={() => set.run(i === 0 ? null : p.path)} data-testid="vault-place">
              <b>{p.label}</b>
              <span className="hint mono">{p.path}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="hint">В облаке копии переживут поломку компьютера. Прежняя папка останется на месте, её можно удалить вручную.</p>
      <ErrorText error={set.error} />
      <div className="actions">
        <button className="btn" onClick={() => other()}>
          Другая папка или флешка…
        </button>
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          Отмена
        </button>
      </div>
    </Modal>
  );
}

/** «Сохранность данных»: папка сохранности, ручная копия и восстановление. */
export function VaultCard() {
  const status = useQuery({ queryKey: ["vaultStatus"], queryFn: api.vaultStatus });
  const backup = useQuery({ queryKey: ["backupStatus"], queryFn: api.backupStatus }).data;
  const setSetting = useAction(api.setSetting);
  const sync = useAction(api.vaultSync);
  const [msg, setMsg] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"place" | "transfer" | null>(null);
  const s = status.data;

  const copy = useAction(async () => {
    const path = await pickSave(backup?.defaultName ?? "p-treasury.db", [DB]);
    if (!path) return;
    await api.backupNow(path);
    setMsg(`Копия сохранена: ${baseName(path)}`);
  });
  const open = useAction(() => api.openFolder(s!.dir));

  return (
    <div className="card" data-testid="backup-card">
      <h2>
        Сохранность данных
        <Hint of="backups" />
      </h2>
      {s && !s.on && <p className="warn">Папка сохранности выключена: копии делаются только вручную.</p>}
      {s?.on && s.error && (
        <p className="warn" data-testid="vault-error">
          {s.error}
        </p>
      )}
      {backup?.reminderDue && <p className="warn">Резервной копии давно не было. Нажмите «Сохранить сейчас» или проверьте папку.</p>}
      <dl className="facts">
        <dt>
          Папка
          <Hint of="vaultPlace" />
        </dt>
        <dd className="mono" data-testid="vault-dir">
          {s?.dir}
        </dd>
        <dt>Обновлена</dt>
        <dd data-testid="vault-synced">{localWhen(s?.syncedAt)}</dd>
        <dt>Последняя копия</dt>
        <dd data-testid="last-backup">{localWhen(backup?.lastBackupAt)}</dd>
        <dt>
          В папке
          <Hint of="vaultExcel" />
        </dt>
        <dd>копия всех данных (.ptreasury), прошлые копии, Excel: операции, сводка за год, все данные</dd>
      </dl>
      <div className="btn-group">
        <button className="btn primary" onClick={() => sync.run()} disabled={sync.busy || !s?.on} aria-busy={sync.busy} data-done={sync.done || undefined}>
          Сохранить сейчас
        </button>
        <button className="btn" onClick={() => open.run()}>
          Открыть папку
        </button>
        <button className="btn" onClick={() => setDialog("place")}>
          Сменить папку
        </button>
        <select name="autobackupKeep" aria-label="Сколько прошлых копий хранить" value={s?.keep ?? "10"} onChange={(e) => setSetting.run("autobackup_keep", e.target.value)}>
          {[3, 5, 10, 20, 30].map((n) => (
            <option key={n} value={String(n)}>
              хранить {n}
            </option>
          ))}
        </select>
      </div>
      <div className="btn-group">
        <button className="btn" onClick={() => setDialog("transfer")}>
          Перенести данные с другого компьютера
        </button>
        <Hint of="transfer" />
        <button className="btn" onClick={() => copy.run()} title="Сохранить копию в любой файл, например на флешку">
          Сделать копию
        </button>
        <RestoreButton onDone={setMsg} />
        <label className="check">
          <input type="checkbox" name="vaultOn" checked={s?.on ?? true} onChange={(e) => setSetting.run("vault_on", e.target.checked ? "1" : "0")} />
          Вести папку сохранности
        </label>
      </div>
      {msg && (
        <p className="ok" data-testid="backup-msg">
          {msg}
        </p>
      )}
      <ErrorText error={copy.error ?? open.error ?? setSetting.error ?? sync.error} />
      {dialog === "place" && <PlaceDialog current={s?.dir ?? ""} onClose={() => setDialog(null)} />}
      {dialog === "transfer" && <TransferDialog onClose={() => setDialog(null)} onDone={setMsg} />}
    </div>
  );
}

/** «Восстановить из копии»: файл копии, проверка, подтверждение. */
function RestoreButton({ onDone }: { onDone: (msg: string) => void }) {
  const [found, setFound] = useState<VaultFound | null>(null);
  const choose = useAction(async () => {
    const path = await pickOpen([DB]);
    if (path) setFound(await api.vaultInspect(path));
  });
  const restore = useAction(
    () => api.restoreBackup(found!.path),
    () => {
      setFound(null);
      onDone("Данные восстановлены из копии. Прежние данные сохранены в папке программы (backups).");
    },
  );
  return (
    <>
      <button className="btn" onClick={() => choose.run()}>
        Восстановить из копии
      </button>
      <ErrorText error={choose.error} />
      {found && (
        <Modal title="Восстановить из копии?" onClose={() => setFound(null)}>
          <p>
            В копии: счетов {found.accounts}, операций {found.transactions}
            {found.lastDate && `, последняя операция ${formatDate(found.lastDate)}`}.
          </p>
          <p className="muted">Текущие данные заменятся данными из копии. Перед этим они сохранятся отдельной копией в папке программы.</p>
          <ErrorText error={restore.error} />
          <div className="actions">
            <span className="spacer" />
            <button className="btn" onClick={() => setFound(null)}>
              Отмена
            </button>
            <button className="btn primary" onClick={() => restore.run()} disabled={restore.busy}>
              Восстановить
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
