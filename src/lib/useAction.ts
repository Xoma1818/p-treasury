import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

/**
 * Действие, которое меняет данные: после успеха обновляются все экраны
 * (данные в ядре связаны: операция меняет баланс, бюджет и отчёты).
 * Текст ошибки из ядра показывается пользователю как есть.
 */
export function useAction<A extends unknown[], P extends Promise<unknown>>(fn: (...args: A) => P, onDone?: (result: Awaited<P>) => void) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: (args: A) => fn(...args) as Promise<Awaited<P>>,
    onMutate: () => setError(null),
    onSuccess: async (result) => {
      await qc.invalidateQueries();
      onDone?.(result);
    },
    onError: (e) => setError(String(e)),
  });
  return { run: (...args: A) => m.mutate(args), busy: m.isPending, error, setError };
}
