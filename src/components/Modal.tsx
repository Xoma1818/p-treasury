import { X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

/** Окно уходит так же мягко, как появилось (0.25): Esc, «×» и щелчок мимо окна
 *  сначала играют исчезновение, потом закрывают. Под автотестом — сразу. */
const CLOSE_MS = 160;

/** `side` — панель справа во всю высоту окна (Р4), а не окно посередине. */
export function Modal({ title, onClose, children, wide, side }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; side?: boolean }) {
  const [closing, setClosing] = useState(false);
  const timer = useRef(0);
  const close = useRef(onClose);
  close.current = onClose;
  const dismiss = () => {
    if (navigator.webdriver || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return close.current();
    if (timer.current) return;
    setClosing(true);
    timer.current = window.setTimeout(() => {
      // Если окно не закрылось (например, спросило подтверждение), возвращаем его как было.
      timer.current = 0;
      setClosing(false);
      close.current();
    }, CLOSE_MS);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && dismiss();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return (
    <div className={["overlay", side && "side", closing && "closing"].filter(Boolean).join(" ")} onMouseDown={(e) => e.target === e.currentTarget && dismiss()}>
      <div className={["modal", wide && "wide", side && "side"].filter(Boolean).join(" ")} role="dialog" aria-label={title} data-side={side || undefined}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={dismiss} aria-label="Закрыть">
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ErrorText({ error }: { error: string | null }) {
  return error ? (
    <p className="error" role="alert">
      {error}
    </p>
  ) : null;
}
