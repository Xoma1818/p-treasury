import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Budget } from "../lib/api";
import { planFact, type PlanFactKind } from "../lib/planFact";
import { needsPlanCurrency, progressIssue } from "../lib/invest";
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
  const issue = progressIssue(m);
  const comparable = !issue && b.currencyCode === m.currency.code;
  const budgetFactsComplete = b.missingRates.length === 0;
  const pf = planFact({
    incomePlan: b.plannedIncome,
    incomeFact: b.actualIncome,
    expensePlan: b.plannedExpense,
    expenseFact: b.actualExpense,
    investPlan: m.planned ?? 0,
    investFact: m.saved,
  });
  const sym = b.currencySymbol;
  const money = (v: number, signed = false) => <Money amount={v} symbol={sym} currencyCode={b.currencyCode} minorUnits={minor} signed={signed} />;
  const rowMoney = (kind: PlanFactKind, value: number, signed = false) => kind === "invest"
    ? <Money amount={value} currencyCode={m.currency.code} symbol={m.currency.symbol} minorUnits={m.currency.minorUnits} signed={signed} />
    : money(value, signed);
  return (
    <div className="card plan-fact" data-testid="plan-fact">
      <div className="notes-head">
        <h2>
          План и факт
          <Hint of="planfact" />
        </h2>
        {comparable && budgetFactsComplete && pf.match != null && (
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
          {pf.rows.map((r) => {
            const complete = r.kind === "invest" ? m.savedComplete : budgetFactsComplete;
            const showDiff = complete && r.plan > 0 && (r.kind !== "invest" || !issue);
            const percent = r.kind === "invest" ? m.percent : complete ? r.percent : null;
            return (
              <tr key={r.kind} data-testid={`plan-fact-${r.kind}`}>
                <td>
                  <div className="main">{TITLES[r.kind]}</div>
                  {r.kind === "invest" && (
                    <button className="link" onClick={() => setPlanning(true)} data-testid="plan-fact-invest-edit">
                      {needsPlanCurrency(m.plan) ? "Указать валюту плана" : m.plan.mode ? (m.plan.onlyMonth ? "план этого месяца" : "план на каждый месяц") : "задать план"}
                    </button>
                  )}
                </td>
                <td className="num">{r.plan > 0 ? rowMoney(r.kind, r.plan) : <span className="muted">—</span>}</td>
                <td className="num">{rowMoney(r.kind, r.fact)}{!complete && <div className="sub">По известным курсам</div>}</td>
                <td className={`num ${showDiff && r.diff !== 0 ? (r.good ? "plus" : "over") : ""}`}>{showDiff ? rowMoney(r.kind, r.diff, true) : ""}</td>
                <td className="bar-col">
                  {percent != null && (
                    <>
                      <div className={r.kind === "expense" && percent >= 100 ? "bar over" : "bar"}>
                        <span style={{ width: `${Math.min(percent, 100)}%` }} />
                      </div>{" "}
                      <span className="percent">{percent} %</span>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
          {comparable && <tr className="plan-fact-total" data-testid="plan-fact-left">
            <td>
              <div className="main">Остаётся</div>
              <div className="sub">доходы − расходы − инвестиции</div>
            </td>
            <td className="num">{money(pf.leftPlan, true)}</td>
            <td className="num">{budgetFactsComplete ? money(pf.leftFact, true) : "—"}</td>
            <td className="num">{budgetFactsComplete ? money(pf.leftFact - pf.leftPlan, true) : "—"}</td>
            <td />
          </tr>}
        </tbody>
      </table>
      {!budgetFactsComplete && <p className="hint">Для полного факта бюджета нужны курсы за даты операций ({b.missingRates.join(", ")}).</p>}
      <p className="hint" data-testid="plan-fact-verdict">
        {issue ? issue : !comparable ? `Бюджет ведётся в ${b.currencyCode}, инвестиции — в ${m.currency.code}. Общий остаток доступен при совпадении валют.` : b.plannedIncome === 0
          ? "Добавьте план доходов ниже, чтобы увидеть, сходится ли план."
          : pf.leftPlan < 0
            ? <>План не сходится: лимиты расходов и инвестиции больше доходов на {money(-pf.leftPlan)}.</>
            : pf.leftPlan > 0
              ? <>План сходится: после расходов и инвестиций не распределено {money(pf.leftPlan)} — можно добавить к инвестициям или лимитам.</>
              : "План сходится: весь доход распределён."}
      </p>
      {planning && <PlanForm m={m} month={b.period.month} onClose={() => setPlanning(false)} />}
    </div>
  );
}
