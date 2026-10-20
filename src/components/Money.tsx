import { useQuery } from "@tanstack/react-query";
import { api, isTauri } from "../lib/api";
import { formatMoney, HIDDEN_AMOUNT } from "../lib/money";

// Единственный компонент, который выводит суммы. Режим «скрыть суммы»
// (настройка hide_amounts) заменяет их на «•••».
export function Money({ amount, symbol = "₽", minorUnits = 2 }: { amount: number; symbol?: string; minorUnits?: number }) {
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: api.getSettings, enabled: isTauri() });
  const hidden = settings?.hide_amounts === "1";
  return <span className="money">{hidden ? HIDDEN_AMOUNT : formatMoney(amount, symbol, minorUnits)}</span>;
}
