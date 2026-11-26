import { emitTo, listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { api } from "../lib/api";
import { QuickEntry } from "./QuickEntry";

const focusInput = () => document.querySelector<HTMLTextAreaElement>('textarea[name="quickText"]')?.focus();

/**
 * Отдельное маленькое окно быстрого ввода (Ctrl+Alt+P из любой программы).
 * Esc прячет окно; после записи оно само прячется через секунду.
 */
export function QuickWindow() {
  const pendingHide = useRef(0);
  const interaction = useRef(0);
  const savingAt = useRef(0);
  const cancelHide = () => {
    interaction.current++;
    window.clearTimeout(pendingHide.current);
  };
  useEffect(() => {
    const un = listen("quick-shown", () => { cancelHide(); focusInput(); });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing || e.repeat) return;
      cancelHide();
      void api.hideQuick(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelHide();
      un.then((f) => f());
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <main className="quick-window" onInputCapture={cancelHide} onCompositionStartCapture={cancelHide} onPointerDownCapture={cancelHide}>
      <QuickEntry autoFocus inWindow onSaveStart={() => { savingAt.current = interaction.current; }} onSaved={() => {
        // Основное окно получает запись и при продолжении ввода в этом окне.
        void emitTo("main", "data-changed");
        if (interaction.current === savingAt.current) {
          window.clearTimeout(pendingHide.current);
          pendingHide.current = window.setTimeout(() => { void api.hideQuick(false); }, 900);
        }
      }} />
      <p className="hint">Enter — записать, Esc — закрыть. Сочетание меняется в Настройках.</p>
    </main>
  );
}
