import type { TxnFilter } from "./api";

interface IdPage {
  items: { id: string }[];
  total: number;
}

const PAGE_SIZE = 1000;

/** Все ID по фильтру: сервер ограничивает размер одной страницы независимо от limit.
 * Результат применяется только целиком; смена набора между страницами требует повторить выбор. */
export async function loadAllTransactionIds(
  loadPage: (filter: TxnFilter) => Promise<IdPage>,
  filter: TxnFilter,
  signal?: AbortSignal,
): Promise<string[] | null> {
  const ids = new Set<string>();
  let offset = 0;
  let total: number | null = null;
  do {
    if (signal?.aborted) return null;
    const page = await loadPage({ ...filter, limit: PAGE_SIZE, offset });
    if (signal?.aborted) return null;
    if (total !== null && total !== page.total) throw new Error("список операций изменился, повторите Ctrl+A");
    total = page.total;
    for (const item of page.items) ids.add(item.id);
    offset += page.items.length;
    if (ids.size !== offset || offset > total || (offset < total && page.items.length === 0)) {
      throw new Error("список операций изменился, повторите Ctrl+A");
    }
  } while (offset < total);
  return [...ids];
}
