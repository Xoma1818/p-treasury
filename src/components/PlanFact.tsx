import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Budget } from "../lib/api";
import { planFact, type PlanFactKind } from "../lib/planFact";
import { PlanForm } from "./Invest";
import { Money } from "./Money";
import { Hint } from "./Hint";

const TITLES: Record<PlanFactKind, string> = {
  income: "Доходы",
  expense: "Расходы",
  invest: "Инвестиции",
};

/** Бюджет → «План и факт»: доходы, расходы и инвестиции месяца и насколько факт совпал с планом. */
export function PlanFactCard({ b, minor }: { b: Budget; minor: number }) {
  const m = useQuery({ queryKey: ["investMonth", b.period.month], queryFn: () => api.investMonth(b.period.month) }).data;
  const [planning, setPlanning] = useState(false);
  if (!m) return null;
  const pf = planFact({
    incomePlan: b.plannedIncome,
    incomeFact: b.actualIncome,
    expensePlan: b.plannedExpense,
    expenseFact: b.actualExpense,
    investPlan: m.planned ?? 0,
    investFact: m.saved,
  });
  const sym = b.currencySymbol;
  const money = (v: number, signed = false) => <Money amount={v} symbol={sym} minorUnits={minor} signed={signed} />;
  return (
    <div className="card plan-fact" data-testid="plan-fact">
      <div className="notes-head">
        <h2>
          План и факт
          <Hint of="planfact" />
        </h2>
        {pf.match != null && (
          <span className={pf.match >= 90 ? "plan-fact-match good" : "plan-fact-match"} data-testid="plan-fact-match" title="100 % — всё ровно по плану">
            Совпадение с планом {pf.match} %
          </span>
        )}
      </div>
      <table className="table">
        <thead>
          <tr>
            <td />
            <td className="num muted">План</td>
            <td className="num muted">Факт</td>
            <td className="num muted">Разница</td>
            <td className="bar-col muted">Выполнено</td>
          </tr>
        </thead>
        <tbody>
          {pf.rows.map((r) => (
            <tr key={r.kind} data-testid={`plan-fact-${r.kind}`}>
              <td>
                <div className="main">{TITLES[r.kind]}</div>
                {r.kind === "invest" && (
                  <button className="link" onClick={() => setPlanning(true)} data-testid="plan-fact-invest-edit">
                    {m.planned != null ? (m.plan.onlyMonth ? "план этого месяца" : "план на каждый месяц") : "задать план"}
                  </button>
                )}
              </td>
              <td className="num">{r.plan > 0 ? money(r.plan) : <span className="muted">—</span>}</td>
              <td className="num">{money(r.fact)}</td>
              <td className={`num ${r.plan > 0 && r.diff !== 0 ? (r.good ? "plus" : "over") : ""}`}>{r.plan > 0 ? money(r.diff, true) : ""}</td>
              <td className="bar-col">
                {r.percent != null && (
                  <>
                    <div className={r.kind === "expense" && r.percent > 100 ? "bar over" : "bar"}>
                      <span style={{ width: `${Math.min(r.percent, 100)}%` }} />
                    </div>{" "}
                    <span className="percent">{r.percent} %</span>
                  </>
                )}
              </td>
            </tr>
          ))}
          <tr className="plan-fact-total" data-testid="plan-fact-left">
            <td>
              <div className="main">Остаётся</div>
              <div className="sub">доходы − расходы − инвестиции</div>
            </td>
            <td className="num">{money(pf.leftPlan, true)}</td>
            <td className="num">{money(pf.leftFact, true)}</td>
            <td className="num">{money(pf.leftFact - pf.leftPlan, true)}</td>
            <td />
          </tr>
        </tbody>
      </table>
      <p className="hint" data-testid="plan-fact-verdict">
        {b.plannedIncome === 0
          ? "Добавьте план доходов ниже, чтобы увидеть, сходится ли план."
          : pf.leftPlan < 0
            ? <>План не сходится: лимиты расходов и инвестиции больше доходов на {money(-pf.leftPlan)}.</>
            : pf.leftPlan > 0
              ? <>План сходится: после расходов и инвестиций не распределено {money(pf.leftPlan)} — можно добавить к инвестициям или лимитам.</>
              : "План сходится: каждый рубль дохода распределён."}
      </p>
      {planning && <PlanForm m={m} month={b.period.month} onClose={() => setPlanning(false)} />}
    </div>
  );
}
