import type { UseQueryResult } from "@tanstack/react-query";

/** Не заменяем предыдущую подтверждённую выборку нулём при ошибке фонового запроса. */
export function ChartStatus({ query, loading }: { query: Pick<UseQueryResult, "isPending" | "isError" | "data" | "error" | "refetch" | "isFetching">; loading: string }) {
  if (query.isPending) return <p className="muted reports-status" role="status">{loading}</p>;
  if (!query.isError) return null;
  return <p className="error reports-status" role="alert">
    {query.data ? "Не удалось обновить данные. Показан предыдущий результат." : "Не удалось загрузить данные."} {String(query.error)}{" "}
    <button type="button" className="link" disabled={query.isFetching} onClick={() => void query.refetch()}>Повторить</button>
  </p>;
}

export function MissingChartRates({ rates }: { rates: string[] }) {
  return rates.length > 0 ? <p className="hint warn">Часть операций не вошла в расчёт. Нет курса для {rates.join(", ")}.</p> : null;
}
