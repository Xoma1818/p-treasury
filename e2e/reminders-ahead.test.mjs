// «Напоминания и платежи наперёд» (0.23): серия на N раз с последним платежом другой суммы,
// проверка денег на счёте, правка одного платежа, напоминание у заметки и сроки «заранее» в Настройках.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { start, stop, openSection, onboard, fill, choose, chooseLike, click, save, waitText, money, setDate, openMore } from "./app.mjs";

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const now = new Date();
const inDays = (n) => iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + n));

let browser;
before(async () => {
  ({ browser } = await start());
  await onboard(browser, [
    { name: "Наличные", balance: "0" },
    { name: "Карта", balance: "100000" },
  ]);
});
after(async () => {
  await stop(browser);
});

const occ = (title) => `//*[@data-testid="rem-upcoming"]//li[@data-testid="occurrence" and @data-title="${title}"]`;
const lastDialog = '(//*[@role="dialog"])[last()]';

async function invoke(command, args = {}) {
  const result = await browser.executeAsync((cmd, input, done) => {
    window.__TAURI_INTERNALS__.invoke(cmd, input).then((value) => done({ value }), (error) => done({ error: String(error) }));
  }, command, args);
  assert.equal(result.error, undefined, `${command}: ${result.error}`);
  return result.value;
}

async function cardEntries(title) {
  const card = (await invoke("list_accounts", { includeArchived: false })).find((a) => a.name === "Карта");
  const page = await invoke("list_transactions", { filter: { accountId: card.id, search: title, limit: 10 } });
  return { balance: card.balance, total: page.total, entries: page.items.map(({ id, note }) => ({ id, note })).sort((a, b) => a.id.localeCompare(b.id)) };
}

async function openReminders() {
  await openSection(browser, "Календарь");
  await click(browser, "Напоминания");
  await browser.$('[data-testid="rem-all"]').waitForDisplayed({ timeout: 5000 });
}

test("рассрочка: 3 платежа по 5 000 ₽, последний 2 000 ₽ — конец серии считается сам", async () => {
  await openReminders();
  await click(browser, "+ Напоминание");
  await fill(browser, "reminderTitle", "Рассрочка");
  await setDate(browser, "reminderDate", inDays(3));
  await choose(browser, "repeat", "Ежемесячно");
  await choose(browser, "reminderEndMode", "Несколько раз");
  await fill(browser, "reminderCount", "3");
  await fill(browser, "reminderAmount", "5000");
  await fill(browser, "reminderLastAmount", "2000");
  await save(browser);
  await waitText(browser, occ("Рассрочка"), money("5 000 ₽"));
  // Правка серии показывает дату конца — третий месяц.
  await (await browser.$('//*[@data-testid="rem-all"]//span[@class="main" and normalize-space()="Рассрочка"]')).click();
  await (await browser.$('[name="reminderEndMode"]')).waitForDisplayed({ timeout: 5000 });
  assert.equal(await (await browser.$('[name="reminderEndMode"]')).getValue(), "date");
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3);
  const last = new Date(d.getFullYear(), d.getMonth() + 2, 1);
  assert.match(await (await browser.$('[name="reminderEnd"]')).getValue(), new RegExp(`^${iso(last).slice(0, 7)}`));
  assert.equal((await (await browser.$('[name="reminderLastAmount"]')).getValue()).replace(/\s/g, ""), "2000");
  await click(browser, "Отмена", '//*[@role="dialog"]');
});

test("аренда 150 000 ₽ с карты через 2 дня: видно, что не хватит 50 000 ₽; после правки платежа — хватает", async () => {
  await openReminders();
  await click(browser, "+ Напоминание");
  await fill(browser, "reminderTitle", "Аренда");
  await setDate(browser, "reminderDate", inDays(2));
  await choose(browser, "repeat", "Ежемесячно");
  await fill(browser, "reminderAmount", "150000");
  await choose(browser, "reminderAccount", "Карта (₽)");
  await chooseLike(browser, "reminderCategory", "Коммунальные платежи");
  await save(browser);
  await waitText(browser, `${occ("Аренда")}//*[@data-testid="shortfall"]`, money("50 000 ₽"));
  const before = await cardEntries("Аренда");

  // Только этот платёж — 80 000 ₽ и на день позже.
  await click(browser, "Ещё", occ("Аренда"));
  await click(browser, "Изменить", occ("Аренда"));
  await fill(browser, "occAmount", "80000");
  await setDate(browser, "occDate", inDays(3));
  await save(browser);
  await waitText(browser, occ("Аренда"), /изменён/);
  await waitText(browser, occ("Аренда"), money("80 000 ₽"));
  await browser.waitUntil(async () => !(await browser.$(`${occ("Аренда")}//*[@data-testid="shortfall"]`).isExisting()), { timeout: 5000 });
  await click(browser, "Ещё", occ("Аренда"));
  await click(browser, "Отметить выполненным без записи", occ("Аренда"));
  const done = '[data-testid="rem-done"] [data-title="Аренда"]';
  await browser.$(`${done} [data-testid="occ-status"][data-state="done"]`).waitForDisplayed();
  assert.equal(await browser.$(`${done} [data-testid="occ-open-transaction"]`).isExisting(), false);
  assert.equal((await invoke("reminders_overview")).done.find((item) => item.title === "Аренда").transactionId, null);
  assert.deepEqual(await cardEntries("Аренда"), before);
  await openSection(browser, "Операции");
  await fill(browser, "search", "Аренда");
  await waitText(browser, '[data-testid="txn-count"]', /Показано 0 из 0/);
});

test("заметка «Продлить страховку»: напоминание за неделю прямо из заметки", async () => {
  await openSection(browser, "Заметки");
  await click(browser, "+ Заметка");
  await fill(browser, "noteBody", "Продлить страховку");
  await setDate(browser, "noteDate", inDays(20));
  await save(browser);
  await (await browser.$('//*[@data-testid="note"][contains(., "Продлить страховку")]')).click();
  await click(browser, "Напомнить…", '//*[@role="dialog"]');
  await browser.waitUntil(async () => (await browser.$$('[role="dialog"]')).length === 2, { timeout: 5000 });
  assert.equal(await (await browser.$(`${lastDialog}//*[@name="reminderTitle"]`)).getValue(), "Продлить страховку");
  await (await browser.$(`${lastDialog}//*[@name="reminderLeadMode"]`)).selectByVisibleText("Свои сроки");
  await click(browser, "за 3 дня", lastDialog);
  await click(browser, "за день", lastDialog);
  await click(browser, "за неделю", lastDialog);
  await click(browser, "Сохранить", lastDialog);
  await browser
    .waitUntil(async () => (await browser.$$('[role="dialog"]')).length <= 1, { timeout: 5000 })
    .catch(async () => {
      const alert = await browser.$('[role="alert"]');
      throw new Error(`напоминание не сохранилось: ${(await alert.isExisting()) ? await alert.getText() : "диалогов " + (await browser.$$('[role="dialog"]')).length}`);
    });
  if ((await browser.$$('[role="dialog"]')).length) await click(browser, "Отмена", '//*[@role="dialog"]');
  await (await browser.$('[data-testid="notes"] [aria-label="Есть напоминание"]')).waitForExist({ timeout: 5000 });

  await openReminders();
  await waitText(browser, '[data-testid="rem-all"]', /Продлить страховку.*за неделю.*из заметки/s);
});

test("Настройки: сроки «заранее» по умолчанию и проверка денег", async () => {
  await openSection(browser, "Настройки");
  const picker = '//*[@data-testid="defaultLeadDays"]';
  await (await browser.$(picker)).waitForDisplayed({ timeout: 5000 });
  await click(browser, "за неделю", picker);
  await browser.waitUntil(async () => (await (await browser.$(`${picker}//button[normalize-space()="за неделю"]`)).getAttribute("aria-pressed")) === "true", { timeout: 5000 });
  await choose(browser, "fundsDays", "за 5 дней");
  await openReminders();
  await click(browser, "+ Напоминание");
  const opt = await browser.execute(() => document.querySelector('[name="reminderLeadMode"] option[value="default"]').textContent);
  assert.match(opt, /за неделю, за 3 дня, за день/);
  await click(browser, "Отмена", '//*[@role="dialog"]');
});

test("напоминание связывается с проведённым списанием без второй операции", async () => {
  await openSection(browser, "Главная");
  await click(browser, "+ Расход");
  await fill(browser, "amount", "450");
  await choose(browser, "account", "Карта (₽)");
  await chooseLike(browser, "category", "Коммунальные платежи");
  await fill(browser, "payee", "Контрольный интернет");
  await save(browser);

  await openReminders();
  await click(browser, "+ Напоминание");
  await fill(browser, "reminderTitle", "Контрольный интернет");
  await setDate(browser, "reminderDate", inDays(1));
  await choose(browser, "repeat", "Ежемесячно");
  await fill(browser, "reminderAmount", "500");
  await choose(browser, "reminderAccount", "Карта (₽)");
  await chooseLike(browser, "reminderCategory", "Коммунальные платежи");
  await save(browser);
  await click(browser, "Учесть платёж", occ("Контрольный интернет"));
  await waitText(browser, '[data-testid="occ-match-candidate"]', money("450 ₽"));
  await waitText(browser, '[data-testid="occ-match-candidate"]', /Карта/);
  await waitText(browser, '[data-testid="occ-match-candidate"]', /Сумма отличается/);
  await save(browser, "Связать с платежом");
  await waitText(browser, '[data-testid="rem-done"]', /Контрольный интернет[\s\S]*связано с операцией/);

  await openSection(browser, "Операции");
  await fill(browser, "search", "Контрольный интернет");
  await waitText(browser, '[data-testid="txn-count"]', /Показано 1 из 1/);
});

test("два равных списания: календарь привязывает и дважды открывает выбранную операцию без изменения остатка", async () => {
  const title = "Проверка выбора платежа";
  const firstNote = "По квитанции А: 872 ₽";
  const secondNote = "По квитанции Б: 872 ₽";
  await openSection(browser, "Главная");
  for (const note of [firstNote, secondNote]) {
    await click(browser, "+ Расход");
    await fill(browser, "amount", "872");
    await choose(browser, "account", "Карта (₽)");
    await chooseLike(browser, "category", "Коммунальные платежи");
    await fill(browser, "payee", title);
    if (!(await browser.$('[role="dialog"] [name="note"]').isDisplayed())) await openMore(browser);
    await fill(browser, "note", note);
    await save(browser);
  }
  const before = await cardEntries(title);
  assert.equal(before.total, 2);
  const selected = before.entries.find((item) => item.note === secondNote).id;

  await openReminders();
  await click(browser, "+ Напоминание");
  await fill(browser, "reminderTitle", title);
  await setDate(browser, "reminderDate", inDays(1));
  await choose(browser, "repeat", "Ежемесячно");
  await fill(browser, "reminderAmount", "900");
  await choose(browser, "reminderAccount", "Карта (₽)");
  await chooseLike(browser, "reminderCategory", "Коммунальные платежи");
  await save(browser);
  await browser.$(`${occ(title)}//*[@data-testid="occ-status" and @data-state="planned"]`).waitForDisplayed();
  await click(browser, "Учесть платёж", occ(title));
  const match = (note) => `//*[@data-testid="occ-match-candidate" and contains(., "${note}")]`;
  await waitText(browser, match(firstNote), money("872 ₽"));
  await waitText(browser, match(secondNote), money("872 ₽"));
  const radioSelector = '[data-testid="occ-match-candidate"] input[type="radio"]';
  const accessibleNames = async () => {
    const names = [];
    for (const radio of await browser.$$(radioSelector)) names.push(await radio.getComputedLabel());
    return names;
  };
  const namesShown = await accessibleNames();
  assert.ok(namesShown.every((name) => name.includes("Карта")));
  assert.equal(namesShown.length, 2);
  assert.ok(namesShown.every((name) => money("872 ₽").test(name)));
  assert.ok(namesShown.some((name) => name.includes(firstNote)));
  assert.ok(namesShown.some((name) => name.includes(secondNote)));
  await browser.keys(["Control", "h"]);
  await waitText(browser, '[data-testid="occ-match-candidate"]', /•••/);
  const namesHidden = await accessibleNames();
  assert.equal(namesHidden.length, 2);
  assert.equal(new Set(namesHidden).size, 2, "одноимённые платежи остаются различимыми для диктора");
  for (const name of namesHidden) {
    assert.match(name, /сумма скрыта/i);
    assert.doesNotMatch(name, /871|872|900|₽|По квитанции/);
  }
  assert.doesNotMatch(await browser.$(lastDialog).getText(), /871|872|900|₽|По квитанции/);
  await browser.keys(["Control", "h"]);
  await waitText(browser, match(secondNote), money("872 ₽"));
  assert.deepEqual(await accessibleNames(), namesShown);
  assert.equal(await (await browser.$(`${lastDialog}//button[normalize-space()="Связать с платежом"]`)).isEnabled(), false);
  await click(browser, "Записать отдельный расход", lastDialog);
  await waitText(browser, '[data-testid="reminder-save-impact"]', /добавит отдельную запись/);
  await click(browser, "Назад", lastDialog);
  await waitText(browser, match(secondNote), money("872 ₽"));
  await (await browser.$(`${match(secondNote)}//input[@type="radio"]`)).click();
  const controls = await browser.execute(() => {
    const footer = document.querySelector(".payment-review-actions");
    return [...footer.querySelectorAll("button")].map((button) => ({
      label: button.textContent.trim(),
      clipped: button.scrollWidth > button.clientWidth + 1,
      rightGap: footer.getBoundingClientRect().right - button.getBoundingClientRect().right,
    }));
  });
  assert.deepEqual(controls.map((button) => button.label), ["Назад", "Записать отдельный расход", "Связать с платежом"]);
  assert.ok(controls.every((button) => !button.clipped), "подписи кнопок помещаются");
  assert.ok(Math.abs(controls.at(-1).rightGap) <= 1, "главное действие прилегает к правому краю даже при переносе");
  for (const button of controls) {
    await browser.keys("Tab");
    assert.equal(await browser.execute(() => document.activeElement.textContent.trim()), button.label);
  }
  await save(browser, "Связать с платежом");
  const occurrence = `[data-title="${title}"]`;
  const linked = async () => (await invoke("reminders_overview")).done.find((item) => item.title === title);
  await browser.$(`[data-testid="rem-done"] ${occurrence} [data-testid="occ-status"][data-state="linked"]`).waitForDisplayed();
  assert.equal((await linked()).transactionId, selected);
  for (const area of ["rem-done", "day-panel"]) {
    if (area === "day-panel") {
      await click(browser, "Месяц");
      const payDate = inDays(1);
      if (payDate.slice(0, 7) !== inDays(0).slice(0, 7)) await browser.$('[aria-label="Следующий месяц"]').click();
      const day = await browser.$(`[data-testid="cal-day"][data-date="${payDate}"]`);
      await day.waitForDisplayed();
      await browser.execute((button) => button.focus(), day);
      await browser.keys("Enter");
    }
    const trigger = await browser.$(`[data-testid="${area}"] ${occurrence} [data-testid="occ-open-transaction"]`);
    await trigger.waitForDisplayed();
    await browser.execute((button) => button.focus(), trigger);
    await browser.keys("Enter");
    const detail = '[role="dialog"] [data-testid="linked-transaction"]';
    await browser.$(detail).waitForDisplayed();
    assert.equal(await browser.$(detail).getAttribute("data-transaction-id"), selected);
    await waitText(browser, detail, money("872 ₽"));
    await browser.keys(["Control", "h"]);
    await waitText(browser, detail, /•••/);
    assert.doesNotMatch(await browser.$(lastDialog).getText(), /872|₽|По квитанции/);
    await browser.keys(["Control", "h"]);
    await waitText(browser, detail, money("872 ₽"));
    await browser.keys("Escape");
    await browser.waitUntil(() => trigger.isFocused(), { timeout: 5000 });
    assert.equal((await linked()).transactionId, selected);
    assert.deepEqual(await cardEntries(title), before);
  }

  await openSection(browser, "Операции");
  await fill(browser, "search", title);
  await waitText(browser, '[data-testid="txn-count"]', /Показано 2 из 2/);
});
