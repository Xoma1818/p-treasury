// Файл, брошенный в окно программы. Tauri перехватывает перетаскивание файлов
// из проводника (dragDropEnabled) и отдаёт пути событием webview, поэтому
// обычный onDrop в HTML этих файлов не видит.
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { isTauri } from "./api";

/** Расширения, которые понимает импорт выписок. */
export const STATEMENT_EXT = ["xlsx", "xls", "csv", "pdf"];

/** Первый файл выписки среди брошенных; `null`, если таких нет. */
export function statementOf(paths: string[]): string | null {
  return paths.find((p) => STATEMENT_EXT.includes(p.split(".").pop()?.toLowerCase() ?? "")) ?? null;
}

export type DropState = "over" | "leave" | { paths: string[] };

/** Подписка на перетаскивание файлов в окно; вернёт отписку. Вне Tauri — ничего. */
export function onFileDrop(cb: (s: DropState) => void): () => void {
  if (!isTauri()) return () => {};
  let off: (() => void) | null = null;
  let dead = false;
  getCurrentWebview()
    .onDragDropEvent((e) => {
      const p = e.payload;
      if (p.type === "enter" || p.type === "over") cb("over");
      else if (p.type === "leave") cb("leave");
      else if (p.type === "drop") cb({ paths: p.paths });
    })
    .then((u) => (dead ? u() : (off = u)))
    .catch(() => {});
  return () => {
    dead = true;
    off?.();
  };
}
