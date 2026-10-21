import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

/** Сколько кнопка показывает галочку «Готово» после успешного действия. */
const DONE_MS = 1100;
/** Сколько ждать перед закрытием окна, чтобы галочку было видно. */
const CELEBRATE_MS = 450;

/**
 * Действие, которое меняет данные: после успеха обновляются все экраны
 * (данные в ядре связаны: операция меняет баланс, бюджет и отчёты).
 * Текст ошибки из ядра показывается пользователю как есть.
 * `done` — недолго после успеха (кнопка показывает галочку); с `celebrate`
 * продолжение (обычно закрытие окна) ждёт, пока галочку станет видно.
 */
export function useAction<A extends unknown[], P extends Promise<unknown>>(
  fn: (...args: A) => P,
  onDone?: (result: Awaited<P>) => void,
  opts?: { celebrate?: boolean },
) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const m = useMutation({
    mutationFn: (args: A) => fn(...args) as Promise<Awaited<P>>,
    onMutate: () => setError(null),
    onSuccess: async (result) => {
      setDone(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setDone(false), DONE_MS);
      const pause = opts?.celebrate && onDone ? new Promise((r) => window.setTimeout(r, CELEBRATE_MS)) : null;
      await Promise.all([qc.invalidateQueries(), pause]);
      onDone?.(result);
    },
    onError: (e) => setError(String(e)),
  });
  return { run: (...args: A) => m.mutate(args), busy: m.isPending, done, error, setError };
}
