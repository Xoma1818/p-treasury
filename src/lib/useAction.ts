import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

/**
 * Действие, которое меняет данные: после успеха обновляются все экраны
 * (данные в ядре связаны: операция меняет баланс, бюджет и отчёты).
 * Текст ошибки из ядра показывается пользователю как есть.
 */
export function useAction<A extends unknown[]>(fn: (...args: A) => Promise<unknown>, onDone?: () => void) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: (args: A) => fn(...args),
    onMutate: () => setError(null),
    onSuccess: async () => {
      await qc.invalidateQueries();
      onDone?.();
    },
    onError: (e) => setError(String(e)),
  });
  return { run: (...args: A) => m.mutate(args), busy: m.isPending, error, setError };
}
