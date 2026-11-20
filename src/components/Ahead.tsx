// Главная → «Взгляд вперёд» (0.19): остаток через 3 месяца и линия прогноза на год.
import { useDefaultForecast } from "../lib/queries";
import { genitive, prepositional, aheadSummary } from "../lib/forecast";
import { useUi } from "../lib/store";
import { Sparkline } from "./Dashboard";
import { Hint } from "./Hint";
import { BaseMoney } from "./Money";

export function AheadCard() {
  const f = useDefaultForecast().data;
  const { go } = useUi();
  if (!f) return null;
  const a = aheadSummary(f);
  return (
    <div className="card ahead-card clickable" onClick={() => go("forecast")} data-testid="home-ahead">
      <div className="tile-label">
        Взгляд вперёд
        <Hint of="home.ahead" />
      </div>
      <div className="ahead-row">
        <span>
          На конец {genitive(a.month)}: <b className={a.closing < 0 ? "tile-value over" : "tile-value"} data-testid="ahead-value"><BaseMoney amount={a.closing} /></b>
        </span>
        <span className="hint">
          <BaseMoney amount={a.change} signed /> к сегодняшнему
        </span>
      </div>
      <Sparkline values={[f.liquid, ...f.months.map((m) => m.closing)]} />
      {a.short ? (
        <div className="ahead-warn" data-testid="ahead-short">В {prepositional(a.short)} денег может не хватить</div>
      ) : (
        <div className="ahead-ok">Денег хватает на все 12 месяцев</div>
      )}
    </div>
  );
}
