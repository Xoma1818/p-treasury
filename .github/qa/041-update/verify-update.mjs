import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';

const bin = process.env.KAZNA_TEST_BIN;
assert.ok(bin, 'missing installed Kazna.exe');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
assert.equal(process.env.GITHUB_REPOSITORY, 'Xoma1818/p-treasury');
const feed = new URL(process.env.PTREASURY_UPDATE_URL);
assert.equal(feed.protocol, 'https:');
assert.equal(feed.hostname, 'localhost');
assert.equal(feed.pathname, '/latest.json');
const root = await mkdtemp(join(tmpdir(), 'kazna-inapp-e2e-'));
const data = join(root, 'data');
await mkdir(data);
const databasePath = join(data, 'budget.db');
const feedFolder = process.env.KAZNA_QA_FEED_FOLDER;
assert.ok(feedFolder, 'missing private control directory of the loopback fixture');
const changeFeed = (mode) => writeFile(join(feedFolder, 'scenario.txt'), mode, 'utf8');
async function observedRequest(value) {
  await until(async () => (await readFile(join(feedFolder, 'requests.txt'), 'utf8')).split(/\r?\n/).includes(value), value);
}
async function backupFiles() {
  let names;
  try { names = await readdir(join(data, 'backups')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  const result = {};
  for (const name of names.filter(name => name.startsWith('before-app-update-') || name.startsWith('before-update-'))) {
    result[name] = createHash('sha256').update(await readFile(join(data, 'backups', name))).digest('hex');
  }
  return result;
}
function checkBackupDelta(previous, current, expectedPrefixes, before) {
  for (const [name, digest] of Object.entries(previous)) assert.equal(current[name], digest, `existing backup ${name}`);
  const added = Object.keys(current).filter(name => !(name in previous));
  assert.equal(added.length, expectedPrefixes.length, 'number of new backup files');
  for (const prefix of expectedPrefixes) {
    const matching = added.filter(name => name.startsWith(prefix));
    assert.equal(matching.length, 1, `new backup ${prefix}`);
    const saved = snapshot(join(data, 'backups', matching[0]), before.tables);
    assert.equal(saved.schema, 28);
    verifyData(before, saved, matching[0]);
  }
  return added;
}
const { start, stop, openSection } = await import(pathToFileURL(resolve(process.env.KAZNA_E2E_APP)).href);

async function until(get, label, timeout = 25_000, interval = 175) {
  const deadline = Date.now() + timeout;
  do {
    const result = await get();
    if (result) return result;
    await sleep(interval);
  } while (Date.now() < deadline);
  throw Error(`Timed out: ${label}`);
}

function onWindow(browser) {
  const run = (fn, ...args) => browser.execute(fn, ...args);
  return {
    run,
    invoke: async (name, args = {}) => {
      const result = await browser.executeAsync((cmd, input, done) => {
        window.__TAURI_INTERNALS__.invoke(cmd, input).then((value) => done({ value }), (error) => done({ error: String(error) }));
      }, name, args);
      assert.equal(result.error, undefined, name);
      return result.value;
    },
    text: (selector, part) => until(() => run((s, p) => document.querySelector(s)?.textContent.includes(p), selector, part), selector + ': ' + part),
    click: (label, scope = 'body') => until(() => run((name, selector) => {
      const b = [...(document.querySelector(selector)?.querySelectorAll('button') ?? [])]
        .find((node) => node.textContent.trim() === name && node.getClientRects().length && !node.disabled);
      if (!b) return false;
      b.click();
      return true;
    }, label, scope), 'click ' + label),
  };
}

const qi = (value) => '"' + value.replaceAll('"', '""') + '"';
function snapshot(path, previousTables) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('BEGIN');
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    const schema = db.prepare('PRAGMA user_version').get().user_version;
    const names = previousTables ? Object.keys(previousTables) : db.prepare(
      "SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all().map((item) => item.name);
    const tables = Object.fromEntries(names.map((name) => {
      const columns = previousTables?.[name].columns ?? db.prepare(`PRAGMA table_info(${qi(name)})`).all().map((item) => item.name);
      const rows = db.prepare(`SELECT ${columns.map(qi).join(', ')} FROM ${qi(name)}`).all();
      return [name, { columns, rows: rows.map((row) => JSON.stringify(row)).sort() }];
    }));
    return { schema, tables };
  } finally { db.close(); }
}

function verifyData(before, after, label) {
  const differences = Object.keys(before.tables).filter((name) => {
    const oldRows = before.tables[name].rows;
    const newRows = after.tables[name].rows;
    if (name === 'settings' && after.schema === 30 && label === 'upgraded DB') {
      const expectedAddition = newRows.filter((row) => JSON.parse(row).key === 'subs_notified_by_currency');
      assert.equal(expectedAddition.length, 1, 'migration 29 added the per-currency setting');
      const oldHasKey = oldRows.some((row) => JSON.parse(row).key === 'subs_notified_by_currency');
      return JSON.stringify(oldRows) !== JSON.stringify(oldHasKey ? newRows : newRows.filter((row) => !expectedAddition.includes(row)));
    }
    if (name === 'budget_alerts') {
      // Startup may append notification receipts, but previous receipts must survive unchanged.
      const retained = new Set(newRows);
      if (!oldRows.every((row) => retained.has(row))) return true;
      if (newRows.length > oldRows.length) console.log(`${label}: background added ${newRows.length - oldRows.length} budget notification receipts`);
      return false;
    }
    return JSON.stringify(oldRows) !== JSON.stringify(newRows);
  });
  assert.deepEqual(differences, [], `${label}: tables with changed existing rows`);
}

function runningApp() {
  const command = [
    '$wanted = $env:KAZNA_TEST_BIN',
    '$build = (Get-Item -LiteralPath $wanted).VersionInfo.ProductVersion',
    '$apps = @(Get-CimInstance Win32_Process -Filter "Name=\'Kazna.exe\'" | Where-Object ExecutablePath -EQ $wanted)',
    '$info = @($apps | ForEach-Object { $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if ($p) { @{ id=$_.ProcessId; arguments=$_.CommandLine; window=$p.MainWindowTitle; visible=($p.MainWindowHandle -ne [IntPtr]::Zero) } } })',
    '@{ version=$build; processes=$info } | ConvertTo-Json -Depth 4 -Compress',
  ].join('\n');
  return JSON.parse(execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true }));
}

const usesProfile = (proc) => proc.arguments?.replaceAll('"', '').toLowerCase().includes(('--data-dir=' + data).toLowerCase());
let ui, browser, oldPid;
const phase = (label) => console.log(`[${new Date().toISOString()}] ${label}`);
try {
  phase('Opening installed 0.37.2 through WebDriver');
  ({ browser } = await start(data, { bin, homeDefaults: true }));
  ui = onWindow(browser);
  if (await ui.run(() => Boolean(document.querySelector('[data-testid="update-version"]')))) await ui.click('Позже', '[role="dialog"]');
  await ui.click('Посмотреть на примере');
  await ui.text('main h1', 'Главная');
  const info = await ui.invoke('app_info');
  assert.equal(info.version, '0.37.2');
  assert.equal(info.schemaVersion, 28);
  assert.equal(resolve(info.dataDir).toLowerCase(), resolve(data).toLowerCase());
  assert.equal(info.portable, false);
  phase('Old app responsive; setting up reference data');
  const original = runningApp();
  oldPid = original.processes.find(usesProfile)?.id;
  assert.ok(oldPid, 'old installed process in this exact data profile: ' + JSON.stringify(original));
  const categories = await ui.invoke('list_categories', { includeArchived: false });
  const categoryId = categories.find((c) => c.name === 'Питание').id;
  const ruleId = await ui.invoke('create_rule', { input: { pattern: 'Проверка обновления', categoryId, payee: 'Тестовый магазин' } });
  const goalId = await ui.invoke('create_goal', { input: { name: 'Цель до обновления', target: 150_000, currencyCode: 'RUB', accountId: null, deadline: null, reserve: false }, shareBp: null });
  assert.ok(typeof ruleId === 'string' && ruleId);
  assert.ok(typeof goalId === 'string' && goalId);

  await ui.click('Настройки', 'nav');
  await ui.text('main h1', 'Настройки');
  if (await ui.run(() => Boolean(document.querySelector('[data-testid="update-version"]')))) await ui.click('Позже', '[role="dialog"]');
  const before = snapshot(databasePath);
  assert.equal(before.schema, 28);
  for (const name of ['accounts', 'transactions', 'categories', 'debts', 'notes', 'goals', 'reminders', 'payee_rules']) {
    assert.ok(before.tables[name]?.rows.length, `fixture has data in ${name}`);
  }
  const beforeFailures = await backupFiles();
  const visibleError = (scope, pattern) => until(async () => {
    const description = await ui.run(selector => {
      const el = document.querySelector(selector + ' [role="alert"]');
      return el?.getClientRects().length ? el.textContent.trim() : '';
    }, scope);
    return pattern.test(description) ? description : null;
  }, 'visible updater error in ' + scope);
  async function checkOriginal(label) {
    const info = await ui.invoke('app_info');
    assert.equal(info.version, '0.37.2');
    assert.equal(info.schemaVersion, 28);
    assert.equal(resolve(info.dbPath).toLowerCase(), resolve(databasePath).toLowerCase());
    const processState = runningApp();
    assert.equal(processState.version, '0.37.2');
    assert.deepEqual(processState.processes.filter(usesProfile).map(p => p.id), [oldPid]);
    const current = snapshot(databasePath, before.tables);
    assert.equal(current.schema, 28);
    verifyData(before, current, label);
  }
  phase('Closing the local update feed connection to check a network failure');
  await changeFeed('network');
  await ui.click('Проверить обновления', '[data-testid="updates-card"]');
  const networkError = await visibleError('[data-testid="updates-card"]', /не удалось проверить обновления/i);
  await observedRequest('network:latest.json');
  await checkOriginal('network failure');
  const afterNetwork = await backupFiles();
  checkBackupDelta(beforeFailures, afterNetwork, [], before);
  phase(`Original window and database verified after network failure: ${networkError}`);

  phase('Supplying the public signature of the previous installer for this candidate');
  await changeFeed('signature');
  await ui.click('Проверить обновления', '[data-testid="updates-card"]');
  await ui.text('[data-testid="update-version"]', 'Доступна версия 0.41.2 (у вас 0.37.2)');
  await ui.click('Обновить', '[role="dialog"]');
  const signatureError = await visibleError('[role="dialog"]', /signatur|verification|подпис/i);
  await observedRequest('signature:Kazna_0.41.2_x64-setup.exe');
  await checkOriginal('signature failure');
  const afterSignature = await backupFiles();
  const failedCopies = checkBackupDelta(afterNetwork, afterSignature, ['before-app-update-'], before);
  phase(`Original window, database and safety copy verified after signature rejection: ${signatureError}`);
  await ui.click('Позже', '[role="dialog"]');

  // 0.37.2 names its safety copies to the nearest second. Give the retry its own name.
  await sleep(1050);
  await changeFeed('normal');
  await ui.click('Проверить обновления', '[data-testid="updates-card"]');
  await ui.text('[data-testid="update-version"]', 'Доступна версия 0.41.2 (у вас 0.37.2)');
  console.log('Installed 0.37.2 offered signed candidate 0.41.2 via the local TLS feed after both failures.');
  await ui.click('Обновить', '[role="dialog"]');
  phase('Clicked Update; waiting for automatic restart');
  const reboot = await until(() => {
    const app = runningApp();
    if (app.version !== '0.41.2') return null;
    return app.processes.find((proc) => proc.id !== oldPid && proc.visible && proc.window?.includes('Kazna') && usesProfile(proc));
  }, 'the installer replaces the binary and automatically restarts the same data profile', 150_000, 1100);
  console.log(`Installer restarted Kazna with the same test directory: new PID ${reboot.id}.`);

  const after = await until(() => {
    const state = snapshot(databasePath, before.tables);
    return state.schema === 30 && state;
  }, 'automatic restart opens and migrates the original database', 30_000, 400);
  verifyData(before, after, 'upgraded DB');
  await observedRequest('normal:Kazna_0.41.2_x64-setup.exe');
  const successfulCopies = checkBackupDelta(afterSignature, await backupFiles(), ['before-app-update-', 'before-update-'], before);
  // The updater ended the original WebDriver session. Independently exercise the installed UI
  // by opening the same installed binary and profile again after proving its automatic restart.
  phase('Both backup copies and old rows verified; reopening installed 0.41.2');
  await stop(browser).catch(() => {});
  browser = undefined;
  ui = undefined;
  ({ browser } = await start(data, { bin, homeDefaults: true }));
  ui = onWindow(browser);
  await openSection(browser, 'Настройки');
  await ui.text('main h1', 'Настройки');
  await ui.text('#set-about .facts', '0.41.2');
  await ui.text('#set-about .facts', '30 из 30');
  assert.equal(await ui.run(() => document.title), 'Kazna');
  const newInfo = await ui.invoke('app_info');
  assert.equal(newInfo.version, '0.41.2');
  assert.equal(newInfo.schemaVersion, 30);
  assert.equal(newInfo.supportedSchemaVersion, 30);
  assert.equal(resolve(newInfo.dataDir).toLowerCase(), resolve(data).toLowerCase());
  assert.equal(resolve(newInfo.dbPath).toLowerCase(), resolve(databasePath).toLowerCase());
  assert.equal(newInfo.portable, false);
  assert.equal(newInfo.onboardingDone, true);
  const goal = (await ui.invoke('list_goals')).find(g => g.id === goalId);
  assert.ok(goal, 'goal from old installed version missing');
  assert.equal(goal.name, 'Цель до обновления');
  assert.equal(goal.target, 150_000);
  assert.equal(goal.currencyCode, 'RUB');
  const savedRule = (await ui.invoke('list_rules')).find(r => r.id === ruleId);
  assert.ok(savedRule, 'rule from old installed version missing');
  assert.equal(savedRule.pattern, 'Проверка обновления');
  assert.equal(savedRule.payee, 'Тестовый магазин');
  assert.equal(savedRule.categoryId, categoryId);
  phase('New installed window and saved rule/goal verified');
  const counts = Object.fromEntries(Object.entries(before.tables).filter(([, t]) => t.rows.length).map(([name, t]) => [name, t.rows.length]));
  const evidence = { before: '0.37.2', after: '0.41.2', schema: '28 → 30', automaticRestartPid: reboot.id,
    reopenedInstalledWindow: { title: 'Kazna', version: newInfo.version, displayedSchema: 30, goalId, ruleId },
    tablesCompared: Object.keys(before.tables).length, counts, integrity: 'ok', foreignKeys: 'ok',
    networkFailure: { message: networkError, retainedPid: oldPid, newBackups: 0 },
    signatureFailure: { message: signatureError, retainedPid: oldPid, newBackups: failedCopies.length },
    successfulUpdateBackups: successfulCopies.length };
  await writeFile(process.env.KAZNA_UPDATE_EVIDENCE, JSON.stringify(evidence), { flag: 'wx' });
  console.log(JSON.stringify(evidence));
} catch (error) {
  try { console.error('Native app status:', JSON.stringify(runningApp())); } catch { /* diagnostics only */ }
  if (ui) {
    try { console.error(await ui.run(() => document.querySelector('[role="dialog"]')?.innerText.slice(-3000))); } catch { /* the update closes the old process */ }
  }
  throw error;
} finally {
  if (browser) await stop(browser).catch(() => {});
}
