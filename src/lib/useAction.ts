import { useMutation, useQueryClient, type NetworkMode } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

/** Сколько кнопка показывает галочку «Готово» после успешного действия. */
const DONE_MS = 1100;

/**
 * Действие, которое меняет данные: после успеха обновляются все экраны
 * (данные в ядре связаны: операция меняет баланс, бюджет и отчёты).
 * Текст ошибки из ядра показывается пользователю как есть.
 * Открытая форма завершает действие после обновления данных. Если кнопка
 * остаётся на экране, `done` позволяет ненадолго показать подтверждение.
 */
export function useAction<A extends unknown[], P extends Promise<unknown>>(
  fn: (...args: A) => P,
  onDone?: (result: Awaited<P>) => void,
  opts?: { singleSubmit?: boolean; networkMode?: NetworkMode },
) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const inFlight = useRef<Promise<Awaited<P>> | null>(null);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const m = useMutation({
    networkMode: opts?.networkMode,
    mutationFn: (args: A) => fn(...args) as Promise<Awaited<P>>,
    onMutate: () => { setError(null); setDone(false); },
    onSuccess: async (result) => {
      await qc.invalidateQueries();
      setDone(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setDone(false), DONE_MS);
      onDone?.(result);
    },
    onError: (e) => setError(String(e)),
  });
  const runAsync = (...args: A) => {
    if (!opts?.singleSubmit) return m.mutateAsync(args);
    // Два события могут прийти до того, как React отключит кнопку формы.
    if (!inFlight.current) {
      inFlight.current = m.mutateAsync(args).finally(() => { inFlight.current = null; });
    }
    return inFlight.current;
  };
  const run = (...args: A) => {
    // Ошибку показывает onError. Вызывающие runAsync могут также обработать её сами.
    void runAsync(...args).catch(() => {});
  };
  return { run, runAsync, busy: m.isPending, done, error, setError };
}
