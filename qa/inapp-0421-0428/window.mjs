import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const [phase, exeName, evidenceName] = process.argv.slice(2);
assert(['before','after','detect-only'].includes(phase));
assert.equal(process.platform, 'win32');
assert(isAbsolute(exeName) && isAbsolute(evidenceName), 'Нужны абсолютные пути EXE и доказательств');
const detectOnly = phase === 'detect-only';
const old = phase !== 'after';
const exe = resolve(exeName), evidence = resolve(evidenceName);
const scratch = resolve(process.env.KAZNA_QA_SCRATCH || dirname(evidence));
if (!detectOnly) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.ok(process.env.RUNNER_TEMP && scratch.toLowerCase().startsWith(resolve(process.env.RUNNER_TEMP).toLowerCase()+'\\'));
  assert.ok(!process.env.PTREASURY_DATA_DIR && !process.env.PTREASURY_UPDATE_URL, 'Штатные пути базы и публичного канала');
} else {
  assert.ok(process.env.PTREASURY_DATA_DIR && resolve(process.env.PTREASURY_DATA_DIR).startsWith(scratch));
  assert.ok(!process.env.PTREASURY_UPDATE_URL);
}
const dbPath = resolve(detectOnly ? process.env.PTREASURY_DATA_DIR : join(process.env.APPDATA,'app.kazna.desktop'),'budget.db');
assert.ok(existsSync(dbPath), 'Учебный бюджет должен быть подготовлен');
mkdirSync(evidence, {recursive:true});
const helpers=await import(pathToFileURL(resolve('e2e/app.mjs')).href);
const { remote }=await import(pathToFileURL(createRequire(resolve('package.json')).resolve('webdriverio')).href);
const normalise=v=>resolve(v).toLowerCase();
const reportName=join(evidence,phase+'.json');
const report={phase,exe,sha256:createHash('sha256').update(readFileSync(exe)).digest('hex'),dbPath,events:[]};
function event(action,more={}){const mark={at:new Date().toISOString(),action,...more};report.events.push(mark);console.log(JSON.stringify(mark));writeFileSync(reportName,JSON.stringify(report,null,2));}
function pids(){
  const script="$p=@(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($env:KAZNA_QA_BIN)) -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:KAZNA_QA_BIN } | Select-Object -ExpandProperty Id); ConvertTo-Json -InputObject $p -Compress";
  return JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,env:{...process.env,KAZNA_QA_BIN:exe}}).trim()||'[]');
}
const port=old?4452:4453;
const env={...process.env};
if(detectOnly) env.WEBVIEW2_USER_DATA_FOLDER=join(scratch,'webview');
const driver=spawn('msedgedriver.exe',['--port='+port],{env,windowsHide:true,stdio:'ignore'});
driver.on('error',e=>{report.driverError=e.message});
let browser, clicked=false;
try{
  const expiry=Date.now()+12000;
  let ready=false;
  do{
    try{const res=await fetch('http://127.0.0.1:'+port+'/status',{signal:AbortSignal.timeout(1000)});ready=res.ok;}
    catch{}
    if(!ready) await sleep(300);
  }while(!ready && Date.now()<expiry);
  assert(ready,'EdgeDriver не готов: '+(report.driverError||''));
  assert.deepEqual(pids(),[], 'Перед запуском установленное приложение уже открыто');
  browser=await remote({hostname:'127.0.0.1',port,path:'/',logLevel:'error',connectionRetryCount:0,connectionRetryTimeout:45000,
    capabilities:{browserName:'webview2','wdio:enforceWebDriverClassic':true,'ms:edgeOptions':{binary:exe,args:detectOnly?['--data-dir='+process.env.PTREASURY_DATA_DIR]:[]}}});
  async function cmd(name,args={}){
    const reply=await browser.executeAsync((name,args,done)=>window.__TAURI_INTERNALS__.invoke(name,args).then(value=>done({value}),e=>done({error:String(e)})),name,args);
    assert.equal(reply.error,undefined,name+': '+reply.error);return reply.value;
  }
  await browser.$('main h1').waitForDisplayed({timeout:25000});
  const [info,accounts,tx,settings]=await Promise.all([cmd('app_info'),cmd('list_accounts',{includeArchived:true}),cmd('list_transactions',{filter:{}}),cmd('get_settings')]);
  assert.equal(info.version,old?'0.42.1':'0.42.8');
  assert.equal(info.schemaVersion,old?31:32);
  assert.equal(normalise(info.dbPath),normalise(dbPath));
  assert.equal(info.portable,false);
  const expected={'Учебная карта Рубин':['RUB',1973456],'Учебные наличные':['RUB',43211],'Учебный доллар':['USD',5775]};
  const balances=Object.fromEntries(accounts.map(a=>[a.name,[a.currencyCode,a.balance]]));
  assert.deepEqual(balances,expected);
  assert.equal(tx.total,7);
  assert.ok(tx.items.some(t=>t.payee==='Учебная мастерская'&&t.amount===23456));
  assert.equal(settings.update_check,'0');
  const totals=await cmd('totals',{date:'2026-11-18'});
  const period=await cmd('period_summary',{from:'2026-11-10',to:'2026-12-09'});
  assert.deepEqual([period.income,period.expense],[123456,47039]);
  assert.equal(totals.total,2536417);
  const prefKeys=['p-treasury-theme','p-treasury-scale','kazna.txnOpen'];
  const prefs=await browser.execute(keys=>Object.fromEntries(keys.map(k=>[k,localStorage.getItem(k)])),prefKeys);
  assert.deepEqual(prefs,{'p-treasury-theme':'dark','p-treasury-scale':'110','kazna.txnOpen':'dialog'});
  const live=pids();
  assert.equal(live.length,1,'Ожидалось одно окно Kazna этого EXE');
  Object.assign(report,{version:info.version,schema:info.schemaVersion,oldPid:old?live[0]:undefined,pid:live[0],window:await browser.getWindowHandle(),
    preMigrationBackup:info.preMigrationBackup,balances,count:tx.total,total:totals.total,periodIncome:period.income,periodExpense:period.expense,preferences:prefs});
  event('Открыт учебный бюджет');
  await helpers.openSettings(browser,'about');
  const versionLine=old?'#set-about dl dd':'.updates-installed';
  const versionText=await helpers.waitText(browser,versionLine,old?/0\.42\.1/:/0\.42\.8/,10000);
  await browser.saveScreenshot(join(evidence,phase+'-settings.png'));
  event('Настройки → О программе',{versionText});
  if(old) {
    const check=browser.$('//*[@data-testid="updates-card"]//button[normalize-space()="Проверить обновления"]');
    await check.waitForClickable({timeout:10000});await check.click();
    event('Нажата «Проверить обновления»');
    const offer=await helpers.waitText(browser,'[role="dialog"] [data-testid="update-version"]',/0\.42\.8[\s\S]*0\.42\.1/,60000);
    report.offeredVersion='0.42.8';
    event('Приложение предложило обновление',{offer});
    await browser.saveScreenshot(join(evidence,phase+'-offer.png'));
    if(!detectOnly) {
      const snapshot=join(scratch,'before.sqlite');
      execFileSync('python',[process.env.KAZNA_QA_FIXTURE || resolve('qa/inapp-0421-0428/fixture.py'),'snapshot',dbPath,snapshot],{stdio:'inherit',windowsHide:true});
      report.beforeSnapshot=snapshot;
      const action=browser.$('//*[@role="dialog"]//button[normalize-space()="Обновить"]');
      await action.waitForClickable({timeout:10000});
      event('Отправляется нажатие «Обновить»');
      await action.click();clicked=true;report.clicked=true;
      event('WebDriver подтвердил нажатие «Обновить»');
      // Не отправлять DELETE сессии и не завершать дерево с NSIS.
      const expiry=Date.now()+160000;
      let current=pids();
      while(current.includes(report.oldPid)&&Date.now()<expiry){
        try { const text=await browser.execute(()=>document.querySelector('[role="dialog"] [role="alert"]')?.textContent?.trim()); if(text){report.installError=text;break;} } catch {}
        await sleep(700);
        current=pids();
      }
      assert(!report.installError,report.installError);
      assert(!current.includes(report.oldPid),'Старая Kazna осталась открытой после нажатия «Обновить»');
      event('Старый процесс завершился',{oldPid:report.oldPid});
    }
  }
} catch(e){
  report.error=String(e.stack||e);
  try {if(browser) await browser.saveScreenshot(join(evidence,phase+'-error.png'));} catch{}
  if(browser) try{report.screen=(await browser.$('body').getText()).slice(-2500);}catch{}
  event('Ошибка проверки');
  throw e;
} finally {
  if(browser&&!clicked) try{await browser.deleteSession()}catch{}
  // Остановить только собственный EdgeDriver, без SIGTERM дочерним NSIS/Kazna.
  if(driver.exitCode===null&&driver.pid) driver.kill();
}


