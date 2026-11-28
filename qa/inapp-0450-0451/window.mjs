import assert from 'node:assert/strict';
import { fontProbe } from './font-probe.mjs';
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
function appProcesses(){
  const script="$p=@(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($env:KAZNA_QA_BIN)) -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:KAZNA_QA_BIN } | ForEach-Object { [PSCustomObject]@{ pid=$_.Id; hwnd=$_.MainWindowHandle.ToInt64() } }); ConvertTo-Json -InputObject $p -Compress";
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
  assert.deepEqual(appProcesses(),[], 'Перед запуском установленное приложение уже открыто');
  browser=await remote({hostname:'127.0.0.1',port,path:'/',logLevel:'error',connectionRetryCount:0,connectionRetryTimeout:45000,
    capabilities:{browserName:'webview2','wdio:enforceWebDriverClassic':true,'ms:edgeOptions':{binary:exe,detach:phase==='before',args:detectOnly?['--data-dir='+process.env.PTREASURY_DATA_DIR]:[]}}});
  async function cmd(name,args={}){
    const reply=await browser.executeAsync((name,args,done)=>window.__TAURI_INTERNALS__.invoke(name,args).then(value=>done({value}),e=>done({error:String(e)})),name,args);
    assert.equal(reply.error,undefined,name+': '+reply.error);return reply.value;
  }
  await browser.$('main h1').waitForDisplayed({timeout:25000});
  if (old) {
    await helpers.openSection(browser,'Главная');
    await helpers.clickControl(browser, await browser.$('[data-testid="home-customize"]'), 'Настроить Главную');
    const recent=await browser.$('[data-block="recent"] [data-testid="home-half"]');
    await helpers.clickControl(browser, recent, 'Сделать последние операции в половину ширины');
    await helpers.saveHomeEditor(browser);
    event('В 0.45.0 изменили ширину последних операций и сохранили личную раскладку');
  }
  const [info,accounts,tx,settings]=await Promise.all([cmd('app_info'),cmd('list_accounts',{includeArchived:true}),cmd('list_transactions',{filter:{}}),cmd('get_settings')]);
  assert.equal(info.version,old?'0.45.0':'0.45.1');
  assert.equal(info.schemaVersion,32);
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
  const prefKeys=['p-treasury-theme','p-treasury-scale','kazna.txnOpen','kazna.look'];
  await browser.waitUntil(()=>browser.execute(()=>document.documentElement.dataset.density==='compact'),{timeout:10000});
  const prefs=await browser.execute(keys=>Object.fromEntries(keys.map(k=>[k,localStorage.getItem(k)])),prefKeys);
  assert.deepEqual(prefs,{'p-treasury-theme':'dark','p-treasury-scale':'110','kazna.txnOpen':'dialog','kazna.look':'{"density":"compact","accent":"mint"}'});
  const appearance=await browser.execute(()=>({
    theme:document.documentElement.dataset.theme,
    density:document.documentElement.dataset.density,
    accent:document.documentElement.getAttribute('data-accent'),
    palette:document.documentElement.getAttribute('data-palette')
  }));
  assert.deepEqual(appearance,{theme:'dark',density:'compact',accent:'mint',palette:'petrol'});
  const journal=tx.items.slice().sort((left,right)=>left.id.localeCompare(right.id));
  assert.equal(journal.length,7);
  if (!old) {
    const prior=JSON.parse(readFileSync(join(evidence,'before.json'),'utf8'));
    assert.deepEqual(journal,prior.journal,'Все поля семи операций, возвращённых установленной программой');
    assert.deepEqual(settings,prior.settings,'Все настройки, прочитанные установленной программой');
    assert.deepEqual(balances,prior.balances);
    assert.deepEqual(prefs,prior.preferences);
  }
  const live=appProcesses().map(process=>process.pid);
  assert.equal(live.length,1,'Ожидалось одно окно Kazna этого EXE');
  Object.assign(report,{version:info.version,schema:info.schemaVersion,oldPid:old?live[0]:undefined,pid:live[0],window:await browser.getWindowHandle(),
    preMigrationBackup:info.preMigrationBackup,balances,journal,settings,count:tx.total,total:totals.total,periodIncome:period.income,periodExpense:period.expense,preferences:prefs,appearance});
  event('Открыт учебный бюджет');
  await helpers.openSection(browser,'Главная');
  await browser.$('.home-grid > [data-block="accounts"] [data-testid="home-account"]').waitForDisplayed();
  const layout=await browser.execute(()=>Array.from(document.querySelectorAll('.home-grid > [data-block]'), el=>({block:el.dataset.block,half:el.classList.contains('half')})));
  assert.deepEqual(layout,[{block:'accounts',half:true},{block:'recent',half:true},{block:'tiles',half:false}], 'Порядок, ширина и скрытые карточки из 0.45.0');
  assert.equal(JSON.parse(settings.home_layout).v,3);
  const geometry=await browser.execute(()=>({
    viewport:window.innerWidth, cards:[...document.querySelectorAll('.home-grid > [data-block]')].map(el=>{
      const {x,y,width}=el.getBoundingClientRect(); return {block:el.dataset.block,x,y,width};
    })
  }));
  if (geometry.viewport>900) {
    const [accountsCard,recentCard,balanceCard]=geometry.cards;
    assert(Math.abs(accountsCard.y-recentCard.y)<2 && recentCard.x>accountsCard.x && balanceCard.y>accountsCard.y);
    assert(Math.abs(accountsCard.width-recentCard.width)<2 && balanceCard.width>1.8*accountsCard.width);
  }
  report.layout=layout;
  report.geometry=geometry;
  if(!old) assert.deepEqual(layout,JSON.parse(readFileSync(join(evidence,'before.json'),'utf8')).layout);
  event('Старая раскладка Главной, тема, плотность и акцент',{layout,appearance});
  report.fonts={
    wordmark:await fontProbe(browser,port,'.brand-wordmark',/Segoe.*Variable.*Text/i),
    heading:await fontProbe(browser,port,'main h1',/Segoe.*Variable.*Display/i),
    balance:await fontProbe(browser,port,'[data-testid="explain-balance"] .money',/Segoe.*Variable.*Display/i),
  };
  await browser.saveScreenshot(join(evidence,phase+'-home.png'));
  await helpers.openSection(browser,'Операции');
  await helpers.click(browser,'Всё время','//*[@data-testid="period"]');
  await helpers.waitText(browser,'[data-testid="txn-count"]',/Показано 7 из 7/);
  await browser.saveScreenshot(join(evidence,phase+'-journal.png'));
  await helpers.openSection(browser,'Счета');
  const accountReadouts = {};
  for (const [name, amount] of Object.entries({'Учебная карта Рубин':'19 734,56','Учебные наличные':'432,11','Учебный доллар':'57,75'})) {
    const selector='[data-testid="account-row"][data-name="'+name+'"] td.num';
    accountReadouts[name]=await helpers.waitText(browser,selector,helpers.money(amount));
  }
  event('Остатки в трёх строках экрана Счета',{accountReadouts});
  await browser.saveScreenshot(join(evidence,phase+'-accounts.png'));
  await helpers.openSettings(browser,'about');
  const details=await browser.$('[data-testid="about-details"]');
  if (!(await browser.execute(node=>node.open,details))) await helpers.clickControl(browser,await details.$('summary'),'Технические сведения');
  report.fonts.path=await fontProbe(browser,port,'//dt[normalize-space()="Файл данных"]/following-sibling::dd[1]',old?/Cascadia|Consolas|Courier/i:/Segoe.*Variable.*Text/i);
  await helpers.clickControl(browser,await browser.$('button[aria-label="Поиск"]'),'Поиск');
  report.fonts.keys=await fontProbe(browser,port,'//*[@class="palette-foot"]//kbd[normalize-space()="Enter"]',old?/Consolas|Cascadia|Courier/i:/Segoe.*Variable.*Text/i);
  await browser.saveScreenshot(join(evidence,phase+'-keys.png'));
  await browser.keys('Escape');
  await browser.$('.palette-foot').waitForExist({reverse:true});
  event('Шрифты WebView2, фактически отрисованные для текста, заголовка, баланса, путей и клавиш',report.fonts);
  const versionText=await helpers.waitText(browser,'.updates-installed',old?/0\.45\.0/:/0\.45\.1/,10000);
  await browser.saveScreenshot(join(evidence,phase+'-settings.png'));
  event('Настройки → О программе',{versionText});
  if(old) {
    const check=browser.$('//*[@data-testid="updates-card"]//button[normalize-space()="Проверить обновления"]');
    await check.waitForClickable({timeout:10000});await check.click();
    event('Нажата «Проверить обновления»');
    const offer=await helpers.waitText(browser,'[role="dialog"] [data-testid="update-version"]',/0\.45\.1[\s\S]*0\.45\.0/,60000);
    report.offeredVersion='0.45.1';
    event('Приложение предложило обновление',{offer});
    await browser.saveScreenshot(join(evidence,phase+'-offer.png'));
    if(!detectOnly) {
      const snapshot=join(scratch,'before.sqlite');
      execFileSync('python',[process.env.KAZNA_QA_FIXTURE || resolve('qa/inapp-0450-0451/fixture.py'),'snapshot',dbPath,snapshot],{stdio:'inherit',windowsHide:true});
      report.beforeSnapshot=snapshot;
      const action=browser.$('//*[@role="dialog"]//button[normalize-space()="Обновить"]');
      await action.waitForClickable({timeout:10000});
      event('Отправляется нажатие «Обновить»');
      await action.click();clicked=true;report.clicked=true;
      event('WebDriver подтвердил нажатие «Обновить»');
      // Не отправлять DELETE сессии и не завершать дерево с NSIS.
      const expiry=Date.now()+160000;
      let current=appProcesses();
      while(current.some(process=>process.pid===report.oldPid)&&Date.now()<expiry){
        try { const text=await browser.execute(()=>document.querySelector('[role="dialog"] [role="alert"]')?.textContent?.trim()); if(text){report.installError=text;break;} } catch {}
        await sleep(700);
        current=appProcesses();
      }
      assert(!report.installError,report.installError);
      assert(!current.some(process=>process.pid===report.oldPid),'Старая Kazna осталась открытой после нажатия «Обновить»');
      event('Старый процесс завершился',{oldPid:report.oldPid});
      // Оставляем родительский EdgeDriver живым, пока NSIS устанавливает и запускает Kazna.
      const windowDeadline=Date.now()+90000;
      while(!current.some(process=>process.pid!==report.oldPid&&process.hwnd!==0)&&Date.now()<windowDeadline){
        await sleep(500);
        current=appProcesses();
      }
      const fresh=current.find(process=>process.pid!==report.oldPid&&process.hwnd!==0);
      report.relaunchObservation={driverPid:driver.pid,windows:current,newWindow:fresh??null};
      // Этап restart независимо проверит версию, хеш и базу в автоматически открытом окне.
      event(fresh?'Обнаружено новое окно при работающем EdgeDriver':'За 90 секунд новое окно не появилось',report.relaunchObservation);
    }
  }
} catch(e){
  report.error=String(e.stack||e);
  try {if(browser&&!clicked) await browser.saveScreenshot(join(evidence,phase+'-error.png'));} catch{}
  if(browser&&!clicked) try{report.screen=(await browser.$('body').getText()).slice(-2500);}catch{}
  event('Ошибка проверки');
  throw e;
} finally {
  if(browser&&!clicked) try{await browser.deleteSession()}catch{}
  // Первую службу оставляем до очистки одноразовой ВМ. После проверки нового окна
  // сценарий использует отдельный порт; следующий этап сам закроет обнаруженную Kazna.
  if(clicked) driver.unref();
  else if(driver.exitCode===null&&driver.pid) driver.kill();
}
