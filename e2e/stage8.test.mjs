// Этап 8 треда 27: опции разделов, которым нужна миграция 0022+.
import { test, after, before } from "node:test";
import { start, stop, openSection, onboard, fill, choose, click, save, waitText, waitCount, money } from "./app.mjs";

let browser;
before(async () => {
  ({ browser } = await start());
  await onboard(browser, [
    { name: "Наличные", balance: "5000" },
    { name: "Карта", balance: "100000" },
  ]);
});
after(async () => {
  await stop(browser);
});

const row = (name) => `//tr[@data-testid="account-row" and @data-name="${name}"]`;
const section = (group) => `//tbody[@data-testid="account-section" and @data-group="${group}"]`;

async function editAccount(name) {
  await (await browser.$(`${row(name)}//*[@data-testid="row-menu"]`)).click();
  await click(browser, "Изменить", row(name));
  await browser.$('[role="dialog"]').waitForExist({ timeout: 5000 });
}

test("Р19–Р21: группа «Семья» с итогом, счёт не в бюджете, значок и цвет, порядок", async () => {
  await openSection(browser, "Счета");
  await (await browser.$('[data-testid="account-groups-open"]')).click();
  await fill(browser, "groupName", "Семья");
  await click(browser, "Добавить", '//*[@role="dialog"]');
  await waitCount(browser, '[data-testid="group-item"]', 1);
  await click(browser, "Готово", '//*[@role="dialog"]');

  await editAccount("Карта");
  await choose(browser, "accountGroup", "Семья");
  await (await browser.$('[name="inBudget"]')).click();
  await (await browser.$(".look-details summary")).click();
  await (await browser.$('[data-testid="icon-pick"] [data-icon="wallet"]')).click();
  await (await browser.$('[data-testid="color-pick"] [data-color="mint"]')).click();
  await save(browser);

  await waitText(browser, `${section("Семья")}//*[@data-testid="account-group-total"]`, money("100 000 ₽"));
  await waitText(browser, `${section("Семья")}${row("Карта")}`, /не в бюджете/);
  await browser.$(`${row("Карта")}//*[@data-testid="cat-mark"]`).waitForExist({ timeout: 5000 });
  await waitText(browser, `${section("")}`, /Наличные/);

  // Второй счёт в ту же группу (он заведён раньше, поэтому первый), затем «Ниже».
  await editAccount("Наличные");
  await choose(browser, "accountGroup", "Семья");
  await save(browser);
  await waitText(browser, `${section("Семья")}//*[@data-testid="account-group-total"]`, money("105 000 ₽"));
  await (await browser.$(`${row("Наличные")}//*[@data-testid="row-menu"]`)).click();
  await click(browser, "Ниже", row("Наличные"));
  await browser.waitUntil(
    async () => (await (await browser.$(`${section("Семья")}//tr[@data-testid="account-row"][1]`)).getAttribute("data-name")) === "Карта",
    { timeout: 5000, timeoutMsg: "«Наличные» не опустились" },
  );

  // Удаление группы оставляет счета без группы.
  await (await browser.$('[data-testid="account-groups-open"]')).click();
  await click(browser, "Удалить", '//*[@data-testid="group-item"]');
  await waitCount(browser, '[data-testid="group-item"]', 0);
  await click(browser, "Готово", '//*[@role="dialog"]');
  await waitCount(browser, '[data-testid="account-group"]', 0);
  await waitCount(browser, '[data-testid="account-row"]', 2);
});
