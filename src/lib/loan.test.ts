import { describe, expect, it } from "vitest";
import { addDays, addMonths, annualHint, balancePoints, daysBetween, earlyLines, monthsToPayments, monthsToTerm, parseRate, paymentsText, plannedEarly, rateChanges, rateLabel, rateToInput, termText, termToMonths, toCalcInput, type LoanForm } from "./loan";

const form = (patch: Partial<LoanForm> = {}): LoanForm => ({
  solve: "payment",
  amount: "300 000",
  payment: "",
  term: "2",
  termUnit: "years",
  rate: "12",
  ratePeriod: "year",
  rates: [],
  repayment: "annuity",
  payEvery: "month",
  issueDate: "2026-10-15",
  firstPayment: "2026-11-15",
  maturity: "",
  method: "daily",
  early: [],
  ...patch,
});

describe("срок: годы и месяцы", () => {
  it("годы переводятся в месяцы, дробные годы — тоже", () => {
    expect(termToMonths("2", "years")).toBe(24);
    expect(termToMonths("1,5", "years")).toBe(18);
    expect(termToMonths("24", "months")).toBe(24);
  });
  it("пустой, дробный в месяцах и слишком длинный срок не принимаются", () => {
    expect(termToMonths("", "months")).toBeNull();
    expect(termToMonths("2,5", "months")).toBeNull();
    expect(termToMonths("0", "years")).toBeNull();
    expect(termToMonths("51", "years")).toBeNull();
    expect(termToMonths("abc", "years")).toBeNull();
  });
  it("обратно: месяцы в поле", () => {
    expect(monthsToTerm(24, "years")).toBe("2");
    expect(monthsToTerm(18, "years")).toBe("1,5");
    expect(monthsToTerm(18, "months")).toBe("18");
  });
  it("подпись срока", () => {
    expect(termText(24)).toBe("2 года");
    expect(termText(27)).toBe("2 года 3 мес.");
    expect(termText(11)).toBe("11 мес.");
    expect(termText(60)).toBe("5 лет");
    expect(termText(12)).toBe("1 год");
  });
});

describe("строки досрочек и ставок", () => {
  it("недописанные строки пропускаются, суммы в копейках", () => {
    const list = plannedEarly([
      { amount: "50 000", frequency: "once", date: "2027-03-01", mode: "reduce_term" },
      { amount: "", frequency: "monthly", date: "2027-01-01", mode: "reduce_payment" },
      { amount: "5000", frequency: "monthly", date: "", mode: "reduce_payment" },
      { amount: "5000,50", frequency: "quarterly", date: "2027-01-10", mode: "reduce_payment" },
    ]);
    expect(list).toEqual([
      { amount: 5_000_000, startDate: "2027-03-01", frequency: "once", endDate: null, mode: "reduce_term" },
      { amount: 500_050, startDate: "2027-01-10", frequency: "quarterly", endDate: null, mode: "reduce_payment" },
    ]);
  });
  it("из записанных досрочек — обратно в строки", () => {
    expect(earlyLines([{ amount: 5_000_000, startDate: "2027-03-01", frequency: "yearly", endDate: null, mode: "reduce_term" }])).toEqual([
      { amount: "50000", frequency: "yearly", date: "2027-03-01", mode: "reduce_term" },
    ]);
  });
  it("ставки сортируются по дате, пустые пропускаются", () => {
    expect(
      rateChanges([
        { from: "2027-06-01", rate: "10" },
        { from: "2027-01-01", rate: "11,5" },
        { from: "", rate: "9" },
        { from: "2027-09-01", rate: "" },
      ]),
    ).toEqual([
      { from: "2027-01-01", rateBp: 1150 },
      { from: "2027-06-01", rateBp: 1000 },
    ]);
  });
});

describe("форма → CalcInput", () => {
  it("расчёт платежа: сумма, срок в месяцах, метод и досрочки", () => {
    const r = toCalcInput(form({ early: [{ amount: "50000", frequency: "once", date: "2027-03-01", mode: "reduce_term" }] }));
    expect(r.error).toBeNull();
    expect(r.input).toMatchObject({
      principal: 30_000_000,
      rateBp: 1200,
      repayment: "annuity",
      termMonths: 24,
      issueDate: "2026-10-15",
      firstPaymentDate: "2026-11-15",
      maturityDate: null,
      interestMethod: "daily",
      solve: "payment",
      payment: null,
    });
    expect(r.input?.plannedEarly).toHaveLength(1);
  });
  it("расчёт срока: нужен платёж, срок не передаётся", () => {
    expect(toCalcInput(form({ solve: "term" })).error).toMatch(/платёж/);
    const r = toCalcInput(form({ solve: "term", payment: "15000", term: "" }));
    expect(r.input).toMatchObject({ solve: "term", payment: 1_500_000, termMonths: null });
  });
  it("расчёт суммы: сумма не нужна, нужны платёж и срок", () => {
    const r = toCalcInput(form({ solve: "principal", amount: "", payment: "15000", term: "24", termUnit: "months" }));
    expect(r.input).toMatchObject({ solve: "principal", payment: 1_500_000, termMonths: 24 });
    expect(toCalcInput(form({ solve: "principal", payment: "15000", term: "" })).error).toMatch(/срок/);
  });
  it("разовый возврат: дата возврата вместо срока, режим всегда «платёж»", () => {
    expect(toCalcInput(form({ repayment: "bullet" })).error).toMatch(/дату возврата/);
    const r = toCalcInput(form({ repayment: "bullet", solve: "term", maturity: "2027-03-01" }));
    expect(r.input).toMatchObject({ repayment: "bullet", termMonths: null, maturityDate: "2027-03-01", firstPaymentDate: null, solve: "payment" });
  });
  it("ошибки: нет суммы, неверная ставка, без начала выплат — по умолчанию", () => {
    expect(toCalcInput(form({ amount: "" })).error).toMatch(/сумму/);
    expect(toCalcInput(form({ rate: "abc" })).error).toMatch(/ставку/);
    expect(toCalcInput(form({ rate: "" })).input?.rateBp).toBe(0);
    expect(toCalcInput(form({ firstPayment: "" })).input?.firstPaymentDate).toBeNull();
  });
});

describe("точки диаграммы остатка", () => {
  it("выдача, досрочка раньше строки в тот же день, строки по дате", () => {
    const row = (seq: number, dueDate: string, balanceAfter: number) => ({ seq, dueDate, balanceAfter, payment: 0, principalPart: 0, interestPart: 0, status: "pending" as const, kind: "regular" as const });
    const pts = balancePoints(
      { rows: [row(1, "2026-11-15", 900), row(2, "2026-12-15", 300)], early: [{ date: "2026-12-15", principal: 200, interest: 0, balanceAfter: 700, planned: true }] },
      "2026-10-15",
      1000,
    );
    expect(pts).toEqual([
      { date: "2026-10-15", balance: 1000 },
      { date: "2026-11-15", balance: 900 },
      { date: "2026-12-15", balance: 700 },
      { date: "2026-12-15", balance: 300 },
    ]);
  });
});

describe("даты", () => {
  it("через месяц, с концом месяца", () => {
    expect(addMonths("2026-10-15", 1)).toBe("2026-11-15");
    expect(addMonths("2027-01-31", 1)).toBe("2027-02-28");
    expect(addMonths("2026-12-10", 1)).toBe("2027-01-10");
  });
});

describe("0.20: ставка за период, частота платежей, срок в днях", () => {
  it("ставка за месяц и день переводится в годовую", () => {
    expect(parseRate("18")).toBe(1800);
    expect(parseRate("1,5", "month")).toBe(1800);
    expect(parseRate("0,5", "day")).toBe(18_250);
    expect(parseRate("3", "day")).toBeNull();
    expect(rateToInput(18_250, "day")).toBe("0,5");
    expect(rateLabel(1800, "month")).toBe("1,5 % в месяц");
    expect(annualHint(18_250, "day")).toBe("≈ 182,5 % годовых");
    expect(annualHint(1800, "year")).toBeUndefined();
  });
  it("срок переводится в число платежей", () => {
    expect(monthsToPayments(24, "month")).toBe(24);
    expect(monthsToPayments(24, "quarter")).toBe(8);
    expect(monthsToPayments(10, "quarter")).toBeNull();
    expect(monthsToPayments(12, "two_weeks")).toBe(26);
    expect(paymentsText(8, "quarter")).toBe("8 платежей раз в квартал (2 года)");
    expect(paymentsText(26, "two_weeks")).toBe("26 платежей раз в две недели (≈ 1 год)");
    expect(paymentsText(24)).toBe("2 года");
  });
  it("форма передаёт период ставки и частоту платежей", () => {
    const r = toCalcInput(form({ rate: "1", ratePeriod: "month", payEvery: "quarter", rates: [{ from: "2027-01-01", rate: "0,5" }] }));
    expect(r.input).toMatchObject({ rateBp: 1200, ratePeriod: "month", payEvery: "quarter", termMonths: 8, rateChanges: [{ from: "2027-01-01", rateBp: 600 }] });
    expect(toCalcInput(form({ term: "10", termUnit: "months", payEvery: "quarter" })).error).toMatch(/кратен трём/);
  });
  it("рассчитать ставку: поле ставки не нужно, нужен платёж", () => {
    expect(toCalcInput(form({ solve: "rate", rate: "abc", payment: "" })).error).toMatch(/платёж/);
    expect(toCalcInput(form({ solve: "rate", rate: "abc", payment: "15 000" })).input).toMatchObject({ solve: "rate", rateBp: 0, payment: 1_500_000, termMonths: 24 });
  });
  it("срок в днях", () => {
    expect(daysBetween("2026-11-01", "2026-12-01")).toBe(30);
    expect(addDays("2028-02-20", 10)).toBe("2028-03-01");
    expect(daysBetween("2026-11-01", "")).toBeNull();
  });
});
