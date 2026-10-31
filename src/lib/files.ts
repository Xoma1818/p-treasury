// Выбор файлов и папок системными окнами. Сквозные тесты не могут нажимать в
// системных окнах, поэтому подкладывают ответы в window.__ptPick.
import { open, save } from "@tauri-apps/plugin-dialog";

declare global {
  interface Window {
    __ptPick?: (string | null)[];
  }
}

function testAnswer(): string | null | undefined {
  const q = window.__ptPick;
  return q && q.length > 0 ? q.shift() : undefined;
}

type Filter = { name: string; extensions: string[] };

export const XLSX: Filter = { name: "Книга Excel", extensions: ["xlsx"] };
export const CSV: Filter = { name: "CSV (разделитель ;)", extensions: ["csv"] };
export const STATEMENT: Filter = { name: "Выписка банка или CSV", extensions: ["pdf", "csv", "xlsx", "xls"] };
export const PDF: Filter = { name: "Документ PDF", extensions: ["pdf"] };
export const PNG: Filter = { name: "Картинка PNG", extensions: ["png"] };
export const DB: Filter = { name: "Копия Kazna", extensions: ["db", "ptreasury"] };
export const TRANSFER: Filter = { name: "Копия Kazna или «Все данные»", extensions: ["ptreasury", "db", "xlsx"] };

/** Куда сохранить файл; `null`, если пользователь передумал. */
export async function pickSave(defaultPath: string, filters: Filter[]): Promise<string | null> {
  const t = testAnswer();
  if (t !== undefined) return t;
  return (await save({ defaultPath, filters })) ?? null;
}

export async function pickOpen(filters: Filter[]): Promise<string | null> {
  const t = testAnswer();
  if (t !== undefined) return t;
  const r = await open({ multiple: false, directory: false, filters });
  return typeof r === "string" ? r : null;
}

export async function pickFolder(): Promise<string | null> {
  const t = testAnswer();
  if (t !== undefined) return t;
  const r = await open({ multiple: false, directory: true });
  return typeof r === "string" ? r : null;
}

/** Имя файла без папки — для сообщений «Сохранено: …». */
export const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;
