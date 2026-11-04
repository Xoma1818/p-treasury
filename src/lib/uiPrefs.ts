// Г13: настройки вида (тема, масштаб, как открывать операцию) живут в хранилище окна,
// а их копия — в базе (настройка `ui_prefs`). Так они попадают в резервную копию и
// возвращаются после восстановления на другом компьютере.
import { api } from "./api";

/** Ключи хранилища окна, которые копируются в базу. */
export const MIRRORED_PREFS = ["p-treasury-theme", "p-treasury-scale", "kazna.txnOpen"] as const;

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

function write() {
  if (db) api.setSetting("ui_prefs", JSON.stringify(db)).catch(() => {});
}

/** Записать изменённую настройку вида и в базу. До загрузки настроек — только в окно. */
export function pushPref(key: string, value: string) {
  if (!db || db[key] === value) return;
  db = { ...db, [key]: value };
  write();
}

/** При запуске: чего нет в окне — берём из базы (восстановление копии);
 *  чего нет в базе — дописываем из окна. Возвращает ключи, взятые из базы. */
export function loadPrefs(raw: string | undefined, storage: Pick<Storage, "getItem" | "setItem"> = localStorage): string[] {
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
    if (local == null && saved[k] != null) {
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
