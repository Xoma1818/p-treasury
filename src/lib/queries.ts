// Общие запросы к ядру с едиными ключами кеша.
import { queryOptions, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useStore } from "zustand";
import { AMOUNT_GUARD, amountPrivacy, guardActive, persistGuard } from "./amountPrivacy";
import { api } from "./api";
import { setDateFormat, today } from "./dates";
import { AGGREGATE_STALE_MS } from "./queryPolicy";
import { uiPrefsReadRevision } from "./uiPrefs";

export const useAppInfo = () => useQuery({ queryKey: ["appInfo"], queryFn: api.appInfo, networkMode: "always" });
const settingsQuery = queryOptions({
  queryKey: ["settings"],
  networkMode: "always",
  queryFn: async () => {
    const prefsRevision = uiPrefsReadRevision();
    const settings = await api.getSettings();
    setDateFormat(settings.date_format);
    return { settings, prefsRevision };
  },
});
export const useSettingsSnapshot = () => useQuery(settingsQuery);
type SettingsSnapshot = { settings: Awaited<ReturnType<typeof api.getSettings>>; prefsRevision: number | null };
const savedSettings = (data: SettingsSnapshot) => data.settings;
const maskedSettings = (data: SettingsSnapshot): SettingsSnapshot["settings"] => ({ ...data.settings, hide_amounts: "1" });
export function useSettings() {
  const masked = useStore(amountPrivacy.state, s => s.masked);
  return useQuery({ ...settingsQuery, select: masked ? maskedSettings : savedSettings });
}

export function useAmountPrivacyToggle() {
  const client = useQueryClient();
  return useCallback(() => {
    const snapshot = client.getQueryData(settingsQuery.queryKey);
    if (!snapshot) return;
    void amountPrivacy.toggle(snapshot.settings.hide_amounts === "1", async hidden => {
      await api.setSetting("hide_amounts", hidden ? "1" : "0");
      await client.cancelQueries({ queryKey: settingsQuery.queryKey, exact: true });
      client.setQueryData(settingsQuery.queryKey, data => data && ({
        ...data, settings: { ...data.settings, hide_amounts: hidden ? "1" : "0" },
      }));
    }, persistGuard);
  }, [client]);
}

/** Второе окно перечитывает SQLite перед снятием защиты со своего кеша. */
export function listenForAmountPrivacy(client: QueryClient) {
  let revision = 0;
  window.addEventListener("storage", async event => {
    if (event.key !== AMOUNT_GUARD) return;
    const request = ++revision;
    amountPrivacy.state.setState(s => ({ masked: true, failed: false, generation: s.generation + 1 }));
    if (event.newValue === "1" || guardActive()) return;
    try {
      await client.cancelQueries({ queryKey: settingsQuery.queryKey, exact: true });
      await client.fetchQuery(settingsQuery);
      if (request === revision && !guardActive()) amountPrivacy.state.setState({ masked: false });
    } catch {
      if (request === revision) amountPrivacy.state.setState({ failed: true });
    }
  });
}
export const useCurrencies = () => useQuery({ queryKey: ["currencies"], queryFn: api.listCurrencies, staleTime: Infinity });
export const useAccounts = (includeArchived = false) =>
  useQuery({ queryKey: ["accounts", includeArchived, today()], queryFn: () => api.listAccounts(includeArchived), staleTime: AGGREGATE_STALE_MS });
export const useCategories = (includeArchived = false) =>
  useQuery({ queryKey: ["categories", includeArchived], queryFn: () => api.listCategories(includeArchived) });

/** Бюджетный месяц, в который попадает дата (с учётом «первого дня месяца»). */
export const useMonthOf = (date: string) => useQuery({ queryKey: ["monthOf", date], queryFn: () => api.monthOf(date) });
export const budgetQuery = (month: string | undefined) =>
  queryOptions({ queryKey: ["budget", month, today()], queryFn: () => api.getBudget(month!), enabled: !!month, staleTime: AGGREGATE_STALE_MS });
export const useBudget = (month: string | undefined) => useQuery(budgetQuery(month));

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
