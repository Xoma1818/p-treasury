import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';

const bin = process.env.KAZNA_TEST_BIN;
assert.ok(bin, 'missing installed Kazna.exe');
assert.equal(process.env.PTREASURY_UPDATE_URL, undefined, 'use the public endpoint embedded in 0.36.1');
const root = await mkdtemp(join(tmpdir(), 'kazna-inapp-e2e-'));
const data = join(root, 'data');
await mkdir(data);
const databasePath = join(data, 'budget.db');
const { start, stop, appPid } = await import(pathToFileURL(resolve(process.env.KAZNA_E2E_APP)).href);

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
  const differences = Object.keys(before.tables).filter((name) =>
    JSON.stringify(before.tables[name].rows) !== JSON.stringify(after.tables[name].rows));
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
try {
  ({ browser } = await start(data, { bin, homeDefaults: true }));
  ui = onWindow(browser);
  if (await ui.run(() => Boolean(document.querySelector('[data-testid="update-version"]')))) await ui.click('Позже', '[role="dialog"]');
  await ui.click('Посмотреть на примере');
  await ui.text('main h1', 'Главная');
  const info = await ui.invoke('app_info');
  assert.equal(info.version, '0.36.1');
  assert.equal(info.schemaVersion, 25);
  assert.equal(resolve(info.dataDir).toLowerCase(), resolve(data).toLowerCase());
  assert.equal(info.portable, false);
  const original = runningApp();
  oldPid = Number(appPid(data)) || original.processes.find(usesProfile)?.id;
  assert.ok(oldPid, 'old installed process in this exact data profile: ' + JSON.stringify(original));
  const categories = await ui.invoke('list_categories', { includeArchived: false });
  const categoryId = categories.find((c) => c.name === 'Питание').id;
  await ui.invoke('create_rule', { input: { pattern: 'Проверка обновления', categoryId, payee: 'Тестовый магазин' } });
  await ui.invoke('create_goal', { input: { name: 'Цель до обновления', target: 150_000, currencyCode: 'RUB', accountId: null, deadline: null, reserve: false }, shareBp: null });

  await ui.click('Настройки', 'nav');
  await ui.text('main h1', 'Настройки');
  if (await ui.run(() => Boolean(document.querySelector('[data-testid="update-version"]')))) await ui.click('Позже', '[role="dialog"]');
  await ui.click('Проверить обновления', '[data-testid="updates-card"]');
  await ui.text('[data-testid="update-version"]', 'Доступна версия 0.37.0 (у вас 0.36.1)');
  const before = snapshot(databasePath);
  assert.equal(before.schema, 25);
  for (const name of ['accounts', 'transactions', 'categories', 'debts', 'notes', 'goals', 'reminders', 'payee_rules']) {
    assert.ok(before.tables[name]?.rows.length, `fixture has data in ${name}`);
  }
  console.log('The installed 0.36.1 offered 0.37.0 from its public update channel.');
  await ui.click('Обновить', '[role="dialog"]');
  const reboot = await until(() => {
    const app = runningApp();
    if (app.version !== '0.37.0') return null;
    return app.processes.find((proc) => proc.id !== oldPid && proc.visible && proc.window?.includes('Kazna') && usesProfile(proc));
  }, 'the installer replaces the binary and automatically restarts the same data profile', 150_000, 1100);
  console.log(`Installer restarted Kazna with the same test directory: new PID ${reboot.id}.`);

  const after = snapshot(databasePath, before.tables);
  assert.equal(after.schema, 28);
  verifyData(before, after, 'upgraded DB');
  const files = await readdir(join(data, 'backups'));
  for (const prefix of ['before-app-update-', 'before-update-']) {
    const copies = files.filter((name) => name.startsWith(prefix));
    assert.equal(copies.length, 1, prefix);
    const copy = snapshot(join(data, 'backups', copies[0]), before.tables);
    assert.equal(copy.schema, 25);
    verifyData(before, copy, `backup ${prefix}`);
  }
  const counts = Object.fromEntries(Object.entries(before.tables).filter(([, t]) => t.rows.length).map(([name, t]) => [name, t.rows.length]));
  console.log(JSON.stringify({ before: '0.36.1', after: '0.37.0', schema: '25 → 28', tablesCompared: Object.keys(before.tables).length, counts, integrity: 'ok', foreignKeys: 'ok', backups: 2 }));
} catch (error) {
  try { console.error('Native app status:', JSON.stringify(runningApp())); } catch { /* diagnostics only */ }
  if (ui) {
    try { console.error(await ui.run(() => document.querySelector('[role="dialog"]')?.innerText.slice(-3000))); } catch { /* the update closes the old process */ }
  }
  throw error;
} finally {
  if (browser) await stop(browser).catch(() => {});
}
