import assert from "node:assert/strict";
import fs from "node:fs";
import {join} from "node:path";
import {execFileSync} from "node:child_process";
import {start,stop,openSection,openSettings,clickControl,click,fill,save,waitText} from "./app.mjs";
const [dir,out,group]=process.argv.slice(2), log=[];
let b;
const path={imports:"ImportHistory",rules:"Rules",crash:"Crash"}[group];
const dialog='//*[@role="dialog"]';
async function api(cmd,args={}){
 const r=await b.executeAsync((cmd,args,done)=>window.__TAURI_INTERNALS__.invoke(cmd,args).then(value=>done({value}),e=>done({error:String(e)})),cmd,args);
 assert.equal(r.error,undefined,cmd+" "+r.error);return r.value;
}
function check(id,action,expected,actual){
 assert.deepEqual(actual,expected,action);log.push({id:"src/components/"+path+".tsx:"+id,action,expected,actual,status:"pass"});
}
const data=()=>api("list_transactions",{filter:{limit:100}});
async function press(q){await clickControl(b,await b.$(q),q);}
async function closed(){await b.$('[role="dialog"]').waitForExist({reverse:true});}
async function imports(){
 const matches=()=>api("import_suggestions"),history=()=>api("import_history");
 const hist=async()=>{await openSettings(b,"data");await press('[data-testid="settings-import-history"]');await b.$('[data-testid="import-history"]').waitForDisplayed();};
 const original=await data();assert.equal(original.total,9);assert.equal((await matches()).length,2);
 await hist();await press('[data-testid="history-undo"]');await b.$('[data-testid="history-confirm"]').waitForDisplayed();
 check("83:24","Просмотреть отмену импорта",true,await b.$('[data-testid="history-confirm"]').isDisplayed());
 await click(b,"Не отменять",dialog);await b.$('[data-testid="history-confirm"]').waitForExist({reverse:true});
 check("104:12","Отказаться от отмены",9,(await data()).total);
 await click(b,"Закрыть",dialog);await closed();check("115:8","Закрыть историю",false,await b.$('[role="dialog"]').isExisting());
 await hist();await click(b,"Операции",'//*[@data-testid="history-row"][1]');await closed();await waitText(b,"main h1",/Операции/);
 await b.waitUntil(async()=>await b.execute(()=>document.querySelectorAll('[data-testid="txn-row"]').length)===1);
 check("79:26","Перейти из импорта к его операциям",1,await b.execute(()=>document.querySelectorAll('[data-testid="txn-row"]').length));
 await hist();await click(b,"Разобрать",dialog);await b.$('[data-testid="match"]').waitForDisplayed();
 check("40:10","Открыть неразобранные совпадения",2,(await b.$$('[data-testid="match"]')).length);
 await press('[data-testid="match-reject"]');await b.waitUntil(async()=>(await matches()).length===1);
 check("174:14","Пометить две записи разными",[9,1],[(await data()).total,(await matches()).length]);
 await press('[data-testid="match-accept"]');await b.$('[data-testid="matches-empty"]').waitForDisplayed();
 check("177:14","Объединить дубликат и сохранить исходную запись",[8,0,1],[(await data()).total,(await matches()).length,(await history()).reduce((s,x)=>s+x.linked,0)]);
 await click(b,"Закрыть",dialog);await b.$('[data-testid="matches-empty"]').waitForExist({reverse:true});
 check("187:8","Выйти из разобранных совпадений",false,await b.$('[data-testid="matches-empty"]').isExisting());
 if(await b.$('[role="dialog"]').isExisting())await b.keys("Escape");
 await hist();await press('//*[@data-testid="history-row"][.//button[normalize-space()="Операции"]]//*[@data-testid="history-undo"]');
 await press('[data-testid="history-undo-yes"]');await b.waitUntil(async()=>(await data()).total===7);
 check("107:12","Подтвердить отмену оставшейся загруженной операции",7,(await data()).total);
}
async function rules(){
 const card="019a0000-0000-7000-8000-000000000001",cat="019a0000-0000-7000-8000-000000000011";
 const input={type:"expense",date:"2026-11-22",accountId:card,categoryId:cat,amount:1525,payee:"Касса Дубрава",note:"исходно",status:"cleared",toAccountId:null,toAmount:null};
 const id=await api("create_transaction",{input,eventId:null});
 const tx=async()=>(await data()).items.find(x=>x.id===id);
 await openSection(b,"Категории");await fill(b,"rulePattern","Дубрава");await b.$('[name="ruleCategory"]').selectByAttribute("value",cat);await fill(b,"rulePayee","Лавка");
 await click(b,"Добавить правило");await b.$('[data-testid="rule-row"]').waitForDisplayed();
 for(const source of ["73:6","83:8"])check(source,"Создать правило замены получателя","Дубрава",(await api("list_rules")).find(x=>x.pattern==="Дубрава")?.pattern);
 await press('[data-testid="rule-history-open"]');await b.$('[data-testid="rule-history-select"]').waitForDisplayed();
 check("60:20","Открыть предпросмотр",1,(await b.$$('[data-testid="rule-history-select"]')).length);
 await press('[data-testid="rule-history-select"]');check("135:20","Выбрать строку для изменения",true,await b.$('[data-testid="rule-history-apply"]').isEnabled());
 await api("update_transaction",{id,input:{...input,note:"параллельная правка"}});
 await press('[data-testid="rule-history-apply"]');await b.$('button=Обновить предпросмотр').waitForDisplayed();
 check("166:8","Не перезаписать изменённую после предпросмотра строку",["Касса Дубрава","параллельная правка"],[(await tx()).payee,(await tx()).note]);
 await click(b,"Обновить предпросмотр",dialog);await b.waitUntil(async()=>!(await b.$('[data-testid="rule-history-select"]').isSelected()));
 check("163:45","Обновить устаревший предпросмотр",false,await b.$('[data-testid="rule-history-apply"]').isEnabled());
 await press('[data-testid="rule-history-select"]');await press('[data-testid="rule-history-apply"]');await b.waitUntil(async()=>(await tx()).payee==="Лавка");
 check("166:8","Применить правило, сохранить сумму и заметку",["Лавка",1525,"параллельная правка"],[(await tx()).payee,(await tx()).amount,(await tx()).note]);
 await click(b,"Закрыть",dialog);await closed();check("165:8","Закрыть предпросмотр",false,await b.$('[role="dialog"]').isExisting());
 await press('//*[@data-testid="category-item"][.//span[normalize-space()="Учебные покупки"]]//button[normalize-space()="Изменить"]');
 await press('button[aria-label="Убрать «Дубрава»"]');await b.waitUntil(async()=>(await api("list_rules")).every(x=>x.pattern!=="Дубрава"));
 check("190:12","Убрать ключевое слово правила из карточки категории",0,(await api("list_rules")).filter(x=>x.pattern==="Дубрава").length);
}
async function crash(){
 const before=await data(),message="Учебная ошибка проверки отображения";
 async function show(kind){
   const found=await b.execute((kind,message)=>{
     // Simulate a reported render failure in the mounted boundary of this disposable window.
     for(const el of document.querySelectorAll("main *")){
       for(let f=el[Object.keys(el).find(k=>k.startsWith("__reactFiber$"))];f;f=f.return){
         const s=f.stateNode;
         if(!s||typeof s.componentDidCatch!=="function"||typeof s.setState!=="function")continue;
         const scope=s.props.card?"card":s.props.inline?"section":"app";
         if(scope===kind){s.setState({error:new Error(message),stack:"Учебная трассировка 0451"});return true;}
       }
     }
     return false;
   },kind,message);
   assert.ok(found,"Найти границу отображения "+kind);await b.$(kind==="card"?'[data-testid="crash-card"]':'[data-testid="crash"]').waitForDisplayed();
 }
 await openSection(b,"Главная");await show("card");await click(b,"Открыть ещё раз");await b.$('[data-testid="crash-card"]').waitForExist({reverse:true});
 check("44:10","Повторно показать сбойную карточку",before.total,(await data()).total);
 await openSection(b,"Операции");await show("section");await press('//*[@data-testid="crash"]//summary');
 check("87:10","Показать сведения о сбое",true,await b.$(".crash-stack").isDisplayed());
 await click(b,"Скопировать текст ошибки");await b.$('button=Скопировано').waitForDisplayed();
 const cp=execFileSync("pwsh",["-NoProfile","-Command","[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Get-Clipboard -Raw"],{encoding:"utf8"});
 check("73:10","Скопировать именно текст ошибки",true,cp.includes(message)&&cp.includes("0451"));
 await click(b,"Открыть ещё раз");await waitText(b,"main h1",/Операции/);
 check("67:10","Повторно открыть раздел", "Операции",await b.$("main h1").getText());
 await show("app");await click(b,"Открыть ещё раз");await b.$("main h1").waitForDisplayed();await openSection(b,"Операции");await show("section");await click(b,"На Главную");await waitText(b,"main h1",/Главная/);
 check("70:10","После сбоя перейти на Главную","Главная",await b.$("main h1").getText());
 assert.deepEqual((await data()).items,before.items);
}
try{
 ({browser:b}=await start(dir,{homeDefaults:true,verboseDriver:false}));await b.$("main h1").waitForDisplayed();await ({imports,rules,crash}[group])();
}catch(e){fs.writeFileSync(join(out,"error.txt"),String(e.stack));if(b)try{await b.saveScreenshot(join(out,"error.png"));}catch{}throw e;}
finally{fs.writeFileSync(join(out,"actions.json"),JSON.stringify(log,null,2));if(b)await stop(b);}
