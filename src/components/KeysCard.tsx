import { useEffect, useState } from "react";
import { assign, comboFor, comboOf, isDefaultKeys, KEY_ACTIONS, saveKeys, takenBy, usable, useKeyMap, type KeyAction } from "../lib/keymap";

/** Г10: «Клавиши» в Настройках. Щелчок по сочетанию — нажмите новое; Backspace выключает,
 *  Esc отменяет. Занятое сочетание не принимается: программа говорит, чем оно занято. */
export function KeysCard() {
  const m = useKeyMap();
  const [wait, setWait] = useState<KeyAction | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!wait) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") return setWait(null);
      if (e.key === "Backspace" || e.key === "Delete") {
        saveKeys(assign(m, wait, ""));
        setMsg(null);
        return setWait(null);
      }
      const combo = comboOf(e);
      if (!combo) return;
      if (!usable(combo)) return setMsg("Нужна клавиша F1…F12 или сочетание с Ctrl или Alt.");
      const taken = takenBy(m, wait, combo);
      if (taken) return setMsg(`${combo} уже занято: «${taken}». Выберите другое.`);
      saveKeys(assign(m, wait, combo));
      setMsg(null);
      setWait(null);
    };
    // В фазе перехвата: раньше, чем сочетание сработает в окне.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [wait, m]);
  return (
    <div className="card" data-testid="keys-card">
      <h2>Клавиши</h2>
      <p className="muted">Щёлкните сочетание и нажмите новое. Backspace — выключить, Esc — отмена. Ctrl+Z, Ctrl+A, Ctrl+1…9 и Esc закреплены.</p>
      <table className="table compact keys-table">
        <tbody>
          {KEY_ACTIONS.map((a) => {
            const combo = comboFor(m, a.id);
            return (
              <tr key={a.id} data-testid={`keys-${a.id}`}>
                <td>{a.label}</td>
                <td className="num">
                  <button
                    type="button"
                    className={wait === a.id ? "btn small active" : "btn small"}
                    data-testid={`key-${a.id}`}
                    aria-label={`${a.label}: ${combo || "не назначено"}. Изменить`}
                    onClick={() => (setMsg(null), setWait(wait === a.id ? null : a.id))}
                  >
                    {wait === a.id ? "Нажмите сочетание…" : combo ? <kbd>{combo}</kbd> : "—"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {msg && (
        <p className="error" role="alert" data-testid="keys-msg">
          {msg}
        </p>
      )}
      {!isDefaultKeys(m) && (
        <button className="btn" data-testid="keys-reset" onClick={() => (saveKeys({}), setWait(null), setMsg(null))}>
          Как было
        </button>
      )}
    </div>
  );
}
