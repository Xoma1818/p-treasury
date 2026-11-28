import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { click, clickControl, fill, onboard, openSettings, start, stop, waitText } from "./app.mjs";

const group = process.argv[2];
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
assert.equal(process.platform, "win32");
assert.ok(["files", "backup", "transfer", "places"].includes(group));
const temp = process.env.RUNNER_TEMP;
const work = mkdtempSync(join(temp, "vault-fixture-"));
const picker = process.env.KAZNA_QA_PICKER === "fixture" ? "fixture-path" : "native";
const evidence = join(temp, "vault-evidence", picker);
mkdirSync(evidence, { recursive: true });
const data = join(work, "data");
const vault = join(data, "Kazna");
const published = process.env.PTREASURY_BIN;
const runUrl = "https://github.com/" + process.env.GITHUB_REPOSITORY + "/actions/runs/" + process.env.GITHUB_RUN_ID;
const records = [];
const modal = '//*[@role="dialog"]';
const vaultScope = '//*[@data-testid="backup-card"]';
const fileScope = '//*[@data-testid="budget-files"]';
const original = join(data, "budget.db");
const manual = join(work, "manual.db");
let b, activeStep = "start";

function logRecord(component, ids, action, expected, actual) {
  for (const location of ids.split(" ")) {
    records.push({ id: "src/components/" + component + ".tsx:" + location, action, expected,
      actual, status: "pass", picker, evidence: runUrl });
  }
  writeFileSync(join(evidence, "actions.json"), JSON.stringify(records, null, 2));
  console.log("PASS", component, ids, action, actual);
}
function v(ids, name, expected, actual) {logRecord("Vault", ids, name, expected, actual);}
function f(ids, name, expected, actual) {logRecord("BudgetFiles", ids, name, expected, actual);}
function read(path, sql) {
  const db = new DatabaseSync(path, {readOnly: true});
  try { return db.prepare(sql).all().map(row => ({...row})); } finally { db.close(); }
}
function snapshot(path) {
  assert.deepEqual(read(path, "PRAGMA integrity_check"), [{integrity_check: "ok"}]);
  assert.deepEqual(read(path, "PRAGMA foreign_key_check"), []);
  return {
    accounts: read(path, "SELECT id,name,type,currency_code,opening_balance FROM accounts ORDER BY id"),
    operations: read(path, "SELECT id,date,type,payee,account_id,amount,category_id,status FROM transactions ORDER BY id"),
    settings: read(path, "SELECT key,value FROM settings WHERE key IN ('base_currency','month_start_day','home_layout','onboarding_done') ORDER BY key"),
  };
}
function same(path, expected, label) {
  const actual = snapshot(path);
  assert.deepEqual(actual, expected, label);
  return actual.operations.length + " оп., " + actual.accounts.length + " сч., запись и настройки совпали";
}
function remembered(name, snap) {
  writeFileSync(join(evidence, name + ".json"), JSON.stringify(snap,null,2));
}
async function command(name, args = {}) {
  const r = await b.executeAsync((name,args,done) => {
    window.__TAURI_INTERNALS__.invoke(name,args).then(value => done({value}), error => done({error:String(error)}));
  }, name, args);
  assert.equal(r.error, undefined, name + ": " + r.error);
  return r.value;
}
async function seedExpense(path, amount, merchant) {
  const [{id:accountId}] = read(path, "SELECT id FROM accounts WHERE type='debit'");
  const [{id:categoryId}] = read(path, "SELECT id FROM categories WHERE name='Питание'");
  await command("create_transaction", {input:{ type:"expense", date:"2026-11-20", accountId, categoryId,
    toAccountId:null, toAmount:null, payee:merchant, note:"Учебные данные", amount }, eventId:null});
}
async function has(selector) {await b.$(selector).waitForDisplayed({timeout:15000});}
async function gone(selector) {await b.$(selector).waitForExist({reverse:true,timeout:15000});}
async function home() {await has("//main//h1[normalize-space()='Главная']");}
async function settings() {await openSettings(b, "data");}
async function shot(name) {await b.saveScreenshot(join(evidence, name+".png"));}
function native(mode, value = "") {
  const ps = spawn("powershell.exe", ["-NoProfile", "-STA","-NonInteractive","-ExecutionPolicy","RemoteSigned","-File",
    resolve("scripts/qa-vault-dialog.ps1"),"-Mode",mode,...(value?["-PathValue",value]:[])], {windowsHide:true});
  const chunks = [];
  ps.stdout.on("data", d => chunks.push(d)); ps.stderr.on("data", d => chunks.push(d));
  return new Promise((yes,no) => {
    ps.on("error",no);
    ps.on("close", code => {
      const out = Buffer.concat(chunks).toString("utf8").trim();
      console.log("Native",mode,code,out);
      code === 0 ? yes(out) : no(new Error("Native "+mode+": "+out));
    });
  });
}
async function pick(name, mode, path, scope = "") {
  activeStep = name + " / " + mode;
  if (picker === "fixture-path") {
    await b.execute((value) => {window.__ptPick=[value];}, mode==="cancel" ? null : path);
    await click(b,name,scope);
    return;
  }
  await Promise.all([native(mode,path),click(b,name,scope)]);
}
function priorSnapshot(expected) {
  const folder = join(data,"backups");
  const matches = readdirSync(folder).filter(name=>name.startsWith("before-restore-")&&name.endsWith(".db"));
  assert.ok(matches.some(name => JSON.stringify(snapshot(join(folder,name)))===JSON.stringify(expected)), "No safety copy of the replaced data");
  return matches;
}
async function begin() {
  mkdirSync(data);
  ({browser:b} = await start(data, {bin:published,homeDefaults:true,env:{
    WEBVIEW2_USER_DATA_FOLDER:join(work,"webview"), PTREASURY_VAULT_DIR:vault,
  }}));
  const info = await command("app_info");
  assert.equal(info.version,"0.45.1");
  assert.equal(resolve(info.dbPath).toLowerCase(), resolve(original).toLowerCase());
  await onboard(b,[{name:"Учебный рублёвый счёт",type:"Карта",balance:"12000,75"}]);
  await seedExpense(original,12345,"Учебная покупка A");
  await command("set_setting",{key:"month_start_day",value:"10"});
  await settings();
  writeFileSync(join(evidence,"build.json"),JSON.stringify({
    version:info.version,sha256:createHash("sha256").update(readFileSync(published)).digest("hex"),
    run:runUrl,group,seed:"1200075 minor units, receipt 12345, budget month starts on 10",
  }, null, 2));
}
async function files() {
  const row = (n) => '//*[@data-testid="file-row" and @data-name="'+n+'"]';
  const a = snapshot(original);
  await click(b,"+ Новый файл",fileScope);
  await has('[name="fileName"]');
  f("88:10","Новый файл","Поле имени и кнопки формы","Поле fileName появилось");
  await click(b,"Не нужно",fileScope); await gone('[name="fileName"]');
  f("107:10","Отменить создание","Форма закрывается, исходная БД сохраняется",same(original,a,"cancel new"));
  await click(b,"+ Новый файл",fileScope); await fill(b,"fileName","Север");
  await click(b,"Создать и открыть",fileScope);
  await onboard(b,[{name:"Наличные на даче", type:"Наличные",balance:"55,55"}]);
  const alt = (await command("app_info")).dbPath;
  assert.notEqual(alt,original);
  const altSnap=snapshot(alt);
  assert.deepEqual(altSnap.accounts.map(x=>[x.name,x.opening_balance]),[["Наличные на даче",5555]]);
  f("96:8 104:10","Создать второй бюджет","Новая база отдельно от первого бюджета","Новый путь, 1 счёт, 5555 копеек; первый бюджет сохранился");
  same(original,a,"new budget separated");
  await settings(); await click(b,"Открыть",row("Основной")); await home(); await settings();
  f("68:16","Вернуться к основному","В окне активный путь основного бюджета",same((await command("app_info")).dbPath,a,"switch"));
  await click(b,"Переименовать",row("Север")); await has('[name="fileRename"]');
  f("73:16","Переименовать файл","Редактор имени строки","Поле fileRename появилось");
  await fill(b,"fileRename","Летний бюджет"); await click(b,"Сохранить",row("Север"));
  await has(row("Летний бюджет"));
  f("46:14 54:16","Сохранить имя","Новая подпись, исходный файл существует","Летний бюджет; " + same(alt,altSnap,"renamed"));
  await click(b,"Убрать из списка",row("Летний бюджет")); await gone(row("Летний бюджет"));
  f("78:16","Убрать из списка","Строка исчезает, файл остаётся на диске",same(alt,altSnap,"removed item preserved"));
  await pick("Открыть файл…","cancel",null,fileScope);
  same((await command("app_info")).dbPath,a,"open cancelled");
  f("91:10","Отмена выбора файла","Текущий файл и числа прежние","Выбор отменён; "+same(original,a,"open cancel"));
  await pick("Открыть файл…","open",alt,fileScope); await home();
  const info=await command("app_info"); assert.equal(resolve(info.dbPath).toLowerCase(),resolve(alt).toLowerCase());
  f("91:10","Открыть ранее исключённый файл","Активный бюджет из выбранного файла",same(info.dbPath,altSnap,"native open"));
  await shot("opened-budget");
}
async function backup() {
  const a=snapshot(original); remembered("baseline",a);
  await pick("Сделать копию","cancel",null,vaultScope);
  assert.equal(existsSync(manual),false); same(original,a,"cancel copy");
  v("297:8","Отмена сохранения файла","Бюджет прежний","Выбор отменён; файл не появился");
  await pick("Сделать копию","proposed",manual,vaultScope);
  await waitText(b,'[data-testid="backup-msg"]',/Копия сохранена и проверена/);
  const saved=await b.$('[data-testid="backup-verified"] .file-path').getText();
  assert.ok(existsSync(saved) && saved.endsWith(".db"));
  if (picker==="native") assert.match(saved,/p-treasury-\d+-\d+\.db$/i);
  v("297:8","Сохранить копию с предложенным именем","Создана самодостаточная копия с исходными данными",saved+"; "+same(saved,a,"saved backup"));
  const invalid=join(work,"unrelated.db");
  writeFileSync(invalid,"Учебный файл без базы Kazna");
  await pick("Проверить файл копии…","open",invalid,vaultScope);
  await waitText(b,'[data-testid="backup-card"] [role="alert"]',/не файл данных Kazna/);
  assert.match(read(original,"SELECT value FROM settings WHERE key='backup_verify_error'")[0].value,/не файл данных Kazna/);
  await shot("invalid-copy-rejected");
  v("301:8","Проверить неподходящий файл","Пользователь видит причину; исходные данные целы",
    "Предупреждение «это не файл данных Kazna» отображено и записано в SQLite; "+same(original,a,"rejected foreign file"));
  // Give the verifier a different path from the auto-verification performed
  // immediately after saving, so the original status cannot satisfy the check.
  const verified=join(work,"separate-verification.db");
  copyFileSync(saved,verified);
  await pick("Проверить файл копии…","open",verified,vaultScope);
  await waitText(b,'[data-testid="backup-verified"] .file-path',/separate-verification\.db/i);
  await gone('[data-testid="backup-verify-error"]');
  assert.equal(read(original,"SELECT value FROM settings WHERE key='backup_verify_error'")[0].value,"");
  v("301:8","Проверить выбранный файл","Путь в статусе изменился; предыдущая ошибка сброшена",
    same(verified,a,"verified source copy")+"; "+same(original,a,"verified live budget"));
  await seedExpense(original,777,"Учебная покупка B"); await command("set_setting",{key:"month_start_day",value:"21"});
  const changed=snapshot(original); remembered("before-replacement",changed); assert.equal(changed.operations.length,2);
  await pick("Восстановить из копии","cancel",null,vaultScope);
  same(original,changed,"cancel picker"); await gone('[role="dialog"]');
  await pick("Восстановить из копии","open",saved,vaultScope);
  await waitText(b,'[role="dialog"]',/счетов 1, операций 1/); await shot("restore-preview");
  v("342:6","Выбрать файл восстановления","Предпросмотр: 1 счёт, 1 операция; рабочие 2 операции не тронуты",same(original,changed,"preview"));
  await click(b,"Отмена",modal); await gone('[role="dialog"]');
  v("356:12","Отмена восстановления","Две операции и прежние настройки в активной БД",same(original,changed,"cancel restore"));
  await pick("Восстановить из копии","open",saved,vaultScope); await has('[role="dialog"]');
  await click(b,"Восстановить",modal);
  await waitText(b,'[data-testid="backup-msg"]',/Данные восстановлены/);
  const safety=priorSnapshot(changed);
  v("359:12","Подтвердить восстановление","Исходная копия активна, прежние 2 операции в аварийной копии",
    same(original,a,"restore applied")+"; отдельная копия "+safety.join(", "));
  await shot("restored-budget");
  const custom=join(work,"chosen-name.db");
  await pick("Сделать копию","save",custom,vaultScope);
  await waitText(b,'[data-testid="backup-msg"]',/chosen-name\.db/i);
  v("297:8","Сохранить копию с новым именем","Пользовательский путь и полная база",same(custom,a,"custom name"));
}
async function transfer() {
  const a=snapshot(original); remembered("baseline",a);
  const from=join(work,"from-other-pc","Kazna"); mkdirSync(from,{recursive:true});
  const file=join(from,"Мой бюджет.ptreasury");
  // Fixture preparation through Kazna command only. Every transfer under test is triggered by an on-screen button.
  await command("backup_now",{path:file});
  same(file,a,"transfer fixture");
  await seedExpense(original,9901,"На новом компьютере"); await command("set_setting",{key:"month_start_day",value:"7"});
  const changed=snapshot(original); remembered("before-replacement",changed);
  const openDialog=()=>click(b,"Перенести данные с другого компьютера",vaultScope);
  await openDialog(); await waitText(b,'[role="dialog"]',/Данные с другого компьютера/);
  v("304:8","Открыть перенос","Мастер переноса","Открыт диалог «Данные с другого компьютера»");
  await click(b,"Закрыть",modal); await gone('[role="dialog"]');
  v("137:8","Закрыть перенос","Бюджет сохраняется",same(original,changed,"transfer close"));
  await openDialog();
  await pick("Показать папку…","folder",from,modal);
  const candidate = '//*[@data-testid="found-row"][.//*[contains(text(),"from-other-pc")]]';
  await has(candidate);
  v("130:8","Показать папку","Найдена копия другого бюджета","В списке путь from-other-pc и имя Мой бюджет");
  await click(b,"Перенести",candidate);
  await waitText(b,'[data-testid="transfer-summary"]',/счетов 1, операций 1/); await shot("transfer-preview");
  v("39:6","Выбрать найденную копию","Предпросмотр с одной операцией",same(original,changed,"transfer preview"));
  await click(b,"Назад",modal); await has(candidate);
  v("101:10","Назад из предпросмотра","Снова выбор, бюджет без изменений",same(original,changed,"transfer back"));
  await pick("Выбрать файл…","cancel",null,modal); await has(candidate);
  await pick("Выбрать файл…","open",file,modal);
  await waitText(b,'[data-testid="transfer-summary"]',/счетов 1, операций 1/);
  v("133:8","Выбрать явный файл для переноса","Отмена не заменяет БД; явный выбор открывает предпросмотр",same(original,changed,"transfer file preview"));
  await click(b,"Перенести",modal);
  await waitText(b,'[data-testid="backup-msg"]',/Данные перенесены/);
  const safety=priorSnapshot(changed);
  v("104:10","Подтвердить перенос","Активна исходная копия, прежние 2 операции доступны отдельно",
    same(original,a,"transfer confirmed")+"; отдельная копия "+safety.join(", "));
  await shot("transferred-budget");
}
async function places() {
  const a=snapshot(original);
  const check=b.$('input[name="vaultOn"]');
  if (!(await check.isSelected())) {await check.click();}
  await check.click(); await waitText(b,'[data-testid="backup-card"]',/Папка сохранности выключена/);
  assert.equal(await b.$('[data-testid="verify-backup"]').isEnabled(),false);
  await check.click(); await b.waitUntil(async()=>await b.$('[data-testid="verify-backup"]').isEnabled());
  v("216:8","Отключить и включить автокопии","Состояние чекбокса, доступность проверки, vault_on=1",String(read(original,"SELECT value FROM settings WHERE key='vault_on'")[0].value));
  const keep=await b.$('select[name="autobackupKeep"]'); await keep.selectByAttribute("value","3");
  await b.waitUntil(()=>read(original,"SELECT value FROM settings WHERE key='autobackup_keep'")[0].value==="3");
  v("283:10","Хранить 3 копии","SQLite хранит значение 3","3");
  await click(b,"Сохранить сейчас",vaultScope); const copy=join(vault,"Мой бюджет.ptreasury");
  await b.waitUntil(()=>existsSync(copy),{timeout:15000});
  await waitText(b,'[data-testid="vault-synced"]',/\d/);
  v("268:8","Сохранить сейчас","Последняя копия соответствует бюджету",same(copy,a,"sync"));
  await click(b,"Проверить восстановление",vaultScope); await waitText(b,'[data-testid="backup-verified"]',/восстановление проходит.*счетов 1, операций 1/);
  v("277:8","Проверить восстановление","Одна учётная запись и операция восстановимы",same(original,a,"verify memory only"));
  await Promise.all([native("explorer",vault), click(b,"Открыть папку",vaultScope)]);
  v("271:8","Открыть папку","Проводник открыл реальный путь хранилища","Shell.Application подтвердил точный путь Explorer");
  await click(b,"Сменить папку",vaultScope); await has('[data-testid="vault-place"]');
  v("274:8","Сменить папку","Открывается список мест","Виден выбор мест и кнопка «Отмена»");
  await click(b,"Отмена",modal); await gone('[role="dialog"]');
  const current=await b.$('[data-testid="vault-dir"]').getText(); assert.equal(resolve(current).toLowerCase(),resolve(vault).toLowerCase());
  v("172:8","Отменить смену места","Прежняя папка остаётся активной",current);
  const other = join(work,"new-drive"); mkdirSync(other);
  await click(b,"Сменить папку",vaultScope); await pick("Другая папка или флешка…","folder",other,modal);
  await gone('[role="dialog"]'); await waitText(b,'[data-testid="vault-dir"]',/new-drive/);
  const otherCopy=join(other,"Kazna","Мой бюджет.ptreasury");
  await b.waitUntil(()=>existsSync(otherCopy),{timeout:15000});
  v("168:8","Сменить место на выбранную папку","В новой папке появляется полная копия",same(otherCopy,a,"custom folder"));
  await click(b,"Сменить папку",vaultScope);
  await clickControl(b,await b.$('[data-testid="vault-place"]'),"Место по умолчанию");
  await gone('[role="dialog"]'); const def=await b.$('[data-testid="vault-dir"]').getText();
  assert.equal(resolve(def).toLowerCase(),resolve(vault).toLowerCase()); assert.ok(existsSync(otherCopy));
  v("158:12","Вернуть место по умолчанию","Исходная папка активна, прошлая копия доступна",def);
  await shot("vault-place");
}

try {
  await begin();
  activeStep=group;
  await ({files,backup,transfer,places}[group])();
} catch (error) {
  console.error("FAILED",activeStep,error);
  if (b) {
    try {await shot("failure");} catch {}
    try {writeFileSync(join(evidence,"failure.txt"),String(error.stack)+"\n"+await b.$("body").getText());} catch {}
  }
  process.exitCode=1;
} finally {
  if (b) await stop(b);
}
