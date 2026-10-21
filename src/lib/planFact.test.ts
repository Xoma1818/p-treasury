import { describe, expect, it } from "vitest";
import { planFact } from "./planFact";

describe("planFact", () => {
  it("ровно по плану — 100 %, остаток по плану и факту", () => {
    const r = planFact({ incomePlan: 100_000, incomeFact: 100_000, expensePlan: 70_000, expenseFact: 70_000, investPlan: 10_000, investFact: 10_000 });
    expect(r.match).toBe(100);
    expect([r.leftPlan, r.leftFact]).toEqual([20_000, 20_000]);
    expect(r.rows.map((x) => x.percent)).toEqual([100, 100, 100]);
  });

  it("перерасход плохо, лишний доход и инвестиции хорошо", () => {
    const r = planFact({ incomePlan: 100_000, incomeFact: 110_000, expensePlan: 70_000, expenseFact: 77_000, investPlan: 10_000, investFact: 5_000 });
    const [inc, exp, inv] = r.rows;
    expect([inc.good, exp.good, inv.good]).toEqual([true, false, false]);
    expect([inc.diff, exp.diff, inv.diff]).toEqual([10_000, 7_000, -5_000]);
    // Отклонения 10 000 + 7 000 + 5 000 из плана 180 000 → совпадение 88 %.
    expect(r.match).toBe(88);
    expect(r.leftFact).toBe(28_000);
  });

  it("без плана процента нет", () => {
    const r = planFact({ incomePlan: 0, incomeFact: 50_000, expensePlan: 0, expenseFact: 10_000, investPlan: 0, investFact: 0 });
    expect(r.match).toBeNull();
    expect(r.rows[0].percent).toBeNull();
  });
});
