import { api } from "../lib/api";
import { MODULE_IDS, MODULES, useModules, type ModuleId } from "../lib/modules";
import { useAction } from "../lib/useAction";
import { ErrorText } from "./Modal";

/** Г3: «Возможности» — модули, которые можно выключить. Данные выключенного модуля остаются,
 *  при включении всё возвращается на свои места. «Включить всё» — вернуть как было (Г13). */
export function ModulesCard() {
  const { off } = useModules();
  const save = useAction((next: ModuleId[]) => api.setSetting("ui_modules", JSON.stringify(next)));
  const toggle = (m: ModuleId) => save.run(off.includes(m) ? off.filter((x) => x !== m) : [...off, m]);
  return (
    <div className="card" data-testid="modules-card">
      <h2>Возможности</h2>
      <p className="muted">Выключите то, чем не пользуетесь: пропадут пункты меню, карточки и вкладки. Данные не удаляются и вернутся, если включить снова.</p>
      <ul className="modules-list">
        {MODULE_IDS.map((m) => (
          <li key={m}>
            <label className="check">
              <input type="checkbox" name={`module-${m}`} checked={!off.includes(m)} onChange={() => toggle(m)} disabled={save.busy} />
              <span>
                {MODULES[m].title}
                <span className="sub">{MODULES[m].hint}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {off.length > 0 && (
        <button className="btn" onClick={() => save.run([])} data-testid="modules-all">
          Включить всё
        </button>
      )}
      <ErrorText error={save.error} />
    </div>
  );
}
