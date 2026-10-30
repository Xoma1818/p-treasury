import { api } from "../lib/api";
import { DEFAULT_LAYOUT, DEFAULT_SHOWN, HOME_BLOCKS, parseLayout, toggleBlock, toSetting, type HomeLayout } from "../lib/homeLayout";
import { useSettings } from "../lib/queries";
import { useAction } from "../lib/useAction";
import { Hint } from "./Hint";
import { ErrorText } from "./Modal";

/** Настройки → «Карточки Главной»: какие карточки видны. Порядок меняется на Главной («Настроить»). */
export function HomeCardsCard() {
  const layout = parseLayout(useSettings().data?.home_layout);
  const save = useAction((l: HomeLayout) => api.setSetting("home_layout", toSetting(l)));
  const shown = layout.order.filter((b) => !layout.hidden.includes(b)).length;
  return (
    <div className="card" data-testid="home-cards">
      <h2>
        Карточки Главной
        <Hint of="homeCards" />
      </h2>
      <p className="hint">
        На Главной {shown} из {layout.order.length}. По умолчанию — самое нужное: {DEFAULT_SHOWN.map((b) => HOME_BLOCKS[b]).join(", ")}.
      </p>
      <ul className="home-cards-list">
        {layout.order.map((b) => (
          <li key={b}>
            <label className="check">
              <input type="checkbox" name={`homeCard-${b}`} checked={!layout.hidden.includes(b)} onChange={() => save.run(toggleBlock(layout, b))} />
              {HOME_BLOCKS[b]}
            </label>
          </li>
        ))}
      </ul>
      <div className="btn-group">
        <button className="btn" onClick={() => save.run({ ...layout, hidden: [], v: 2 })} data-testid="home-cards-all">
          Показать все
        </button>
        <button className="btn" onClick={() => save.run(DEFAULT_LAYOUT)} data-testid="home-cards-default">
          Только основные
        </button>
      </div>
      <ErrorText error={save.error} />
    </div>
  );
}
