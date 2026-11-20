// Г13: настройки вида (тема, масштаб, как открывать операцию) живут в хранилище окна,
// а их копия — в базе (настройка `ui_prefs`). Так они попадают в резервную копию и
// возвращаются после восстановления на другом компьютере.
import { api } from "./api";

/** Ключи хранилища окна, которые копируются в базу. */
export const MIRRORED_PREFS = ["p-treasury-theme", "p-treasury-scale", "kazna.txnOpen", "kazna.navLayout", "kazna.addMain", "kazna.txnForm", "kazna.txnHead", "kazna.look", "kazna.keys", "kazna.txnTable", "kazna.fine"] as const;

let db: Record<string, string> | null = null;

function parse(raw: string | undefined): Record<string, string> {
  try {
    const v = JSON.parse(raw || "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "string")) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Пока своя запись в базу не дошла, перечитанные настройки ещё старые: их не применяем. */
let pending = 0;
let writeQueue = Promise.resolve();
let revision = 0;
let replacing = 0;

export const uiPrefsReadRevision = () => (pending || replacing ? null : revision);

/** Команды смены базы ждут сохранения настроек в прежнем бюджете. */
export async function afterUiPrefsSaved<T>(replace: () => Promise<T>): Promise<T> {
  replacing++;
  revision++;
  try {
    await writeQueue;
    return await replace();
  } finally {
    replacing--;
  }
}

function write() {
  if (!db) return;
  const snapshot = JSON.stringify(db);
  revision++;
  pending++;
  // Снимок содержит все настройки. Следующий снимок пишем только после предыдущего,
  // иначе более ранний запрос может завершиться последним и вернуть старые значения.
  writeQueue = writeQueue
    .then(() => api.setSetting("ui_prefs", snapshot))
    .catch(() => {})
    .finally(() => {
      pending--;
    });
}

/** Копию из базы надо применить: при запуске, и когда она поменялась не из этого окна
 *  (восстановили копию, перенесли данные, открыли другой бюджет). Пока своя запись
 *  в пути, перечитанные настройки ещё старые — их не применяем. */
export function prefsToApply(raw: string | undefined): boolean {
  if (db == null) return true;
  if (pending > 0) return false;
  const saved = parse(raw);
  return MIRRORED_PREFS.some((k) => saved[k] != null && saved[k] !== db![k]);
}

/** Записать изменённую настройку вида и в базу. До загрузки настроек — только в окно. */
export function pushPref(key: string, value: string) {
  pushPrefs({ [key]: value });
}

/** Записать связанные изменения одним снимком. */
export function pushPrefs(values: Record<string, string>) {
  const current = db;
  if (replacing || !current || Object.entries(values).every(([key, value]) => current[key] === value)) return;
  db = { ...current, ...values };
  write();
}

/** Тема: копия в базе главнее окна. После восстановления копии или переноса тема
 *  приходит из неё, даже если в этом окне уже была выбрана другая. */
const DB_WINS = new Set<string>(["p-treasury-theme"]);

/** Настройки уже загружены в этом окне: новая копия из базы пришла извне
 *  (восстановили копию, перенесли данные) и должна победить. */
export const prefsLoaded = () => db != null;

/** При запуске: чего нет в окне — берём из базы (восстановление копии);
 *  чего нет в базе — дописываем из окна. Тему из базы берём всегда.
 *  `restore` — база сменилась у работающего окна: тогда всё, что есть в базе, главнее окна.
 *  Возвращает ключи, взятые из базы. */
export function loadPrefs(raw: string | undefined, storage: Pick<Storage, "getItem" | "setItem"> = localStorage, { restore = false } = {}): string[] {
  const saved = parse(raw);
  const restored: string[] = [];
  let dirty = false;
  for (const k of MIRRORED_PREFS) {
    let local: string | null = null;
    try {
      local = storage.getItem(k);
    } catch {
      /* хранилище недоступно */
    }
    if (saved[k] != null && (local == null || ((restore || DB_WINS.has(k)) && local !== saved[k]))) {
      try {
        storage.setItem(k, saved[k]);
        restored.push(k);
      } catch {
        /* без запоминания */
      }
    } else if (local != null && saved[k] !== local) {
      saved[k] = local;
      dirty = true;
    }
  }
  db = saved;
  if (dirty) write();
  return restored;
}
