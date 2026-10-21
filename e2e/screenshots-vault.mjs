// Скриншоты папки сохранности 0.13: node e2e/screenshots-vault.mjs <папка> (под xvfb-run).
import { start, stop, openSection, click } from "./app.mjs";
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dir = resolve(process.argv[2] ?? "screens");
mkdirSync(dir, { recursive: true });
const shot = (b, name) => b.saveScreenshot(join(dir, `${name}.png`));

// Старый компьютер: пример данных, папка сохранности.
let { browser, dataDir } = await start();
try {
  await browser.setWindowSize(1280, 900);
  await browser.$("//h1[normalize-space()='Основная валюта']").waitForDisplayed({ timeout: 15000 });
  await click(browser, "Посмотреть на примере");
  await browser.$('//main//h1[normalize-space()="Главная"]').waitForDisplayed({ timeout: 10000 });
  await openSection(browser, "Настройки");
  await click(browser, "Сохранить сейчас");
  await browser.pause(1500);
  await browser.$('[data-testid="backup-card"]').scrollIntoView();
  await browser.pause(400);
  await shot(browser, "settings-vault");
  await click(browser, "Сменить папку");
  await browser.pause(500);
  await shot(browser, "vault-place");
} finally {
  await stop(browser);
}

// Новый компьютер: папку скопировали в «Документы».
const fresh = mkdtempSync(join(tmpdir(), "p-treasury-shot-"));
cpSync(join(dataDir, "P-Treasury"), join(fresh, "P-Treasury"), { recursive: true });
({ browser } = await start(fresh));
try {
  await browser.setWindowSize(1280, 900);
  await browser.$('[data-testid="transfer-offer"]').waitForDisplayed({ timeout: 15000 });
  await browser.pause(800);
  await shot(browser, "onboarding-transfer");
  await click(browser, "Перенести данные");
  await browser.$('[data-testid="found-list"]').waitForDisplayed({ timeout: 5000 });
  await browser.pause(400);
  await shot(browser, "transfer-found");
} finally {
  await stop(browser);
}
