import type { DefaultOptions } from "@tanstack/react-query";

// Доступ к SQLite и файлам работает без интернета. Ошибки внешних служб
// (курсы, обновления) возвращает сама команда Tauri.
export const budgetQueryDefaults: DefaultOptions = {
  queries: { networkMode: "always", retry: false, refetchOnWindowFocus: false },
  mutations: { networkMode: "always", retry: false },
};

// Avoid queuing unchanged Home aggregates on a quick return.
// Mutations and background data events invalidate immediately.
export const AGGREGATE_STALE_MS = 30_000;
