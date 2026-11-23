import { describe, expect, it } from "vitest";
import type { Occurrence } from "./api";
import { occurrenceStatus } from "./occurrenceStatus";

const planned: Occurrence = {
  amountCurrency: "RUB",
  key: { source: "reminder", refId: "internet", scheduledAt: "2026-11-22T18:00" },
  title: "Интернет", status: "pending", amount: 79000, currencySymbol: "₽", minorUnits: 2,
  txnType: "expense", accountId: "card", categoryId: null, note: null, debtId: null,
  dueAt: "2026-11-22T18:00", payAt: "2026-11-22T18:00", dueDate: null,
  notifiedAt: null, completedAt: null, transactionId: null, actualPayment: null,
  edited: false, last: false, leadDays: [], shortfall: null,
};

describe("статус в календаре", () => {
  it("при напоминании заранее платёж по долгу не просрочен вплоть до конца дня выплаты", () => {
    const debt = {
      ...planned, key: { ...planned.key, source: "debt" as const }, debtId: "loan",
      dueAt: "2026-11-19T09:00", payAt: "2026-11-22T09:00", dueDate: "2026-11-22",
    };
    expect(occurrenceStatus(debt, "2026-11-20T11:00").state).toBe("planned");
    expect(occurrenceStatus(debt, "2026-11-22T23:59").state).toBe("planned");
    expect(occurrenceStatus(debt, "2026-11-23T00:00").state).toBe("overdue");
  });

  it("учитывает новый срок одного перенесённого платежа серии", () => {
    const moved = { ...planned, edited: true, dueAt: "2026-11-25T18:00", payAt: "2026-11-25T18:00" };
    expect(occurrenceStatus(moved, "2026-11-23T11:00").state).toBe("planned");
    expect(occurrenceStatus(moved, "2026-11-26T11:00").state).toBe("overdue");
  });

  it("отсрочка напоминания не переносит сам просроченный платёж", () => {
    const snoozed = { ...planned, status: "snoozed" as const, dueAt: "2026-11-26T09:00" };
    const status = occurrenceStatus(snoozed, "2026-11-23T11:00");
    expect(status.label).toMatch(/просрочен/i);
    expect(status.label).toMatch(/отложено/i);
  });

  it("считает платёж связанным, когда известна запись, созданная из календаря или выбранная в журнале", () => {
    const done = { ...planned, status: "done" as const };
    for (const linkedActual of [true, false]) {
      expect(occurrenceStatus({ ...done, transactionId: "txn", linkedActual }, planned.payAt).state).toBe("linked");
    }
    expect(occurrenceStatus(done, planned.payAt).state).toBe("done");
  });
});
