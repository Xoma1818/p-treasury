import { useEffect, useState } from "react";

/** Значение, которое меняется не чаще, чем раз в `ms` мс (живой расчёт без запроса на каждую букву). */
export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}
