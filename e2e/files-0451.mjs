import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import fs from "node:fs";
import {join,relative} from "node:path";
import {start,stop,appPid,click,clickControl,openSettings,openSection,waitText,fill,choose,setDate,money} from "./app.mjs";
const [dir,out]=process.argv.slice(2);
const data={actions:[],picker:[],success:false};const dialog='//*[@role="dialog"]';
let b,owner;
const mark=(label,effect)=>{data.actions.push({label,effect});console.log(label,effect);};
async function native(label,file,mode="accept"){
 const path=join(out,file);
 const child=spawn("powershell",["-NoProfile","-NonInteractive","-File","qa/file-picker.ps1","-OwnerPid",owner,"-Path",path,"-Mode",mode],{windowsHide:true,stdio:["ignore","pipe","pipe"]});
 let log="";child.stdout.on("data",x=>log+=x);child.stderr.on("data",x=>log+=x);
 const completed=new Promise(resolve=>child.on("close",code=>resolve({code,log})));
 await click(b,label,dialog);
 const r=await completed;console.log("Native",label,r.log);assert.equal(r.code,0,r.log);
 data.picker.push({label,file,mode,log:r.log.trim()});
}
async function countExpected(total){
 const n=await b.executeAsync(done=>window.__TAURI_INTERNALS__.invoke("list_transactions",{filter:{limit:1}}).then(p=>done(p.total),e=>done(String(e))));
 assert.equal(n,total);
}
try{
 ({browser:b}=await start(dir,{homeDefaults:true,verboseDriver:false}));
 owner=String(appPid(dir));assert.match(owner,/^\d+$/);
 const info=await b.executeAsync(done=>window.__TAURI_INTERNALS__.invoke("app_info").then(done));
 assert.equal(info.version,"0.45.1");assert.equal(relative(join(dir,"budget.db"),info.dbPath),"");
 await countExpected(7);
 await openSettings(b,"data");await click(b,"Сводка в Excel");
 for(const tab of ["Квартал","Год","Месяц","Свой период"]){
   const item=await b.$(dialog+'//button[normalize-space()="'+tab+'"]');
   await clickControl(b,item,tab);assert.equal(await item.getAttribute("aria-selected"),"true");mark(tab,"период выбран");
 }
 await setDate(b,"summaryFrom","2026-11-10");await setDate(b,"summaryTo","2026-12-09");
 await native("Скачать в CSV","cancelled.csv","cancel");assert.ok(!fs.existsSync(join(out,"cancelled.csv")));assert.ok(await b.$(dialog).isDisplayed());mark("Отмена системного выбора","файл отсутствует, сводка открыта");
 for(const [label,file] of [["Скачать в CSV","summary.csv"],["Скачать в Excel","summary.xlsx"]]){
   await native(label,file);await waitText(b,'[data-testid="export-done"]',new RegExp(file));assert.ok(fs.statSync(join(out,file)).size>200);mark(label,file);
 }
 await click(b,"Закрыть",dialog);assert.equal(await b.$(dialog).isExisting(),false);mark("Закрыть сводку","диалог закрыт");
 await click(b,"Импорт выписки или CSV");await native("Скачать шаблон CSV","template.csv");await b.waitUntil(()=>fs.existsSync(join(out,"template.csv")));
 const header=fs.readFileSync(join(out,"template.csv"),"utf8").split(/\r?\n/)[0];
 assert.ok(header.includes("Валюта")&&header.includes("Дата"));mark("Скачать шаблон CSV","записан заголовок шаблона");
 const values=["2026-11-18","Расход","Учебная карта Рубин","Учебные покупки","Учебный приёмочный чек","Реальный выбор файла","-12,34","RUB","","","",""];
 fs.writeFileSync(join(out,"input.csv"),header+"\r\n"+values.join(";")+"\r\n","utf8");
 await native("Выбрать файл","input.csv");await waitText(b,'[data-testid="import-summary"]',/строк 1, без ошибок 1/);mark("Выбрать файл","предпросмотр одной строки");
 await click(b,"Загрузить 1",dialog);await waitText(b,'[data-testid="import-done"]',/Загружено операций: 1/);
 await countExpected(8);mark("Загрузить 1","в журнале 8 вместо 7");
 await click(b,"Проверить снова",dialog);await waitText(b,'[data-testid="import-summary"]',/уже загружено раньше 1/);await countExpected(8);mark("Проверить снова","один повтор, 8 записей");
 await b.keys("Escape");await openSection(b,"Займы и долги");await click(b,"Калькулятор");
 await fill(b,"principal","300000");await fill(b,"rate","12");await choose(b,"termUnit","месяцев");await fill(b,"term","24");
 await setDate(b,"issueDate","2026-10-15");await setDate(b,"firstPayment","2026-11-15");
 await waitText(b,'[data-testid="loan-payment"]',money("14 122,04 ₽"));await click(b,"PDF для подписи");
 await fill(b,"lenderName","Учебный Кредитор");await fill(b,"borrowerName","Учебный Заёмщик");
 await native("Сохранить файл","loan.pdf");await waitText(b,'[data-testid="export-status"]',/loan\.pdf/);
 const pdf=fs.readFileSync(join(out,"loan.pdf"));assert.equal(pdf.subarray(0,4).toString(),"%PDF");assert.ok(pdf.length>1000);mark("Сохранить файл","подписной график PDF записан");
 data.success=true;
}catch(e){data.error=String(e.stack);if(b){try{data.screen=(await b.$("body").getText()).slice(-2500);await b.saveScreenshot(join(out,"error.png"));}catch{}}throw e;}
finally{fs.writeFileSync(join(out,"actions.json"),JSON.stringify(data,null,2));if(b)await stop(b);}
