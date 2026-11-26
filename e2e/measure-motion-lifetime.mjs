// Отдельный замер Windows: PTREASURY_VOLUME_DIR содержит вымышленную budget.db за десять лет.
// Запуск: node e2e/measure-motion-lifetime.mjs. Полный отчёт JSON печатается в stdout.
// Контроль: PTREASURY_MOTION_INPUT=dom и при необходимости PTREASURY_MOTION_INTERVAL_MS
// в миллисекундах. Обычный вариант использует настоящие команды мыши и клавиатуры WebDriver.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { APP_BIN, minimizeTestWindow, openFilters, openSection, start, stop, testWindowMemory, WIN } from "./app.mjs";

const source = process.env.PTREASURY_VOLUME_DIR;
if (!WIN || !source) throw Error("Для замера нужны Windows и PTREASURY_VOLUME_DIR с учебной базой.");
const fixture = join(source, "budget.db");
if (existsSync(fixture + "-wal") && statSync(fixture + "-wal").size) throw Error("Закройте запись в учебную базу перед копированием.");
const hours = Number(process.env.PTREASURY_MOTION_HOURS ?? 0);
if (!Number.isFinite(hours) || hours < 0 || !Number.isFinite(hours * 3600000)) throw Error("Длительность замера задаётся в часах.");
const soak = hours > 0;
const inputMode = process.env.PTREASURY_MOTION_INPUT ?? (soak ? "dom" : "webdriver");
if (!["webdriver", "dom"].includes(inputMode)) throw Error("PTREASURY_MOTION_INPUT: webdriver или dom.");
const minCycleMs = Number(process.env.PTREASURY_MOTION_INTERVAL_MS ?? (soak ? 2000 : 0));
if (!Number.isSafeInteger(minCycleMs) || minCycleMs < 0 || minCycleMs > 2147483647) throw Error("Недопустимый интервал между циклами в миллисекундах.");
const checkpointMs = 10 * 60 * 1000;
class InterruptedCoverage extends Error {}
const temp = realpathSync(tmpdir());
let report;
if (soak) {
  const parent = resolve(process.env.PTREASURY_MOTION_REPORT_DIR ?? join(import.meta.dirname, "../target/.test-artifacts/memory-soak"));
  mkdirSync(parent, { recursive: true });
  report = join(mkdtempSync(join(parent, "run-")), "checkpoints.jsonl");
  console.log("Журнал длительного замера:", report);
}
const run = mkdtempSync(join(temp, "kazna-motion-lifetime-"));
const originalTemp = { TEMP: process.env.TEMP, TMP: process.env.TMP };
let browser;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const invoke = (cmd, args = {}) => browser.executeAsync((cmd, args, done) => {
  window.__TAURI_INTERNALS__.invoke(cmd, args).then(value => done({ value }), e => done({ error: String(e) }));
}, cmd, args).then(result => { if (result.error) throw Error(result.error); return result.value; });
const ready = fn => browser.waitUntil(() => browser.execute(fn), { timeout: 15000, interval: 25 });
const series = { journal: [], form: [], cancel: [], home: [], cycle: [] };
const samples = [];
let cdpRoute;
let completedCycles = 0;
let interrupted = false;
const cancel = () => { interrupted = true; };
function writeRecord(event, fields) {
  appendFileSync(report, JSON.stringify({ event, utc: new Date().toISOString(), ...fields }) + "\n", { flush: true });
}

// Метрики только собственного документа WebView2, доступного текущей сессии EdgeDriver.
async function devtools(cmd) {
  if (cdpRoute === null) return null;
  const routes = cdpRoute ? [cdpRoute] : ["ms/cdp/execute", "goog/cdp/execute", "chromium/send_command_and_get_result"];
  for (const route of routes) {
    const response = await fetch(`http://127.0.0.1:4444/session/${browser.sessionId}/${route}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cmd, params: {} }),
    });
    if (response.ok) {
      const { value } = await response.json();
      if (value && !value.error) { cdpRoute = route; return value; }
    }
  }
  if (!cdpRoute) cdpRoute = null;
  return null;
}

async function state() {
  const accounts = await invoke("list_accounts", { includeArchived: true });
  const transactions = await invoke("list_transactions", { filter: { limit: 1 } });
  return { accounts: accounts.map(a => [a.id, a.balance]).sort(([a],[b])=>a.localeCompare(b)), total: transactions.total };
}

async function snapshot(point, collect = false) {
  // Сборка мусора выполняется только у специально помеченных парных замеров.
  const collected = collect && (await devtools("HeapProfiler.collectGarbage")) !== null;
  const ui = await browser.execute(() => ({
    screen: document.querySelector("main h1")?.textContent.trim(), theme: document.documentElement.dataset.theme,
    elements: document.querySelectorAll("*").length, dialogs: document.querySelectorAll('[role="dialog"]').length,
    running: document.getAnimations().filter(a => a.playState === "running").length,
    hidden: document.hidden, focused: document.hasFocus(),
    longTasks: window.motionLongTasks && { count: window.motionLongTasks.count, totalMs: window.motionLongTasks.totalMs, maxMs: window.motionLongTasks.maxMs },
  }));
  const sample = { point, collected, ui, dom: await devtools("Memory.getDOMCounters"), heap: await devtools("Runtime.getHeapUsage"),
    processTree: testWindowMemory(browser) };
  if (!soak) samples.push(sample);
  return sample;
}

async function cycle(record) {
  const times = [performance.now()];
  const section = name => inputMode === "webdriver"
    ? browser.$(`nav button[aria-label="${name}"]`).click()
    : browser.execute(name => { document.querySelector(`nav button[aria-label="${name}"]`).click(); }, name);
  await section("Операции");
  await ready(() => /Показано \d+ из \d+/.test(document.querySelector('[data-testid="txn-count"]')?.textContent ?? ""));
  times.push(performance.now());
  if (inputMode === "webdriver") await browser.$('//main//button[normalize-space()="+ Операция"]').click();
  else await browser.execute(() => { [...document.querySelectorAll("main button")].find(el => el.textContent.trim() === "+ Операция").click(); });
  if (inputMode === "webdriver") await browser.$('[role="dialog"] input[name="amount"]').waitForDisplayed();
  else await ready(() => Boolean(document.querySelector('[role="dialog"] input[name="amount"]')?.getClientRects().length));
  times.push(performance.now());
  if (inputMode === "webdriver") await browser.keys("Escape");
  else await browser.execute(() => {
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
  });
  await ready(() => !document.querySelector('[role="dialog"]'));
  times.push(performance.now());
  await section("Главная");
  await ready(() => document.querySelector("main h1")?.textContent.trim() === "Главная" &&
    Boolean(document.querySelector('[data-testid="total-balance"]')?.textContent.trim()));
  times.push(performance.now());
  if (record) {
    for (const [i, key] of ["journal","form","cancel","home"].entries()) series[key].push(times[i + 1] - times[i]);
    series.cycle.push(times[4] - times[0]);
  }
  if (minCycleMs) await pause(Math.max(0, minCycleMs - (times[4] - times[0])));
}

function intervalTimings() {
  const stats = {};
  for (const [name, values] of Object.entries(series)) {
    if (!values.length) continue;
    values.sort((a, b) => a - b);
    const at = p => Math.round(values[Math.ceil(values.length * p) - 1]);
    stats[name] = { p50: at(0.5), p95: at(0.95), max: at(1) };
    values.length = 0;
  }
  return stats;
}

async function runSoak(version, initial) {
  const binarySha256 = createHash("sha256").update(readFileSync(APP_BIN)).digest("hex");
  const maxInactiveMs = Math.min(checkpointMs / 2, Math.max(60000, 3 * minCycleMs));
  writeRecord("configuration", { version, binarySha256, hours, checkpointMs, inputMode, minCycleMs, maxInactiveMs,
    transactions: initial.total, accounts: initial.accounts.length, warmups: 1 });
  const baseline = await snapshot("baseline-after-gc", true);
  writeRecord("baseline", { elapsedMs: 0, cycles: 0, sample: baseline });
  assert.equal(baseline.ui.screen, "Главная");
  assert.ok(!baseline.ui.hidden && baseline.ui.dialogs === 0, "Для замера нужна открытая Главная");
  const started = performance.now();
  const deadline = started + hours * 3600000;
  let nextCheckpoint = started + checkpointMs;
  let longestCycleWallMs = 0;
  let lastActive = started;
  let lastWallClock = Date.now();
  function checkContinuity() {
    const now = performance.now();
    const wall = Date.now();
    const gap = Math.max(now - lastActive, Math.abs(wall - lastWallClock));
    if (gap > maxInactiveMs) {
      throw new InterruptedCoverage(`Перерыв между наблюдениями ${Math.round(gap)} мс превышает ${maxInactiveMs} мс`);
    }
    lastActive = now;
    lastWallClock = wall;
  }

  async function checkpoint(final) {
    await pause(400);
    const sample = await snapshot(final ? "final-after-gc" : "home-after-gc", true);
    const actual = await state();
    checkContinuity();
    const sameHome = sample.ui.screen === baseline.ui.screen && sample.ui.theme === baseline.ui.theme &&
      sample.ui.dialogs === 0 && !sample.ui.hidden;
    const financialStatePreserved = isDeepStrictEqual(actual, initial);
    writeRecord("checkpoint", { final, elapsedMs: Math.round(performance.now() - started), cycles: completedCycles,
      longestCycleWallMs: Math.round(longestCycleWallMs), sameHome, financialStatePreserved,
      timingsSincePreviousMs: intervalTimings(), sample });
    assert.ok(sameHome, "Изменились экран, видимость окна или тема в контрольной точке");
    assert.ok(financialStatePreserved, "После серии изменились остатки или число операций");
  }

  while (performance.now() < deadline) {
    if (interrupted) throw Error("Замер остановлен оператором");
    const began = performance.now();
    await cycle(true);
    completedCycles++;
    checkContinuity();
    const now = performance.now();
    longestCycleWallMs = Math.max(longestCycleWallMs, now - began);
    if (now >= nextCheckpoint && nextCheckpoint < deadline) {
      await checkpoint(false);
      nextCheckpoint += checkpointMs;
      longestCycleWallMs = 0;
    }
  }
  if (interrupted) throw Error("Замер остановлен оператором");
  if (nextCheckpoint < deadline) throw new InterruptedCoverage("Пропущена контрольная точка длительного замера");
  await checkpoint(true);
  if (interrupted) throw Error("Замер остановлен оператором");
}

async function runHundred(version, initial) {
  const first = (await invoke("list_transactions", { filter: { limit: 50 } })).items.find(r => r.payee?.trim());
  assert.ok(first?.payee, "Для фильтра нужна учебная операция с получателем");
  await snapshot("baseline-after-gc", true);
  for (let i = 1; i <= 100; i++) {
    await cycle(true);
    if (i % 25 === 0) {
      await pause(400);
      await snapshot("cycle-" + i);
      assert.deepEqual(await state(), initial);
      console.log("cycles", i);
    }
  }
  // Сравнить один экран при одинаковых теме и данных, до сортировки или фильтра.
  await snapshot("cycle-100-after-gc", true);
  await openSection(browser, "Операции");
  await openFilters(browser);
  await browser.$('[data-testid="txn-show-all"]').click();
  await browser.waitUntil(() => browser.execute(n => Number(/из (\d+)/.exec(document.querySelector('[data-testid="txn-count"]')?.textContent ?? "")?.[1]) === n, initial.total));
  const sort = await browser.$('.txn-table th button[data-sort="amount"]');
  await sort.click();
  await ready(() => ["ascending", "descending"].includes(document.querySelector('.txn-table button[data-sort="amount"]')?.parentElement?.ariaSort));
  await browser.$('[name="search"]').setValue(first.payee);
  const theme = await browser.execute(() => document.documentElement.dataset.theme);
  const otherTheme = theme === "dark" ? "light" : "dark";
  await browser.$('[data-testid="theme-switch"]').click();
  await browser.$(`[data-testid="theme-${otherTheme}"]`).click();
  await browser.waitUntil(() => browser.execute((theme, payee, total) => {
    const count = /из (\d+)/.exec(document.querySelector('[data-testid="txn-count"]')?.textContent ?? "");
    return document.documentElement.dataset.theme === theme && count && Number(count[1]) > 0 && Number(count[1]) < total &&
      document.querySelector('[name="search"]').value === payee;
  }, otherTheme, first.payee, initial.total), { timeout: 10000 });
  const filtered = await browser.$('[data-testid="txn-count"]').getText();
  await openSection(browser, "Главная");
  await pause(400);
  await snapshot("before-minimize");
  const away = performance.now();
  minimizeTestWindow(browser, true);
  try { await pause(60000); await snapshot("minimized-60s"); }
  finally { minimizeTestWindow(browser, false); }
  const awayMs = Math.round(performance.now() - away);
  await pause(400);
  await snapshot("restored");
  await snapshot("restored-after-gc", true);
  assert.deepEqual(await state(), initial);
  console.log(JSON.stringify({ version, bin: APP_BIN, inputMode, minCycleMs, cycles: 100, warmups: 1, transactions: initial.total, accounts: initial.accounts.length,
    balancesAndCountPreserved: true, sortedBy: "amount", filtered, themeAfterFilter: otherTheme,
    awayMs, cdpRoute, timesMsIncludingDriver: intervalTimings(), samples }));
}

try {
  if (soak) {
    writeRecord("started", { hours, inputMode, minCycleMs });
    process.on("SIGINT", cancel);
    process.on("SIGTERM", cancel);
  }
  const scratch = join(run, "tmp");
  mkdirSync(scratch);
  process.env.TEMP = scratch;
  process.env.TMP = scratch;
  copyFileSync(fixture, join(run, "budget.db"));
  ({browser} = await start(run, { verboseDriver: !soak, env: { WEBVIEW2_USER_DATA_FOLDER: join(run,"webview"), PTREASURY_VAULT_DIR: join(run,"vault") } }));
  const { version } = await invoke("app_info");
  const initial = await state();
  await browser.execute(() => {
    if (!PerformanceObserver.supportedEntryTypes.includes("longtask")) return;
    const data = { count: 0, totalMs: 0, maxMs: 0 };
    const observer = new PerformanceObserver(list => {
      for (const e of list.getEntries()) {
        data.count++; data.totalMs += e.duration; data.maxMs = Math.max(data.maxMs, e.duration);
      }
    });
    observer.observe({ type: "longtask" }); window.motionLongTasks = data;
  });
  await cycle(false);
  await pause(400);
  if (soak) await runSoak(version, initial);
  else await runHundred(version, initial);
} catch (error) {
  if (soak) writeRecord(error instanceof InterruptedCoverage ? "inconclusive" : "failed", { cycles: completedCycles, reason: error.message });
  throw error;
} finally {
  try { await stop(browser); }
  finally {
    if (soak) {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    }
    for (const [key, value] of Object.entries(originalTemp)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (dirname(run) === temp && realpathSync(run) === run) rmSync(run, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
  }
}
if (soak) writeRecord("completed", { cycles: completedCycles });
