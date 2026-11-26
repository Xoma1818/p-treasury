import { useLayoutEffect, useRef, useState, type MouseEvent } from "react";

/** Сохранение и удаление из одной формы не должны попасть в две разные очереди. */
export function useFormWrite() {
  const form = useRef<HTMLFormElement>(null);
  const locked = useRef(false);
  const restore = useRef<HTMLElement | null>(null);
  const [operation, setOperation] = useState<"save" | "delete" | "template" | null>(null);
  useLayoutEffect(() => {
    if (operation || !restore.current) return;
    const target = restore.current;
    restore.current = null;
    if (form.current?.contains(target) && !target.matches(":disabled")) {
      target.focus({ preventScroll: true });
    }
  }, [operation]);
  const run = (kind: NonNullable<typeof operation>, work: () => Promise<unknown>) => {
    if (locked.current) return;
    const active = document.activeElement;
    const opener = active instanceof HTMLElement && form.current?.contains(active) ? active : null;
    locked.current = true;
    const node = form.current;
    if (node) node.dataset.writePending = "true";
    setOperation(kind);
    void work().catch(() => {
      // Ошибку показывает useAction. После разблокировки возвращаем курсор к действию.
      restore.current = opener;
    }).finally(() => {
      locked.current = false;
      if (node) delete node.dataset.writePending;
      setOperation(null);
    });
  };
  // Два клика могут прийти в одном цикле, до того как React отключит поля.
  const blockClick = (e: MouseEvent) => {
    if (locked.current) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  return { form, locked, operation, busy: operation !== null, run, blockClick };
}
