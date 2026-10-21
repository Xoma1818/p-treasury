import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { api } from "../lib/api";
import { QuickEntry } from "./QuickEntry";

const focusInput = () => document.querySelector<HTMLTextAreaElement>('textarea[name="quickText"]')?.focus();

/**
 * Отдельное маленькое окно быстрого ввода (Ctrl+Alt+P из любой программы).
 * Esc прячет окно; после записи оно само прячется через секунду.
 */
export function QuickWindow() {
  useEffect(() => {
    const un = listen("quick-shown", focusInput);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && api.hideQuick(false);
    window.addEventListener("keydown", onKey);
    return () => {
      un.then((f) => f());
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <main className="quick-window">
      <QuickEntry autoFocus inWindow onSaved={() => setTimeout(() => api.hideQuick(true), 900)} />
      <p className="hint">Enter — записать, Esc — закрыть. Сочетание меняется в Настройках.</p>
    </main>
  );
}
