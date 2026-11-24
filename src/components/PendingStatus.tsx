import { useEffect, useState } from "react";

/** Быструю запись видно по результату. Текст ожидания нужен только при задержке. */
export function PendingStatus({ busy, children, result }: { busy: boolean; children: string; result?: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!busy) {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), 200);
    return () => window.clearTimeout(timer);
  }, [busy]);
  const text = result || (busy && slow ? children : "");
  const className = result ? undefined : text ? "muted" : "sr-only";
  return <div className={className} role="status">{text}</div>;
}
