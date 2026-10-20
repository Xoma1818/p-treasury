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
  const item = await browser.$(`//nav//button[normalize-space()="${title}"]`);
  await item.click();
  await browser.$(`//main//h1[normalize-space()="${title}"]`).waitForDisplayed({ timeout: 5000 });
}
