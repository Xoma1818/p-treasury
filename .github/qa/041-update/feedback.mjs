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
    assert.equal(saved.schema, before.schema);
    verifyData(before, saved, matching[0]);
  }
  return added;
}
const { start, stop, openSection, click } = await import(pathToFileURL(resolve(process.env.KAZNA_E2E_APP)).href);

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
const expectedNetwork = 'Нет связи с сервером обновлений. Проверьте подключение к интернету и попробуйте ещё раз.';
const expectedSignature = 'Подпись обновления не прошла проверку. Установка отменена.';
const evidence = process.env.KAZNA_FEEDBACK_EVIDENCE_DIR;
assert.ok(evidence, 'Missing evidence directory');
assert.ok(!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN, 'No job API token in app or browser environment');
let browser;
try {
  ({ browser } = await start(data, { bin, homeDefaults: true }));
  const ui = onWindow(browser);
  await click(browser, 'Посмотреть на примере');
  await ui.text('main h1', 'Главная');
  const info = await ui.invoke('app_info');
  assert.equal(info.version, '0.41.3');
  assert.equal(info.schemaVersion, 30);
  assert.equal(info.portable, false);
  assert.equal(resolve(info.dbPath).toLowerCase(), resolve(databasePath).toLowerCase());
  const old = runningApp();
  const pids = old.processes.filter(usesProfile).map(p => p.id);
  assert.equal(pids.length, 1, 'Expected the installed candidate in the exact test profile');
  assert.equal(old.version, '0.41.3');
  const pid = pids[0];
  const exeHash = async () => createHash('sha256').update(await readFile(bin)).digest('hex');
  const originalBinary = await exeHash();
  const balances = async () => {
    const accounts = await ui.invoke('list_accounts', { includeArchived: true });
    return accounts.map(a => ({ id: a.id, currency: a.currencyCode, balance: a.balance })).sort((a,b) => a.id.localeCompare(b.id));
  };
  await openSection(browser, 'Настройки');
  await ui.text('main h1', 'Настройки');
  await ui.text('#set-about .facts', '0.41.3');
  const before = snapshot(databasePath);
  assert.equal(before.schema, 30);
  assert.ok(before.tables.transactions.rows.length > 0 && before.tables.accounts.rows.length > 0, 'Need demo transactions and accounts');
  const originalBalances = await balances();
  assert.ok(originalBalances.some(a => Number.isSafeInteger(a.balance) && a.balance !== 0));
  const initialBackups = await backupFiles();

  async function checkIntact(label) {
    const state = runningApp();
    assert.equal(state.version, '0.41.3');
    assert.deepEqual(state.processes.filter(usesProfile).map(p => p.id), [pid]);
    assert.equal((await ui.invoke('app_info')).version, '0.41.3');
    assert.equal(await exeHash(), originalBinary);
    assert.deepEqual(await balances(), originalBalances);
    const current = snapshot(databasePath, before.tables);
    assert.equal(current.schema, before.schema);
    verifyData(before, current, label);
  }
  async function visibleFeedback(scope, expected, imageFile) {
    const text = await until(() => ui.run(selector => {
      const el = document.querySelector(selector + ' [role="alert"]');
      return el?.getClientRects().length && el.innerText.trim();
    }, scope), 'visible updater feedback in ' + scope);
    assert.equal(text, expected, 'Full visible message must exactly match the user-facing text');
    const panel = await browser.$(scope);
    const alert = await panel.$('[role="alert"]');
    await alert.scrollIntoView({ block: 'center' });
    await alert.waitForDisplayed({ timeout: 5000 });
    const panelText = await panel.getText();
    assert.ok(panelText.includes(expected), 'Readable alert in actual window');
    assert.doesNotMatch(panelText, /https?:\/\/localhost|127\.0\.0\.1|error sending request|reqwest|minisign|signature verification|failed to (fetch|install)/i, 'Technical error leaked in the visible panel');
    await browser.saveScreenshot(join(evidence, imageFile));
    return text;
  }
  const card = '[data-testid="updates-card"]';
  const cardXPath = '//*[@data-testid="updates-card"]';
  await changeFeed('network');
  await click(browser, 'Проверить обновления', cardXPath);
  const networkError = await visibleFeedback(card, expectedNetwork, 'network.png');
  await observedRequest('network:latest.json');
  await checkIntact('network refusal');
  const afterNetwork = await backupFiles();
  checkBackupDelta(initialBackups, afterNetwork, [], before);

  await changeFeed('signature');
  await click(browser, 'Проверить обновления', cardXPath);
  await ui.text('[data-testid="update-version"]', 'Доступна версия 0.41.4 (у вас 0.41.3)');
  await click(browser, 'Обновить', '//*[@role="dialog"]');
  const signatureError = await visibleFeedback('[role="dialog"]', expectedSignature, 'signature.png');
  await observedRequest('signature:Kazna_0.41.3_x64-setup.exe');
  await checkIntact('signature refusal');
  const savedCopies = checkBackupDelta(afterNetwork, await backupFiles(), ['before-app-update-'], before);
  const result = { version: info.version, schema: info.schemaVersion, retainedPid: pid, executableSha256: originalBinary,
    transactions: before.tables.transactions.rows.length, accounts: originalBalances.length, balances: originalBalances,
    tablesCompared: Object.keys(before.tables).length, integrity: 'ok', foreignKeys: 'ok',
    networkError, signatureError, newCopiesAfterNetwork: 0, newCopiesAfterSignature: savedCopies.length };
  await writeFile(join(evidence, 'report.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(result));
} finally {
  if (browser) await stop(browser).catch(() => {});
}
