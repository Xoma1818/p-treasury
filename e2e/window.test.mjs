// Окно как у пользователя (тред 26, этап 3б): несохранённая форма, порядок Tab,
// маленькое окно (масштаб Windows 125–150 %), уменьшение движения.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import {
  start,
  stop,
  onboard,
  openSection,
  fill,
  click,
  chooseLike,
  waitText,
  money,
} from "./app.mjs";

let app;
before(async () => {
  app = await start();
  await onboard(app.browser, [{ name: "Карта", balance: "10000" }]);
});
after(async () => {
  await stop(app?.browser);
});

const dialog = '[role="dialog"]';
const ask = '[data-testid="unsaved-ask"]';
const askButton = (text) =>
  `//*[@data-testid="unsaved-ask"]//button[normalize-space()="${text}"]`;
const isOpen = (b) => b.$(dialog).isExisting();

async function newExpense(browser) {
  await openSection(browser, "Операции");
  await click(browser, "+ Операция");
  await browser
    .$(`${dialog} [name="amount"]`)
    .waitForDisplayed({ timeout: 5000 });
}

test("Esc в форме с введённой суммой спрашивает, закрыть ли без сохранения", async () => {
  const { browser } = app;
  // Пустая форма закрывается сразу.
  await newExpense(browser);
  await browser.keys("Escape");
  await browser.$(dialog).waitForExist({ reverse: true, timeout: 3000 });

  await newExpense(browser);
  await fill(browser, "amount", "123");
  await browser.keys("Escape");
  await browser.$(ask).waitForDisplayed({ timeout: 3000 });
  assert.ok(await isOpen(browser), "форма не закрылась");
  // Второй Esc возвращает к вводу, сумма на месте.
  await browser.keys("Escape");
  await browser.$(ask).waitForExist({ reverse: true, timeout: 3000 });
  assert.equal(
    await (await browser.$(`${dialog} [name="amount"]`)).getValue(),
    "123",
  );
  // «×» тоже спрашивает; «Продолжить ввод» оставляет форму.
  await (await browser.$(`${dialog} button[aria-label="Закрыть"]`)).click();
  await (await browser.$(askButton("Продолжить ввод"))).click();
  assert.ok(await isOpen(browser));
  // «Закрыть» в вопросе закрывает без сохранения.
  await browser.keys("Escape");
  await (await browser.$(askButton("Закрыть"))).click();
  await browser.$(dialog).waitForExist({ reverse: true, timeout: 3000 });
  await openSection(browser, "Главная");
  await waitText(browser, '[data-testid="total-balance"]', money("10 000 ₽"));
});

test("«Отмена» закрывает форму сразу, без вопроса", async () => {
  const { browser } = app;
  await newExpense(browser);
  await fill(browser, "amount", "50");
  await (
    await browser.$(`//*[@role="dialog"]//button[normalize-space()="Отмена"]`)
  ).click();
  await browser.$(dialog).waitForExist({ reverse: true, timeout: 3000 });
});

test("Tab идёт по полям формы по порядку, фокус виден, Enter сохраняет", async () => {
  const { browser } = app;
  await newExpense(browser);
  const active = () =>
    browser.execute(() => {
      const el = document.activeElement;
      return {
        name: el?.getAttribute("name") ?? "",
        inDialog: !!el?.closest('[role="dialog"]'),
        ring: el ? getComputedStyle(el).boxShadow : "none",
      };
    });
  const first = await active();
  assert.equal(first.name, "amount", "фокус сразу в сумме");
  assert.notEqual(first.ring, "none", "у поля в фокусе видна рамка");
  const order = ["amount"];
  for (let i = 0; i < 30 && order.length < 6; i++) {
    await browser.keys("Tab");
    const a = await active();
    assert.ok(a.inDialog, "Tab не уходит из окна формы за его пределы");
    if (a.name && a.name !== order.at(-1)) order.push(a.name);
  }
  const expected = ["amount", "date", "account", "payee", "category"];
  const seen = order.filter((n) => expected.includes(n));
  assert.deepEqual(
    seen,
    expected.slice(0, seen.length),
    `порядок: ${order.join(" → ")}`,
  );
  assert.ok(seen.length >= 4, `Tab прошёл поля: ${order.join(" → ")}`);

  await chooseLike(browser, "category", "Питание");
  await (await browser.$(`${dialog} [name="amount"]`)).click();
  await fill(browser, "amount", "123");
  await browser.keys("Enter");
  const closed = await browser
    .$(dialog)
    .waitForExist({ reverse: true, timeout: 5000 })
    .catch(() => false);
  if (!closed) {
    const text = await (await browser.$(dialog)).getText();
    assert.fail(`Enter не сохранил форму: ${text.slice(0, 300)}`);
  }
  await openSection(browser, "Главная");
  await waitText(browser, '[data-testid="total-balance"]', money("9 877 ₽"));
});

test("маленькое окно (как масштаб 150 %): ни в одном разделе нет прокрутки вбок, форма помещается", async (t) => {
  const { browser } = app;
  await openSection(browser, "Главная"); // закрывает окно, оставшееся от прошлого теста
  const before = await browser.getWindowSize();
  try {
    await browser.setWindowSize(1024, 640);
  } catch (e) {
    t.skip(`размер окна не меняется: ${e.message.split("\n")[0]}`);
    return;
  }
  try {
    const inner = await browser.execute(() => [innerWidth, innerHeight]);
    if (inner[0] > 1100)
      return t.skip(`окно не уменьшилось: ${inner.join("×")}`);
    const titles = await browser.execute(() =>
      [...document.querySelectorAll("nav button.nav-item:not(.nav-view)")]
        .map((b) => b.textContent.trim())
        .filter(Boolean),
    );
    const wide = [];
    for (const title of titles) {
      const h1 = await browser.$(`//main//h1[normalize-space()="${title}"]`);
      await (
        await browser.$(`//nav//button[normalize-space()="${title}"]`)
      ).click();
      if (!(await h1.waitForDisplayed({ timeout: 5000 }).catch(() => false)))
        continue; // кнопка меню без раздела
      await browser.pause(150);
      const over = await browser.execute(() => {
        const doc = document.documentElement;
        const main = document.querySelector("main");
        const out = [];
        if (doc.scrollWidth > innerWidth + 1)
          out.push(`страница ${doc.scrollWidth} > ${innerWidth}`);
        if (main && main.scrollWidth > main.clientWidth + 1)
          out.push(`main ${main.scrollWidth} > ${main.clientWidth}`);
        return out;
      });
      if (over.length) wide.push(`${title}: ${over.join(", ")}`);
    }
    assert.deepEqual(wide, [], "прокрутка вбок");

    await newExpense(browser);
    const fit = await browser.execute(() => {
      const m = document.querySelector('[role="dialog"]');
      const r = m.getBoundingClientRect();
      return {
        top: r.top,
        bottom: r.bottom,
        right: r.right,
        h: innerHeight,
        w: innerWidth,
        scrolls: m.scrollHeight > m.clientHeight,
      };
    });
    assert.ok(
      fit.top >= 0 && fit.right <= fit.w + 1,
      `окно формы вылезает: ${JSON.stringify(fit)}`,
    );
    assert.ok(
      fit.bottom <= fit.h + 1 || fit.scrolls,
      `низ формы недоступен: ${JSON.stringify(fit)}`,
    );
    const saveBtn = await browser.$(
      `//*[@role="dialog"]//button[normalize-space()="Сохранить"]`,
    );
    await saveBtn.scrollIntoView({ block: "nearest" });
    assert.ok(
      await saveBtn.isDisplayedInViewport(),
      "кнопка «Сохранить» достижима",
    );
    await (
      await browser.$(`//*[@role="dialog"]//button[normalize-space()="Отмена"]`)
    ).click();
  } finally {
    await browser.setWindowSize(before.width, before.height).catch(() => {});
  }
});

test("уменьшение движения: правило для prefers-reduced-motion гасит анимации и переходы", async () => {
  const { browser } = app;
  const rules = await browser.execute(() => {
    const found = [];
    for (const sheet of document.styleSheets) {
      let list;
      try {
        list = sheet.cssRules;
      } catch {
        continue;
      }
      for (const r of list)
        if (
          r.media &&
          /prefers-reduced-motion:\s*reduce/.test(r.media.mediaText)
        )
          found.push(r.cssText);
    }
    return found.join("\n");
  });
  assert.match(
    rules,
    /\*[^{]*\{[^}]*animation-duration:\s*1ms[^}]*transition-duration:\s*1ms/,
    "общее правило для всех элементов",
  );
});
