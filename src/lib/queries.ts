// Общие запросы к ядру с едиными ключами кеша.
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { setDateFormat, today } from "./dates";
import { AGGREGATE_STALE_MS } from "./queryPolicy";

export const useAppInfo = () => useQuery({ queryKey: ["appInfo"], queryFn: api.appInfo });
export const useSettings = () =>
  useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const s = await api.getSettings();
      setDateFormat(s.date_format);
      return s;
    },
  });
export const useCurrencies = () => useQuery({ queryKey: ["currencies"], queryFn: api.listCurrencies, staleTime: Infinity });
export const useAccounts = (includeArchived = false) =>
  useQuery({ queryKey: ["accounts", includeArchived], queryFn: () => api.listAccounts(includeArchived) });
export const useCategories = (includeArchived = false) =>
  useQuery({ queryKey: ["categories", includeArchived], queryFn: () => api.listCategories(includeArchived) });

/** Бюджетный месяц, в который попадает дата (с учётом «первого дня месяца»). */
export const useMonthOf = (date: string) => useQuery({ queryKey: ["monthOf", date], queryFn: () => api.monthOf(date) });
export const useBudget = (month: string | undefined) =>
  useQuery({ queryKey: ["budget", month], queryFn: () => api.getBudget(month!), enabled: !!month });

/** Главная и Календарь показывают один прогноз для стандартного сценария. */
export const useDefaultForecast = () =>
  useQuery({
    queryKey: ["forecast", null, today()],
    queryFn: () => api.forecast(null),
    staleTime: AGGREGATE_STALE_MS,
  });
