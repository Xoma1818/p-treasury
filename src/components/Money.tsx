import { useSettings } from "../lib/queries";
import { formatMoney, HIDDEN_AMOUNT } from "../lib/money";

// Единственный компонент, который выводит суммы. Режим «скрыть суммы»
// (настройка hide_amounts) заменяет их на «•••».
export function Money({
  amount,
  symbol = "₽",
  minorUnits = 2,
  signed,
  className,
}: {
  amount: number;
  symbol?: string;
  minorUnits?: number;
  /** Показывать «+» у положительных сумм (доходы). */
  signed?: boolean;
  className?: string;
}) {
  const { data: settings } = useSettings();
  const hidden = settings?.hide_amounts === "1";
  const text = hidden ? HIDDEN_AMOUNT : (signed && amount > 0 ? "+" : "") + formatMoney(amount, symbol, minorUnits);
  return <span className={className ? `money ${className}` : "money"}>{text}</span>;
}
