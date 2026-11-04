import { ArrowDown, ArrowUp } from "lucide-react";
import { useModules } from "../lib/modules";
import { DEFAULT_NAV, isDefaultNav, NAV_FIXED, saveAddMain, saveNav, useNavPrefs, type AddMain, type NavLayout } from "../lib/navLayout";
import { section } from "../lib/sections";
import { ADD_LABEL, ADD_TYPES } from "./AddMenu";

/** Г4 и Г6: «Меню и кнопка «+»» в Настройках. Порядок разделов стрелками, галочка — показывать
 *  в меню, «Мои виды» можно поднять наверх. «Как было» возвращает меню и кнопку по умолчанию. */
export function NavCard() {
  const { nav, addMain } = useNavPrefs();
  const { sectionOn } = useModules();
  const set = (next: Partial<NavLayout>) => saveNav({ ...nav, ...next });
  const move = (i: number, d: -1 | 1) => {
    const order = [...nav.order];
    [order[i], order[i + d]] = [order[i + d], order[i]];
    set({ order });
  };
  const toggle = (id: (typeof nav.order)[number]) =>
    set({ hidden: nav.hidden.includes(id) ? nav.hidden.filter((x) => x !== id) : [...nav.hidden, id] });
  const custom = !isDefaultNav(nav) || addMain !== "expense";
  return (
    <div className="card" data-testid="nav-card">
      <h2>Меню и кнопка «+»</h2>
      <p className="muted">Порядок разделов задаёт и Ctrl+1…9. «Главная» и «Настройки» остаются в меню всегда.</p>
      <ol className="nav-order">
        {nav.order.map((id, i) => {
          const s = section(id);
          const off = !sectionOn(id);
          return (
            <li key={id} data-testid={`nav-order-${id}`}>
              <label className="check">
                <input
                  type="checkbox"
                  name={`nav-${id}`}
                  checked={!nav.hidden.includes(id)}
                  disabled={NAV_FIXED.includes(id)}
                  onChange={() => toggle(id)}
                />
                <span>
                  {s.title}
                  {off && <span className="sub">Выключено в «Возможностях»</span>}
                </span>
              </label>
              <span className="nav-order-move">
                <button type="button" className="icon-btn" aria-label={`${s.title}: выше`} disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp size={16} aria-hidden />
                </button>
                <button type="button" className="icon-btn" aria-label={`${s.title}: ниже`} disabled={i === nav.order.length - 1} onClick={() => move(i, 1)}>
                  <ArrowDown size={16} aria-hidden />
                </button>
              </span>
            </li>
          );
        })}
      </ol>
      <label className="check">
        <input type="checkbox" name="navViewsTop" checked={nav.viewsTop} onChange={(e) => set({ viewsTop: e.target.checked })} />
        <span>«Мои виды» — вверху меню</span>
      </label>
      <div className="field">
        <label htmlFor="addMain">Главная кнопка на Главной</label>
        <select id="addMain" name="addMain" value={addMain} onChange={(e) => saveAddMain(e.target.value as AddMain)}>
          {ADD_TYPES.map((t) => (
            <option key={t} value={t}>
              {ADD_LABEL[t].replace("+ ", "")}
            </option>
          ))}
        </select>
        <span className="sub muted">Остальное открывается стрелкой ▾ рядом.</span>
      </div>
      {custom && (
        <button
          className="btn"
          data-testid="nav-reset"
          onClick={() => {
            saveNav(DEFAULT_NAV);
            saveAddMain("expense");
          }}
        >
          Как было
        </button>
      )}
    </div>
  );
}
