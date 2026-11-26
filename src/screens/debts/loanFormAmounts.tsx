import { useFormAmounts, useFormMoney } from "../../components/FormAmounts";
import type { DebtCard } from "../../lib/api";

/** Все выводы одной формы, включая подсказки и предпросмотр, используют её разрешение. */
export function useLoanFormAmounts(scope: string, code: string, symbol: string, minorUnits: number) {
  const privacy = useFormAmounts(scope);
  const format = useFormMoney(privacy, code, symbol, minorUnits);
  const money = (amount: number) => <span className="money">{format(amount)}</span>;
  const error = (message: string | null) => {
    if (!message || !privacy.concealed) return message;
    // Эти проверки ядра добавляют остаток или возвращённую сумму в скобках.
    return message.replace(/((?:основной долг больше остатка|сумма меньше уже возвращённого)) \([^)]*\)/gi, "$1");
  };
  return { ...privacy, money, error };
}

export const useDebtFormAmounts = (card: DebtCard, scope = card.id) =>
  useLoanFormAmounts(scope, card.currencyCode, card.currencySymbol, card.minorUnits);

export type RenderDebtMoney = ReturnType<typeof useLoanFormAmounts>["money"];
