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
  /** Число «набегает» от прежнего значения (крупные суммы на Главной). */
  animate?: boolean;
}) {
  const { data: settings } = useSettings();
  const hidden = settings?.hide_amounts === "1";
  const shown = useCountUp(amount, !!animate && !hidden);
  const text = hidden ? HIDDEN_AMOUNT : (signed && amount > 0 ? "+" : "") + formatMoney(shown, symbol, minorUnits);
  return <span className={className ? `money ${className}` : "money"}>{text}</span>;
}

const COUNT_MS = 650;

/** Число «набегает» от нуля при первом показе (ease-out); дальше меняется сразу.
 *  Под автотестом (navigator.webdriver) и при «меньше движения» — без анимации. */
function useCountUp(target: number, on: boolean): number {
  const animate = on && !navigator.webdriver && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const [value, setValue] = useState(animate ? 0 : target);
  const running = useRef(animate);
  const first = useRef(target);
  useEffect(() => {
    if (target !== first.current) running.current = false;
    if (!running.current) return;
    const start = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / COUNT_MS);
      setValue(Math.round(target * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(step);
      else running.current = false;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return running.current ? value : target;
}

/** Сумма в основной валюте (все отчёты считаются в ней). */
export function BaseMoney(props: { amount: number; signed?: boolean; className?: string }) {
  const { data: settings } = useSettings();
  const base = useCurrencies().data?.find((c) => c.code === (settings?.base_currency ?? "RUB"));
  return <Money {...props} symbol={base?.symbol ?? "₽"} minorUnits={base?.minorUnits ?? 2} />;
}
