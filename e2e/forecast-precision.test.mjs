// Одна учебная база, реальные действия ввода в окне Tauri.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { choose, click, fill, money, onboard, openSection, save, setDate, start, stop, waitText } from "./app.mjs";

let browser;
before(async () => {
  ({ browser } = await start());
  await onboard(browser, [{ name: "Карта", balance: "100000" }]);
});
after(async () => { await stop(browser); });

async function pointerAt(element, endElement = element) {
  const coords = (node) => {
    const rect = node.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  };
  await browser.execute((node) => node.closest("svg").scrollIntoView({ block: "center", behavior: "instant" }), element);
  const from = await browser.execute(coords, element);
  const to = await browser.execute(coords, endElement);
  try {
    await browser.performActions([{ type: "pointer", id: "chart-mouse", parameters: { pointerType: "mouse" }, actions: [
      { type: "pointerMove", duration: 0, origin: "viewport", ...from }, { type: "pointerDown", button: 0 },
      { type: "pointerMove", duration: 180, origin: "viewport", ...to }, { type: "pointerUp", button: 0 },
    ] }]);
  } finally {
    await browser.releaseActions();
  }
}

async function keysOn(element, ...keys) {
  await browser.execute((node) => node.focus(), element);
  for (const key of keys) await browser.keys(key);
}

test("ползунок и указатель выбирают один расчётный месяц и точный остаток сценария", async () => {
  await openSection(browser, "Взгляд вперёд");
  await click(browser, "+ Сценарий");
  await click(browser, "Ипотека или кредит", '//*[@role="dialog"]');
  await save(browser);
  const readout = '[data-testid="fc-period-readout"]';
  const slider = await browser.$('[data-testid="fc-month-slider"]');
  await waitText(browser, '[data-testid="fc-end"]', money("−395 000 ₽"));
  await keysOn(slider, "Home", "ArrowRight", "ArrowRight");
  await waitText(browser, readout, money("55 000 ₽"));
  const selected = await slider.getAttribute("aria-valuetext");
  assert.match(selected, money("100 000 ₽"));
  assert.match(selected, money("55 000 ₽"));
  await keysOn(slider, "End");
  await waitText(browser, readout, money("−395 000 ₽"));
  const dots = await browser.$$('[data-testid="fc-chart"] circle.nw-dot');
  await pointerAt(dots[12], dots[2]);
  assert.equal(await slider.getValue(), "2");
  assert.equal(await slider.getAttribute("aria-valuetext"), selected);
  await (await browser.$('[data-testid="hide-amounts"]')).click();
  await waitText(browser, readout, /•••/);
  await keysOn(slider, "Home", "ArrowRight", "ArrowRight", "ArrowRight");
  assert.equal(await slider.getValue(), "3");
  assert.match(await slider.getAttribute("aria-valuetext"), /Сумма скрыта/);
  assert.doesNotMatch(await slider.getAttribute("aria-valuetext"), /₽/);
  assert.doesNotMatch(await (await browser.$(readout)).getText(), /₽/);
  await (await browser.$('[data-testid="hide-amounts"]')).click();
});

test("выбор дня на ступенчатом графике совпадает с клавиатурой до и после платежа", async () => {
  await openSection(browser, "Займы и долги");
  await click(browser, "Калькулятор");
  await fill(browser, "principal", "12000");
  await fill(browser, "rate", "0");
  await choose(browser, "termUnit", "месяцев");
  await fill(browser, "term", "3");
  await setDate(browser, "issueDate", "2026-11-14");
  await setDate(browser, "firstPayment", "2026-11-15");
  const readout = '[data-testid="loan-chart-readout"]';
  await waitText(browser, readout, money("12 000 ₽"));
  const slider = await browser.$('[aria-label="Дата остатка долга"]');
  await keysOn(slider, "Home", "ArrowRight");
  await waitText(browser, readout, money("8 000 ₽"));
  const cursor = await browser.$('[data-testid="loan-chart"] .hover line');
  // Оставляем указатель на первом платёжном дне; отпускание не переводит выбор в соседний день.
  await pointerAt(cursor);
  assert.equal(await slider.getValue(), "1");
  assert.match(await slider.getAttribute("aria-valuetext"), /15\.11\.2026/);
  await keysOn(slider, "ArrowLeft");
  await waitText(browser, readout, money("12 000 ₽"));
  assert.match(await slider.getAttribute("aria-valuetext"), /14\.11\.2026/);
});
