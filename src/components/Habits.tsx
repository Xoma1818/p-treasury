import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { formatDate } from "../lib/dates";
import { useSettings } from "../lib/queries";
import { useAction } from "../lib/useAction";
import { Money } from "./Money";
import { Hint } from "./Hint";

const days = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? "день" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "дня" : "дней");

/** Под календарём: дни без трат за месяц, текущая серия и итог прошлой недели. */
export function HabitsCard({ noSpend }: { noSpend: number }) {
  const week = useQuery({ queryKey: ["habits", "week"], queryFn: api.lastWeek }).data;
  const streak = useQuery({ queryKey: ["habits", "streak"], queryFn: api.noSpendStreak }).data ?? 0;
  const enabled = useSettings().data?.weekly_summary !== "0";
  const toggle = useAction(api.setSetting);
  const diff = week && week.prevExpense > 0 ? Math.round(((week.expense - week.prevExpense) / week.prevExpense) * 100) : null;
  return (
    <div className="columns habits">
      <div className="card" data-testid="no-spend-card">
        <h2>
          Дни без трат
          <Hint of="habits" />
        </h2>
        <p className="habit-big">
          <b data-testid="no-spend-count">{noSpend}</b> {days(noSpend)} в этом месяце
        </p>
        <p className="muted" data-testid="no-spend-streak">
          {streak > 0 ? `Сейчас серия: ${streak} ${days(streak)} подряд. Так держать!` : "Сегодня уже были траты: новая серия начнётся завтра."}
        </p>
      </div>
      {week && (
        <div className="card" data-testid="week-summary">
          <h2>Итог прошлой недели</h2>
          <p className="muted">
            {formatDate(week.from)} — {formatDate(week.to)}
          </p>
          <p className="habit-big">
            Расходы <Money amount={week.expense} symbol={week.currencySymbol} minorUnits={week.minorUnits} />
            {diff != null && (
              <span className={diff > 0 ? "warn" : "ok-text"}> {diff === 0 ? "как неделей раньше" : diff < 0 ? `на ${-diff} % меньше` : `на ${diff} % больше`}</span>
            )}
          </p>
          {week.topCategory && (
            <p className="muted">
              Больше всего — {week.topCategory}: <Money amount={week.topAmount} symbol={week.currencySymbol} minorUnits={week.minorUnits} />
            </p>
          )}
          <label className="check small">
            <input type="checkbox" name="weeklySummary" checked={enabled} onChange={(e) => toggle.run("weekly_summary", e.target.checked ? "1" : "0")} />
            Присылать итог уведомлением по понедельникам
          </label>
        </div>
      )}
    </div>
  );
}
