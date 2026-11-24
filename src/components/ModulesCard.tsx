import { useRef } from "react";
import { api } from "../lib/api";
import { MODULE_IDS, MODULES, useModules, type ModuleId } from "../lib/modules";
import { useAction } from "../lib/useAction";
import { ErrorText } from "./Modal";

/** Г3: «Возможности» — модули, которые можно выключить. Данные выключенного модуля остаются,
 *  при включении всё возвращается на свои места. «Включить всё» — вернуть как было (Г13). */
export function ModulesCard() {
  const { off } = useModules();
  const firstOff = useRef<HTMLInputElement>(null);
  const save = useAction((next: ModuleId[]) => api.setSetting("ui_modules", JSON.stringify(next)), undefined, { singleSubmit: true });
  return (
    <div className="card" data-testid="modules-card">
      <h2>Возможности</h2>
      <p className="muted">Выключите то, чем не пользуетесь: пропадут пункты меню, карточки и вкладки. Данные не удаляются и вернутся, если включить снова.</p>
      <ul className="modules-list">
        {MODULE_IDS.map((m) => (
          <li key={m}>
            <label className="check">
              <input
                type="checkbox"
                name={`module-${m}`}
                ref={m === off[0] ? firstOff : undefined}
                checked={!off.includes(m)}
                aria-disabled={save.busy || undefined}
                onChange={() => {
                  if (!save.busy) save.run(off.includes(m) ? off.filter((x) => x !== m) : [...off, m]);
                }}
              />
              <span>
                {MODULES[m].title}
                <span className="sub">{MODULES[m].hint}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {off.length > 0 && (
        <button
          className="btn"
          disabled={save.busy}
          data-testid="modules-all"
          onClick={() => {
            firstOff.current?.focus({ preventScroll: true });
            save.run([]);
          }}
        >
          Включить всё
        </button>
      )}
      <ErrorText error={save.error} />
    </div>
  );
}
