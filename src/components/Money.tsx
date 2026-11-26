import { useFine } from "../lib/fine";
import { useEffect, useRef, useState } from "react";
import { useCurrencies, useSettings } from "../lib/queries";
import { formatMoney, HIDDEN_AMOUNT } from "../lib/money";

// Единственный компонент, который выводит суммы. Режим «скрыть суммы»
// (настройка hide_amounts) заменяет их на «•••».
export function Money({
  amount,
  symbol = "₽",
  currencyCode,
  minorUnits = 2,
  wholeUnits,
  signed,
  className,
  animate,
}: {
  amount: number;
  symbol?: string;
  currencyCode?: string;
  minorUnits?: number;
  /** Компактные годовые итоги всегда показывают целые денежные единицы. */
  wholeUnits?: boolean;
  /** Показывать «+» у положительных сумм (доходы). */
  signed?: boolean;
  className?: string;
  /** Новая сумма мягко проявляется на месте прежней (крупные суммы на Главной). */
  animate?: boolean;
}) {
  const { data: settings } = useSettings();
  const label = useFine().code ? currencyCode ?? symbol : symbol;
  const hidden = !settings || settings.hide_amounts === "1";
  const swap = useSwap(amount, !!animate && !hidden);
  const text = hidden ? HIDDEN_AMOUNT : (signed && amount > 0 ? "+" : "") + formatMoney(amount, label, minorUnits, wholeUnits);
  const cls = ["money", className, !hidden && swap > 0 && "money-swap"].filter(Boolean).join(" ");
  return (
    <span key={swap} className={cls}>
      {text}
    </span>
  );
}

/** Новый итог отображается сразу. При смене суммы кратко выделяется только фон. */
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
export function BaseMoney({ currencyCode, ...props }: { amount: number; currencyCode?: string; signed?: boolean; animate?: boolean; className?: string }) {
  const { data: settings } = useSettings();
  useFine(); // Г12: копейки и «RUB» меняются сразу
  const base = useCurrencies().data?.find((c) => c.code === (currencyCode ?? settings?.base_currency ?? "RUB"));
  if (currencyCode && !base) return <span>—</span>;
  return <Money {...props} symbol={base?.symbol ?? "₽"} currencyCode={base?.code} minorUnits={base?.minorUnits ?? 2} />;
}
