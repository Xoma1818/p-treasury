import assert from "node:assert/strict";
import fs from "node:fs";
import {join} from "node:path";
import {execFileSync} from "node:child_process";
import {start,stop,openSettings,clickControl,click,fill,choose,waitText} from "./app.mjs";
const [fixture,out,group]=process.argv.slice(2);
const log=[],dialog='//*[@role="dialog"]';let b;
async function api(cmd,args={}){
 const r=await b.executeAsync((cmd,args,done)=>window.__TAURI_INTERNALS__.invoke(cmd,args).then(value=>done({value}),e=>done({error:String(e)})),cmd,args);
 assert.equal(r.error,undefined,cmd+" "+r.error);return r.value;
}
const tab=(name)=>b.$('select[name="'+name+'"]');
async function press(q){await clickControl(b,await b.$(q),q);}
function check(id,action,expected,actual){assert.deepEqual(actual,expected,action);log.push({id,action,expected,actual,status:"pass"});}
async function onboarding(){
 const file="src/screens/Onboarding.tsx:";
 await b.$('select[name="baseCurrency"] option[value="USD"]').waitForExist();await (await tab("baseCurrency")).selectByAttribute("value","USD");
 await click(b,"Далее");await fill(b,"account-name-0","Учебная наличность");await (await tab("account-currency-0")).selectByAttribute("value","USD");await fill(b,"account-balance-0","123,45");
 await click(b,"Назад");check(file+"186:12","Вернуться к выбранной валюте","USD",await (await tab("baseCurrency")).getValue());
 await click(b,"Далее");assert.equal(await b.$('[name="account-name-0"]').getValue(),"Учебная наличность");await click(b,"Далее");
 await press('[name="defaultCategories"]');await click(b,"Начать");await waitText(b,"main h1",/Главная/);
 check(file+"89:16","Сохранить выбранную валюту первого бюджета","USD",(await api("get_settings")).base_currency);
 check(file+"177:14","Не заполнять новый бюджет рекомендуемыми категориями",false,(await api("list_categories",{includeArchived:true})).some(c=>c.name==="Питание"));
 assert.equal((await api("list_accounts",{includeArchived:false})).find(c=>c.name==="Учебная наличность").balance,12345);
}
async function updates(){
 const file="src/components/Updates.tsx:";await openSettings(b,"about");
 await click(b,"Проверить обновления");
 await waitText(b,'[data-testid="update-result"]',/Установлена последняя версия/);
 check(file+"142:10","Проверить опубликованный канал","Установлена последняя версия.",await b.$('[data-testid="update-result"]').getText());
 const clientFound=await b.execute(()=>{
   const el=document.querySelector("#set-updates");
   for(let f=el[Object.keys(el).find(k=>k.startsWith("__reactFiber$"))];f;f=f.return){
     const value=f.memoizedProps?.value;
     if(value&&typeof value.getQueryCache==="function"){window.__testClient=value;return true;}
   }
   return false;
 });
 assert.equal(clientFound,true);
 const retired=await b.execute(()=>{
   const q=window.__testClient.getQueryCache().find({queryKey:["appInfo"],exact:true});
   if(!q)return false;q.setState({status:"error",error:new Error("Учебный сбой чтения сведений")});return true;
 });
 assert.ok(retired);await click(b,"Повторить загрузку сведений");await b.$('button=Повторить загрузку сведений').waitForExist({reverse:true});
 check(file+"156:71","Повторить настоящее чтение app_info после имитации ошибки","0.45.1",await b.$('[data-testid="app-version"]').getText());
 assert.equal((await api("app_info")).portable,true);
 // Simulate only the availability response. No download or installation takes place in this branch.
 await b.execute(()=>{
   const qc=window.__testClient,fetch=qc.fetchQuery.bind(qc);
   qc.fetchQuery=opts=>opts.queryKey[0]==="available-update"?Promise.resolve({configured:true,current:"0.45.1",version:"0.45.2",notes:"Учебное сообщение"}):fetch(opts);
 });
 await click(b,"Проверить обновления");await b.$('[data-testid="update-version"]').waitForDisplayed();await click(b,"Скопировать ссылку",dialog);
 await waitText(b,'.portable-update [role="status"]',/скопирована/);
 const copied=execFileSync("pwsh",["-NoProfile","-Command","Get-Clipboard -Raw"],{encoding:"utf8"}).trim();
 check(file+"46:12","Скопировать действительную ссылку из учебного предложения","https://github.com/Xoma1818/p-treasury-releases/releases/latest",copied);
 await click(b,"Позже",dialog);await b.$('[role="dialog"]').waitForExist({reverse:true});
 check(file+"44:8","Закрыть учебное предложение без установки","0.45.1",(await api("app_info")).version);
 // Same published binary without the portable marker exercises the installed-mode setting.
 await stop(b);b=undefined;const installed=join(out,"installed-mode");fs.mkdirSync(installed);
 const exe=join(installed,"Kazna.exe");fs.copyFileSync(process.env.PTREASURY_BIN,exe);
 ({browser:b}=await start(fixture,{bin:exe,homeDefaults:true,verboseDriver:false}));await openSettings(b,"about");
 assert.equal((await api("app_info")).portable,false);const toggle='[name="updateCheck"]';
 for(const v of ["1","0"]){await press(toggle);await b.waitUntil(async()=>(await api("get_settings")).update_check===v);check(file+"167:12","Проверять обновления при запуске = "+v,v,(await api("get_settings")).update_check);}
}
async function csv(){
 const file="src/components/CsvProfileEditor.tsx:",dt="src/components/DataTools.tsx:";
 const name=join(out,"учебный.csv");fs.writeFileSync(name,"Дата выдачи;Касса;Оплата;Описание\r\n11/23/2026;29,87;;Город\r\n");
 await openSettings(b,"data");await click(b,"Импорт выписки или CSV");await press('details.import-overview-help summary');
 check(dt+"353:10","Показать правила разбора файла",true,await b.$("details.import-overview-help p").isDisplayed());
 await press('[data-testid="open-import-history"]');await b.$('[data-testid="history-empty"]').waitForDisplayed();check(dt+"348:10","Открыть историю из формы",true,await b.$('[data-testid="history-empty"]').isDisplayed());
 await click(b,"Закрыть",dialog);if(!(await b.$('[role="dialog"]').isExisting()))await click(b,"Импорт выписки или CSV");
 await b.execute(v=>window.__ptPick=[v],name);await click(b,"Выбрать файл",dialog);await click(b,"Настроить столбцы CSV",dialog);
 const editor='[data-testid="csv-profile-editor"]';await b.$(editor+" table").waitForDisplayed();
 const set=async(value)=>{const el=await b.$('//section[@data-testid="csv-profile-editor"]//select[option[@value="'+value+'"]]');await el.selectByAttribute("value",value);};
 await set("semicolon");await set("utf8");await (await tab("csvAccount")).selectByIndex(1);
 await choose(b,"csv-column-date","Дата выдачи");await set("monthFirstSlash");await set("debitCredit");await choose(b,"csv-column-debit","Касса");await choose(b,"csv-column-credit","Оплата");await choose(b,"csv-column-payee","Описание");
 await fill(b,"csvProfileName","Учебный профиль");await click(b,"Сохранить профиль",dialog);await waitText(b,editor+' [role="status"]',/Профиль сохранён/);
 const profiles=await api("list_csv_profiles");const found=profiles.find(x=>x.name==="Учебный профиль");assert.ok(found);
 for(const [id,k,v] of [["175:12","delimiter","semicolon"],["188:12","encoding","utf8"],["224:14","dateFormat","monthFirstSlash"]])check(file+id,"Сохранить "+k,v,found.mapping[k]);
 check(file+"233:14","Разные столбцы для списания и поступления","debitCredit",found.mapping.amount.kind);
 await click(b,"Проверить строки",dialog);await waitText(b,'[data-testid="import-summary"]',/строк 1, без ошибок 1/);
 await click(b,"Настроить столбцы CSV",dialog);await choose(b,"csvProfile","Учебный профиль");await click(b,"Удалить профиль",dialog);await waitText(b,editor+' [role="status"]',/Профиль удалён/);
 check(file+"257:24","Удалить профиль",0,(await api("list_csv_profiles")).filter(x=>x.name==="Учебный профиль").length);
 await click(b,"Назад",dialog);await b.$(editor).waitForExist({reverse:true});check(file+"261:8","Вернуться к выписке",false,await b.$(editor).isExisting());
 await click(b,"Закрыть",dialog);await b.$('[role="dialog"]').waitForExist({reverse:true});check(dt+"532:8","Закрыть форму без импорта",7,(await api("list_transactions",{filter:{limit:1}})).total);
}
try{let dir=fixture;if(group==="onboarding"){dir=join(out,"new-budget");fs.mkdirSync(dir);}
 ({browser:b}=await start(dir,{homeDefaults:true,verboseDriver:false}));await ({csv,updates,onboarding}[group])();
}catch(e){fs.writeFileSync(join(out,"error.txt"),String(e.stack));if(b)try{await b.saveScreenshot(join(out,"error.png"));}catch{}throw e;}
finally{fs.writeFileSync(join(out,"actions.json"),JSON.stringify(log,null,2));if(b)await stop(b);}
