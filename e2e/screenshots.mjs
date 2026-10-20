// Скриншоты экранов для отчёта: node e2e/screenshots.mjs (под xvfb-run на Linux).
import { start, stop, onboard, openSection, fill, choose, chooseLike, click, save, setDate } from "./app.mjs";

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = (name) => new URL(`../docs/design/screens/${name}.png`, import.meta.url).pathname;
const { browser } = await start();
try {
  await browser.setWindowSize(1280, 800);
  await onboard(browser, [
    { name: "Наличные", balance: "8500" },
    { name: "Карта Сбер", balance: "64200" },
    { name: "Вклад USD", type: "Вклад / сбережения", currency: "USD", balance: "2000" },
  ]);
  const expense = async (amount, category, payee) => {
    await click(browser, "+ Расход");
    await fill(browser, "amount", amount);
    await choose(browser, "account", "Карта Сбер (₽)");
    if (payee) await fill(browser, "payee", payee);
    await choose(browser, "category", category);
    await save(browser);
  };
  await openSection(browser, "Главная");
  await click(browser, "+ Доход");
  await fill(browser, "amount", "85000");
  await choose(browser, "account", "Карта Сбер (₽)");
  await choose(browser, "category", "Зарплата");
  await save(browser);
  await expense("2340", "Продукты", "Пятёрочка");
  await expense("1890", "Кафе и рестораны", "Шоколадница");
  await expense("6230", "Жильё", "Мосэнергосбыт");
  await expense("850", "Транспорт", "Яндекс Go");
  await openSection(browser, "Настройки");
  await fill(browser, "rate", "92,15");
  await click(browser, "Добавить");
  await openSection(browser, "Бюджет");
  await click(browser, "Создать пустой");
  for (const [category, limit] of [["Продукты", "25000"], ["Кафе и рестораны", "2000"], ["Жильё", "6000"], ["Транспорт", "5000"], ["Развлечения", "4000"]]) {
    await choose(browser, "add-expense", category);
    await fill(browser, "add-expense-limit", limit);
    await click(browser, "Добавить", '//*[@data-testid="budget-expense"]');
    await browser.$(`//tr[@data-category="${category}"]`).waitForExist({ timeout: 5000 });
  }
  await choose(browser, "add-income", "Зарплата");
  await fill(browser, "add-income-limit", "85000");
  await click(browser, "Добавить", '//*[@data-testid="budget-income"]');
  await fill(browser, "budgetNote", "В ноябре день рождения мамы: отложить 5 000 на подарок");
  await (await browser.$("h1")).click();
  await browser.execute(() => document.querySelector(".content")?.scrollTo(0, 0) ?? window.scrollTo(0, 0));
  await browser.pause(500);
  await browser.saveScreenshot(out("screen-budget"));
  await openSection(browser, "Долги");
  await click(browser, "Калькулятор");
  await browser.$('[data-testid="calc-annuity"]').waitForExist({ timeout: 5000 });
  await browser.pause(400);
  await browser.saveScreenshot(out("screen-calculator"));
  await click(browser, "Сохранить как долг", '//*[@data-testid="calc-annuity"]');
  await fill(browser, "counterparty", "Т-Банк");
  await choose(browser, "account", "Карта Сбер (₽)");
  await save(browser);
  await click(browser, "Оплачено");
  await save(browser);
  await browser.pause(400);
  await browser.saveScreenshot(out("screen-debt"));
  await openSection(browser, "Долги");
  await click(browser, "+ Новый долг");
  await click(browser, "Я дал в долг", '//*[@role="dialog"]');
  await fill(browser, "counterparty", "Иван");
  await fill(browser, "principal", "20000");
  await choose(browser, "repayment", "Разовый возврат в конце");
  await setDate(browser, "maturity", `${new Date().getFullYear() + 1}-03-01`);
  await save(browser);
  await openSection(browser, "Долги");
  await browser.pause(400);
  await browser.saveScreenshot(out("screen-debts"));
  // Этап 5: напоминания, календарь, заметки.
  const pad = (n) => String(n).padStart(2, "0");
  const d = new Date();
  const ymd = (x) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
  const reminder = async (title, date, time, repeat, amount, category) => {
    await click(browser, "+ Напоминание");
    await fill(browser, "reminderTitle", title);
    await setDate(browser, "reminderDate", date);
    await setDate(browser, "reminderTime", time);
    await choose(browser, "repeat", repeat);
    if (amount) await fill(browser, "reminderAmount", amount);
    if (category) await chooseLike(browser, "reminderCategory", category);
    await save(browser);
  };
  await openSection(browser, "Календарь");
  await reminder("ЖКХ", ymd(d), "00:00", "Ежемесячно", "6000", "ЖКХ");
  await reminder("Подарок маме", `${ymd(d).slice(0, 7)}-28`, "10:00", "Ежегодно", "5000", "Подарки");
  await reminder("Интернет", ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 5)), "09:00", "Ежемесячно", "700", "Интернет и связь");
  await (await browser.$(`[data-testid="cal-day"][data-date="${ymd(d)}"] .cal-num`)).click();
  await fill(browser, "newNote", "Счётчики воды: передать до 25-го");
  await click(browser, "Добавить", '//*[@data-testid="day-panel"]');
  await browser.execute(() => document.querySelector(".content")?.scrollTo(0, 0) ?? window.scrollTo(0, 0));
  await browser.pause(500);
  await browser.saveScreenshot(out("screen-calendar"));
  await click(browser, "Напоминания");
  await browser.pause(400);
  await browser.saveScreenshot(out("screen-reminders"));
  await openSection(browser, "Заметки");
  await click(browser, "+ Заметка");
  await fill(browser, "noteBody", "Холодильник: гарантия до 10.2028, чек в ящике");
  await save(browser);
  await browser.pause(400);
  await browser.saveScreenshot(out("screen-notes"));
  // Шаблоны: «Кофе 250 ₽» и «Обед 450 ₽».
  await openSection(browser, "Главная");
  for (const [name, amount] of [["Кофе", "250"], ["Обед", "450"]]) {
    await click(browser, "+ Расход");
    await fill(browser, "amount", amount);
    await choose(browser, "account", "Карта Сбер (₽)");
    await choose(browser, "category", "Кафе и рестораны");
    await click(browser, "Сохранить как шаблон", '//*[@role="dialog"]');
    await fill(browser, "templateName", name);
    await click(browser, "Сохранить шаблон", '//*[@role="dialog"]');
    await browser.$('[data-testid="template-saved"]').waitForDisplayed({ timeout: 5000 });
    await click(browser, "Отмена", '//*[@role="dialog"]');
  }
  // Новая операция с выражением в сумме.
  await click(browser, "+ Расход");
  await fill(browser, "amount", "1890+455");
  await browser.pause(200);
  await browser.saveScreenshot(out("screen-amount-calc"));
  await click(browser, "Отмена", '//*[@role="dialog"]');
  await browser.pause(300);
  await browser.saveScreenshot(out("screen-home"));
  await (await browser.$('//*[@data-testid="template" and @data-name="Кофе"]//button')).click();
  await browser.$('[data-testid="undo-bar"]').waitForDisplayed({ timeout: 5000 });
  await browser.pause(300);
  await browser.saveScreenshot(out("screen-templates"));
  await openSection(browser, "Операции");
  await browser.pause(500);
  await browser.saveScreenshot(out("screen-transactions"));
  await click(browser, "+ Операция");
  await click(browser, "Перевод");
  await fill(browser, "amount", "92150");
  await choose(browser, "toAccount", "Вклад USD ($)");
  await fill(browser, "toAmount", "1000");
  await browser.pause(300);
  await browser.saveScreenshot(out("screen-transfer"));
  await browser.keys("Escape");
  await openSection(browser, "Отчёты");
  await (await browser.$('button[aria-label="Раскрыть"]')).click().catch(() => {});
  await browser.pause(400);
  await browser.saveScreenshot(out("screen-reports"));
  await choose(browser, "periodKind", "Год");
  await click(browser, "По месяцам");
  await browser.pause(400);
  await browser.saveScreenshot(out("screen-reports-months"));
  await openSection(browser, "Счета");
  await browser.saveScreenshot(out("screen-accounts"));
  await openSection(browser, "Категории");
  await browser.saveScreenshot(out("screen-categories"));
  await openSection(browser, "Настройки");
  await browser.saveScreenshot(out("screen-settings"));
  await browser.execute(() => document.querySelector('[data-testid="data-card"]').scrollIntoView());
  await browser.pause(200);
  await browser.saveScreenshot(out("screen-data"));
  // Импорт с ошибками: строки с ошибкой видны до загрузки.
  const csv = join(mkdtempSync(join(tmpdir(), "p-treasury-shot-")), "выписка.csv");
  writeFileSync(
    csv,
    "Дата;Тип;Счёт;Категория;Получатель;Комментарий;Сумма\n" +
      "01.10.2026;Расход;Карта Сбер;Продукты;Перекрёсток;;1 240,90\n" +
      "31.09.2026;Расход;Карта Сбер;Жильё;;;6230\n" +
      "03.10.2026;Расход;Кошелёк;Транспорт;;;350\n" +
      "05.10.2026;Доход;Карта Сбер;Зарплата;;аванс;40 000\n",
  );
  await click(browser, "Импорт из CSV");
  await browser.execute((p) => (window.__ptPick = [p]), csv);
  await click(browser, "Выбрать файл", '//*[@role="dialog"]');
  await browser.$('[data-testid="import-preview"]').waitForDisplayed({ timeout: 5000 });
  await browser.saveScreenshot(out("screen-import"));
} finally {
  await stop(browser);
}
