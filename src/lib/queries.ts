// Общие запросы к ядру с едиными ключами кеша.
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export const useAppInfo = () => useQuery({ queryKey: ["appInfo"], queryFn: api.appInfo });
export const useSettings = () => useQuery({ queryKey: ["settings"], queryFn: api.getSettings });
export const useCurrencies = () => useQuery({ queryKey: ["currencies"], queryFn: api.listCurrencies, staleTime: Infinity });
export const useAccounts = (includeArchived = false) =>
  useQuery({ queryKey: ["accounts", includeArchived], queryFn: () => api.listAccounts(includeArchived) });
export const useCategories = (includeArchived = false) =>
  useQuery({ queryKey: ["categories", includeArchived], queryFn: () => api.listCategories(includeArchived) });

/** Бюджетный месяц, в который попадает дата (с учётом «первого дня месяца»). */
export const useMonthOf = (date: string) => useQuery({ queryKey: ["monthOf", date], queryFn: () => api.monthOf(date) });
export const useBudget = (month: string | undefined) =>
  useQuery({ queryKey: ["budget", month], queryFn: () => api.getBudget(month!), enabled: !!month });
