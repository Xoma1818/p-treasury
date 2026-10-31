import { useEffect, useRef, useState } from "react";
import { useCurrencies, useSettings } from "../lib/queries";
import { formatMoney, HIDDEN_AMOUNT } from "../lib/money";

// Единственный компонент, который выводит суммы. Режим «скрыть суммы»
// (настройка hide_amounts) заменяет их на «•••».
export function Money({
  amount,
  symbol = "₽",
  minorUnits = 2,
  signed,
  className,
  animate,
}: {
  amount: number;
  symbol?: string;
  minorUnits?: number;
  /** Показывать «+» у положительных сумм (доходы). */
  signed?: boolean;
  className?: string;
  /** Новая сумма мягко проявляется на месте прежней (крупные суммы на Главной). */
  animate?: boolean;
}) {
  const { data: settings } = useSettings();
  const hidden = settings?.hide_amounts === "1";
  const swap = useSwap(amount, !!animate && !hidden);
  const text = hidden ? HIDDEN_AMOUNT : (signed && amount > 0 ? "+" : "") + formatMoney(amount, symbol, minorUnits);
  const cls = ["money", className, swap > 0 && "money-swap"].filter(Boolean).join(" ");
  return (
    <span key={swap} className={cls}>
      {text}
    </span>
  );
}

/** Номер смены суммы: новое значение проявляется на месте старого (класс money-swap),
 *  цифры не «бегут». Первый показ — без анимации. */
function useSwap(amount: number, on: boolean): number {
  const [n, setN] = useState(0);
  const prev = useRef(amount);
  useEffect(() => {
    if (prev.current === amount) return;
    prev.current = amount;
    if (on) setN((k) => k + 1);
  }, [amount, on]);
  return n;
}

/** Сумма в основной валюте (все отчёты считаются в ней). */
export function BaseMoney(props: { amount: number; signed?: boolean; className?: string }) {
  const { data: settings } = useSettings();
  const base = useCurrencies().data?.find((c) => c.code === (settings?.base_currency ?? "RUB"));
  return <Money {...props} symbol={base?.symbol ?? "₽"} minorUnits={base?.minorUnits ?? 2} />;
}
