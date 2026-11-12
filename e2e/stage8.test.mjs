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

const cat = (name) => `//li[@data-testid="category-item" and @data-name="${name}"]`;

test("Р23–Р24: ключевое слово в карточке категории и объединение «Кафе» с «Общепитом»", async () => {
  await openSection(browser, "Категории");
  await click(browser, "+ Категория", '//*[@data-testid="categories-expense"]');
  await fill(browser, "name", "Кафе");
  await save(browser);
  await browser.$(cat("Кафе")).waitForExist({ timeout: 5000 });

  await click(browser, "Изменить", cat("Кафе"));
  await fill(browser, "categoryRule", "Шоколадница");
  await click(browser, "Добавить", '//*[@data-testid="category-rules"]');
  await waitCount(browser, '[data-testid="category-rule"]', 1);
  await click(browser, "Отмена", '//*[@role="dialog"]');
  await waitText(browser, '[data-testid="rules"]', /Шоколадница/);

  await click(browser, "Объединить", cat("Кафе"));
  await choose(browser, "mergeInto", "Общепит");
  await waitText(browser, '[data-testid="merge-hint"]', /перейдут в «Общепит»/);
  await click(browser, "Объединить", '//*[@role="dialog"]//form');
  await browser.waitUntil(async () => !(await browser.$(cat("Кафе")).isExisting()), { timeout: 5000, timeoutMsg: "«Кафе» осталась" });
  await waitText(browser, '//*[@data-testid="rule-row"][contains(., "Шоколадница")]', /Общепит/);
});

const line = (name) => `//tr[@data-testid="budget-line" and @data-category="${name}"]`;

test("Р9–Р11: лимит в неделю, шаблон 50/30/20, копия вперёд и вид года", async () => {
  await openSection(browser, "Бюджет");
  await click(browser, "Создать пустой");
  await choose(browser, "add-expense", "Питание");
  await fill(browser, "add-expense-limit", "10000");
  await click(browser, "Добавить", '//*[@data-testid="budget-expense"]');
  await browser.$(line("Питание")).waitForExist({ timeout: 5000 });

  // Р9: 700 ₽ в неделю → 100 ₽ в день × дней месяца.
  await choose(browser, "limitKind", "в неделю");
  await waitText(browser, '[data-testid="limit-month"]', /в месяц/);
  await fill(browser, "limit", "700");
  await (await browser.$('//main//h2[normalize-space()="Бюджет"]')).click();
  const now = new Date();
  const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  await waitText(browser, '[data-testid="limit-month"]', money(`≈ ${Math.floor(days / 10)} ${days % 10}00 ₽ в месяц`));

  // Р10: шаблон даёт три группы.
  await click(browser, "Шаблон 50/30/20", '//*[@data-testid="budget-groups"]');
  await waitCount(browser, '[data-testid="budget-group"]', 3);
  await waitText(browser, '//tr[@data-testid="budget-group" and @data-name="Обязательное"]', /50 % дохода/);

  // Р11: копия на 2 месяца вперёд и год.
  await choose(browser, "copyMonths", "2 мес.");
  await click(browser, "Скопировать", '//*[@data-testid="copy-forward"]');
  await waitText(browser, '[data-testid="copy-done"]', /создано: 2/);
  await click(browser, "Год", '//*[@data-testid="budget-mode"]');
  await browser.$('//tr[@data-testid="year-row" and @data-category="Питание"]').waitForExist({ timeout: 5000 });
  await click(browser, "Месяц", '//*[@data-testid="budget-mode"]');
  await browser.$(line("Питание")).waitForExist({ timeout: 5000 });
});
