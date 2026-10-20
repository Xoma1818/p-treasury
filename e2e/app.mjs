// Запуск настоящего окна приложения через tauri-driver (WebDriver) для сквозных тестов.
// Каждый вызов start() открывает приложение с чистой папкой данных.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { remote } from "webdriverio";

const ROOT = resolve(import.meta.dirname, "..");
export const APP_BIN = process.env.KAZNA_BIN ?? join(ROOT, "target/debug/budget-app");

let driver;

export async function start(dataDir = mkdtempSync(join(tmpdir(), "kazna-e2e-"))) {
  driver = spawn("tauri-driver", [], { stdio: ["ignore", "ignore", "inherit"] });
  await new Promise((r) => setTimeout(r, 1500));
  const browser = await remote({
    hostname: "127.0.0.1",
    port: 4444,
    logLevel: "error",
    capabilities: {
      "tauri:options": { application: APP_BIN, args: [`--data-dir=${dataDir}`] },
    },
  });
  return { browser, dataDir };
}

export async function stop(browser) {
  try {
    await browser?.deleteSession();
  } finally {
    driver?.kill();
  }
}

/** Нажать пункт бокового меню по названию. */
export async function openSection(browser, title) {
  // Если предыдущий тест упал с открытым диалогом, закрываем его, чтобы не ронять следующие.
  if (await browser.$('[role="dialog"]').isExisting()) await browser.keys("Escape");
  const item = await browser.$(`//nav//button[normalize-space()="${title}"]`);
  await item.click();
  await browser.$(`//main//h1[normalize-space()="${title}"]`).waitForDisplayed({ timeout: 5000 });
}

/** Поле по атрибуту name (в открытом диалоге, если он есть). */
export async function field(browser, name) {
  const dialog = await browser.$('[role="dialog"]');
  const scope = (await dialog.isExisting()) ? dialog : browser;
  return scope.$(`[name="${name}"]`);
}

export async function fill(browser, name, value) {
  const el = await field(browser, name);
  await el.waitForDisplayed({ timeout: 5000 });
  await el.clearValue();
  await el.setValue(value);
}

export async function choose(browser, name, visibleText) {
  const el = await field(browser, name);
  await el.waitForDisplayed({ timeout: 5000 });
  await el.selectByVisibleText(visibleText);
}

export async function click(browser, text, scope = "") {
  const el = await browser.$(`${scope}//button[normalize-space()="${text}"]`);
  await el.waitForClickable({ timeout: 5000 });
  await el.click();
}

/** Нажать «Сохранить» в диалоге и дождаться, что он закрылся (или вернуть текст ошибки). */
export async function save(browser, button = "Сохранить") {
  await click(browser, button, '//*[@role="dialog"]');
  const dialog = await browser.$('[role="dialog"]');
  await browser.waitUntil(async () => !(await dialog.isExisting()) || (await browser.$('[role="alert"]').isExisting()), {
    timeout: 5000,
  });
  if (await dialog.isExisting()) throw new Error(`Диалог не закрылся: ${await browser.$('[role="alert"]').getText()}`);
}

export async function mainText(browser) {
  return browser.$("main").getText();
}

/** Дождаться, пока текст элемента станет подходящим. */
export async function waitText(browser, selector, re, timeout = 5000) {
  let last = "";
  await browser
    .waitUntil(
      async () => {
        const el = await browser.$(selector);
        last = (await el.isExisting()) ? await el.getText() : "";
        return re.test(last);
      },
      { timeout },
    )
    .catch(() => {
      throw new Error(`Текст ${selector} не совпал с ${re}: «${last}»`);
    });
  return last;
}

/** Пройти мастер первого запуска: rows = [{ name, type?, currency?, balance }]. */
export async function onboard(browser, rows, { categories = true } = {}) {
  await browser.$("//h1[normalize-space()='Основная валюта']").waitForDisplayed({ timeout: 15000 });
  await click(browser, "Далее");
  // В мастере два счёта по умолчанию: подгоняем их число под rows.
  for (let i = 2; i < rows.length; i++) await click(browser, "+ Добавить счёт");
  for (let i = rows.length; i < 2; i++) await (await browser.$$('button[aria-label="Убрать счёт"]'))[rows.length].click();
  for (const [i, r] of rows.entries()) {
    await fill(browser, `account-name-${i}`, r.name);
    if (r.type) await choose(browser, `account-type-${i}`, r.type);
    if (r.currency) await choose(browser, `account-currency-${i}`, r.currency);
    await fill(browser, `account-balance-${i}`, r.balance);
  }
  await click(browser, "Далее");
  if (!categories) await (await field(browser, "defaultCategories")).click();
  await click(browser, "Начать");
  await browser.$('//main//h1[normalize-space()="Главная"]').waitForDisplayed({ timeout: 10000 });
}

/** Регулярка для суммы вида «14 977,23 ₽»: пробелы в образце совпадают с любыми пробелами. */
export function money(text) {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped.replace(/ /g, "[\\s\\u00A0]"));
}
