// Оформление 0.9: тёмная тема по умолчанию, светлая по кнопке; меню по группам.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { start, stop, onboard, openSection, openSettings, selectTheme, clickControl } from "./app.mjs";
import { assertReadableInThemes } from "./contrast.mjs";

let app;
before(async () => {
  app = await start();
});
after(async () => {
  // Тема хранится в окне, а не в данных: возвращаем тёмную, чтобы не влиять на другие прогоны.
  await app?.browser.execute(() => localStorage.removeItem("p-treasury-theme")).catch(() => {});
  await stop(app?.browser);
});

const theme = (b) => b.execute(() => document.documentElement.dataset.theme);

test("по умолчанию тёмная тема, переключатель в меню выбирает светлую и обратно", async () => {
  const { browser } = app;
  await browser.execute(() => localStorage.removeItem("p-treasury-theme"));
  await browser.refresh();
  await onboard(browser, [{ name: "Карта", balance: "1000" }]);
  assert.equal(await theme(browser), "dark");
  const trigger = await browser.$('button[data-testid="theme-switch"]');
  await trigger.click();
  assert.equal(await (await browser.$('[data-testid="theme-dark"]')).getAttribute("aria-checked"), "true");
  await browser.keys("Escape");
  await browser.waitUntil(async () => (await trigger.getAttribute("aria-expanded")) === "false" && await trigger.isFocused());
  await browser.keys("Enter");
  const light = await browser.$('[data-testid="theme-light"]');
  await light.waitForDisplayed();
  await browser.keys("Home");
  assert.equal(await light.isFocused(), true);
  await browser.keys("Enter");
  assert.equal(await theme(browser), "light");
  assert.equal(await trigger.isFocused(), true);
  assert.equal(await browser.execute(() => localStorage.getItem("p-treasury-theme")), "light");
  // Выбор переживает перезагрузку окна.
  await browser.refresh();
  await browser.$('//main//h1[normalize-space()="Главная"]').waitForDisplayed({ timeout: 10000 });
  assert.equal(await theme(browser), "light");
  await selectTheme(browser, "dark");
  assert.equal(await theme(browser), "dark");
});

test("основные разделы видны в меню, Настройки закреплены рядом с быстрыми действиями", async () => {
  const { browser } = app;
  const nav = await browser.$('[data-testid="nav-list"]');
  assert.equal((await nav.$$("button[data-section]")).length, 10);
  assert.equal(await nav.$(".nav-settings").isExisting(), false);
  await browser.$(".app-nav > .nav-settings button").waitForDisplayed();
  await openSection(browser, "Бюджет");
  const hint = await browser.$("main .screen-hint").getText();
  assert.equal(hint, "Сколько можно тратить в этом месяце");
  // 0.25 «Лаконичный»: крупный заголовок без значка, значок Lucide остаётся в меню.
  assert.ok(!(await browser.$("main .screen-title .icon-tile").isExisting()));
  assert.ok(await browser.$("nav .nav-item.active .icon-tile svg.lucide").isExisting());
  const selected = await browser.$('nav button[aria-current="page"]');
  assert.equal(await selected.getAttribute("aria-label"), "Бюджет");
  await (await browser.$("main h1")).moveTo();
  await selected.moveTo();
  const tip = await browser.$('.rail-tip[role="tooltip"]');
  await tip.waitForDisplayed();
  assert.equal(await tip.getText(), "Бюджет");
});

test("шрифт интерфейса применяется к заголовку, балансу, пути базы и клавишам поиска", async () => {
  const { browser } = app;
  async function firstFamily(selector) {
    const element = await browser.$(selector);
    await element.waitForDisplayed();
    return browser.execute(node => getComputedStyle(node).fontFamily.split(",")[0].replace(/["']/g, "").trim(), element);
  }
  await openSection(browser, "Главная");
  assert.equal(await firstFamily(".brand-wordmark"), "Segoe UI Variable Text");
  assert.equal(await firstFamily("main h1"), "Segoe UI Variable Display");
  assert.equal(await firstFamily('[data-testid="explain-balance"] .money'), "Segoe UI Variable Display");

  await openSettings(browser, "about");
  await clickControl(browser, await browser.$('[data-testid="about-details"] summary'), "Технические сведения");
  assert.equal(await firstFamily('//dt[normalize-space()="Файл данных"]/following-sibling::dd[1]'), "Segoe UI Variable Text");
  await clickControl(browser, await browser.$('button[aria-label="Поиск"]'), "Поиск");
  assert.equal(await firstFamily(".palette-foot kbd"), "Segoe UI Variable Text");
  await browser.keys("Escape");
});

test("текст основной кнопки читается в светлой и тёмной темах", async () => {
  const { browser } = app;
  await openSection(browser, "Счета");
  await assertReadableInThemes(browser, "подпись основной кнопки", "main .btn.primary");
});

test("быстрая смена разделов «Пульса» оставляет один экран и один видимый штрих меню", async () => {
  const { browser } = app;
  await openSection(browser, "Главная");
  const navigation = await browser.executeAsync((done) => {
    const buttons = [...document.querySelectorAll(".app-nav button[data-section]")];
    const select = id => buttons.find(button => button.dataset.section === id).click();
    select("budget");
    setTimeout(() => select("calendar"), 20);
    setTimeout(() => select("transactions"), 40);
    setTimeout(() => {
      const active = document.querySelector(".app-nav [aria-current=page]");
      const strokes = [...document.querySelectorAll(".rail-mark")];
      done({
        section: document.querySelector("main.content").dataset.section,
        screens: document.querySelectorAll("main.content > .screen").length,
        label: active.querySelector(".rail-label").innerText,
        visible: strokes.filter(el => getComputedStyle(el).visibility === "visible").length,
        running: strokes.some(el => el.getAnimations().length > 0),
      });
    }, 350);
  });
  assert.deepEqual(navigation, { section: "transactions", screens: 1, label: "Операции", visible: 1, running: false });
});

test("три палитры меняют оформление в обеих темах и сохраняют личный акцент", async () => {
  const { browser } = app;
  await openSettings(browser, "appearance");
  const select = () => browser.$('[name="uiPalette"]');
  const accent = (value) => browser.$(`[data-testid="accent-pick"] [data-accent="${value}"]`);
  const appearance = () => browser.execute(() => {
    const root = document.documentElement;
    const style = getComputedStyle(root);
    return {
      theme: root.dataset.theme, palette: root.dataset.palette, accent: root.dataset.accent,
      card: style.getPropertyValue("--card").trim(), action: style.getPropertyValue("--accent").trim(),
    };
  });
  const original = await appearance();
  try {
    const themeSelect = await browser.$('[name="uiTheme"]');
    await themeSelect.selectByAttribute("value", "system");
    assert.match(await browser.$('[data-testid="theme-switch"]').getAttribute("aria-label"), /Как в системе/);
    await (await accent("palette")).click();
    const cards = new Set();
    for (const themeName of ["light", "dark"]) {
      await selectTheme(browser, themeName);
      assert.equal(await themeSelect.getValue(), themeName);
      const actions = new Set();
      for (const palette of ["petrol", "plum", "cobalt"]) {
        await (await select()).selectByAttribute("value", palette);
        const look = await appearance();
        assert.equal(look.theme, themeName);
        assert.equal(look.palette, palette);
        assert.equal(look.accent, "palette");
        assert.ok(look.card && look.action);
        cards.add(look.card);
        actions.add(look.action);
      }
      assert.equal(actions.size, 3);
    }
    assert.equal(cards.size, 6);
    await (await accent("mint")).click();
    await browser.$("#accent-label").click();
    const custom = await appearance();
    assert.equal(custom.accent, "mint");
    await (await select()).selectByAttribute("value", "plum");
    const chosen = await appearance();
    assert.notEqual(chosen.card, custom.card);
    assert.equal(chosen.action, custom.action);
    await browser.refresh();
    await openSettings(browser, "appearance");
    assert.deepEqual(await appearance(), chosen);
    assert.equal(await (await select()).getValue(), "plum");
    await (await accent("palette")).click();
    assert.notEqual((await appearance()).action, chosen.action);
  } finally {
    await (await select()).selectByAttribute("value", original.palette);
    await (await accent(original.accent)).click();
    await selectTheme(browser, original.theme);
  }
});
