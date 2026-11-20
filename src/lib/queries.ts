// Общие запросы к ядру с едиными ключами кеша.
import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { setDateFormat, today } from "./dates";
import { AGGREGATE_STALE_MS } from "./queryPolicy";
import { uiPrefsReadRevision } from "./uiPrefs";

export const useAppInfo = () => useQuery({ queryKey: ["appInfo"], queryFn: api.appInfo });
const settingsQuery = queryOptions({
  queryKey: ["settings"],
  queryFn: async () => {
    const prefsRevision = uiPrefsReadRevision();
    const settings = await api.getSettings();
    setDateFormat(settings.date_format);
    return { settings, prefsRevision };
  },
});
export const useSettingsSnapshot = () => useQuery(settingsQuery);
export const useSettings = () => useQuery({ ...settingsQuery, select: (data) => data.settings });
export const useCurrencies = () => useQuery({ queryKey: ["currencies"], queryFn: api.listCurrencies, staleTime: Infinity });
export const useAccounts = (includeArchived = false) =>
  useQuery({ queryKey: ["accounts", includeArchived, today()], queryFn: () => api.listAccounts(includeArchived), staleTime: AGGREGATE_STALE_MS });
export const useCategories = (includeArchived = false) =>
  useQuery({ queryKey: ["categories", includeArchived], queryFn: () => api.listCategories(includeArchived) });

/** Бюджетный месяц, в который попадает дата (с учётом «первого дня месяца»). */
export const useMonthOf = (date: string) => useQuery({ queryKey: ["monthOf", date], queryFn: () => api.monthOf(date) });
export const useBudget = (month: string | undefined) =>
  useQuery({ queryKey: ["budget", month, today()], queryFn: () => api.getBudget(month!), enabled: !!month, staleTime: AGGREGATE_STALE_MS });

export const useInvestOverview = () =>
  useQuery({ queryKey: ["investOverview", today()], queryFn: api.investOverview, staleTime: AGGREGATE_STALE_MS });

export const useSpendingVsUsual = (month: string | undefined, enabled = true) =>
  useQuery({
    queryKey: ["usual", month, today()],
    queryFn: () => api.spendingVsUsual(month!),
    enabled: !!month && enabled,
    staleTime: AGGREGATE_STALE_MS,
  });

/** Главная и Календарь показывают один прогноз для стандартного сценария. */
export const useDefaultForecast = () =>
  useQuery({
    queryKey: ["forecast", null, today()],
    queryFn: () => api.forecast(null),
    staleTime: AGGREGATE_STALE_MS,
  });
