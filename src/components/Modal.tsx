import { X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

/** Окно уходит так же мягко, как появилось (0.25): Esc, «×» и щелчок мимо окна
 *  сначала играют исчезновение, потом закрывают. Под автотестом — сразу. */
const CLOSE_MS = 160;

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const [closing, setClosing] = useState(false);
  const timer = useRef(0);
  const close = useRef(onClose);
  close.current = onClose;
  const dismiss = () => {
    if (navigator.webdriver || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return close.current();
    if (timer.current) return;
    setClosing(true);
    timer.current = window.setTimeout(() => close.current(), CLOSE_MS);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && dismiss();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return (
    <div className={closing ? "overlay closing" : "overlay"} onMouseDown={(e) => e.target === e.currentTarget && dismiss()}>
      <div className={wide ? "modal wide" : "modal"} role="dialog" aria-label={title}>
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
