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
export const DB: Filter = { name: "Копия P-Treasury", extensions: ["db"] };

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
