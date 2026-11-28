import assert from "node:assert/strict";
import fs from "node:fs";
import {join} from "node:path";
import {start,stop,openSettings,clickControl,click,fill,setDate} from "./app.mjs";
const [dir,out]=process.argv.slice(2), log=[], preferences={}, plain={}, reopened=[];
const settings="src/screens/Settings.tsx:", reminders="src/components/Reminders.tsx:";
let b;
const mark=(id,action,expected,actual)=>{assert.deepEqual(actual,expected,action);log.push({id,action,expected,actual,status:"pass"});};
async function api(cmd,args={}){
  const x=await b.executeAsync((cmd,args,done)=>window.__TAURI_INTERNALS__.invoke(cmd,args).then(value=>done({value}),e=>done({error:String(e)})),cmd,args);
  assert.equal(x.error,undefined,cmd+" "+x.error);return x.value;
}
async function select(name,value){
  const el=await b.$('select[name="'+name+'"]');await el.waitForDisplayed();await el.selectByAttribute("value",value);
  await b.waitUntil(async()=>await el.getValue()===value);
}
async function stored(key,value,ui=false){
  const read=async()=>{const dict=await api("get_settings");return ui?JSON.parse(dict.ui_prefs)[key]:dict[key];};
  await b.waitUntil(async()=>await read()===value,{timeout:6000,timeoutMsg:key+" = "+value});
  (ui?preferences:plain)[key]=value;return read();
}
async function field(id,name,key,value,ui=false){
  await select(name,value);
  mark(settings+id,name,value,await stored(key,value,ui));
}
async function look(id,name,key,value){
  await select(name,value);
  let serialized;
  await b.waitUntil(async()=>{serialized=JSON.parse((await api("get_settings")).ui_prefs)["kazna.look"];return JSON.parse(serialized)[key]===value;});
  preferences["kazna.look"]=serialized;
  mark(settings+id,name,value,await b.execute(k=>document.documentElement.dataset[k]??"normal",key));
}
async function clickAt(selector,label){await clickControl(b,await b.$(selector),label);}
async function boot(){({browser:b}=await start(dir,{homeDefaults:true,verboseDriver:false}));await b.$("main h1").waitForDisplayed();}
try{
  await boot();
  for(let i=1;i<=13;i++)await api("set_rate",{date:"2023-01-"+String(i).padStart(2,"0"),from:"USD",to:"RUB",rate:String(65+i)});
  await openSettings(b,"general");
  for(const x of ["USD","RUB"])await field("101:16","baseCurrency","base_currency",x);
  await field("112:16","monthStartDay","month_start_day","25");
  await field("123:16","dateFormat","date_format","YYYY-MM-DD");
  const auto='[name="ratesAuto"]';await clickAt(auto,"Автоматические курсы");mark(settings+"553:10","Включить курсы","1",await stored("rates_auto","1"));
  await clickAt(auto,"Автоматические курсы");mark(settings+"553:10","Выключить курсы","0",await stored("rates_auto","0"));
  await select("rateFrom","EUR");await setDate(b,"rateDate","2026-11-19");await fill(b,"rate","98,76");
  await click(b,"Добавить",'//*[@data-testid="rates-card"]');const desired={from:"EUR",to:"RUB",date:"2026-11-19"};
  await b.waitUntil(async()=>await api("rate_on",desired)==="98.76");
  for(const id of ["559:8","562:10","572:10"])mark(settings+id,"Ввести ручной курс EUR 98,76","98.76",await api("rate_on",desired));
  await clickAt('[data-testid="rates-history-toggle"]',"История курсов");
  await b.$('[data-testid="rates"]').waitForDisplayed();
  mark(settings+"581:10","Открыть историю",12,(await b.$$('[data-testid="rates"] tr')).length);
  await click(b,"Показать все (15)");mark(settings+"609:16","Показать все курсы",15,(await b.$$('[data-testid="rates"] tr')).length);
  await click(b,"Свернуть");mark(settings+"609:16","Свернуть историю",12,(await b.$$('[data-testid="rates"] tr')).length);
  await clickAt('//*[@data-testid="rates"]//tr[.//td[contains(.,"EUR")]]//button',"Удалить ручной курс");
  await b.waitUntil(async()=>await api("rate_on",desired)===null);mark(settings+"599:26","Удалить ручной курс",null,await api("rate_on",desired));
  await openSettings(b,"notifications");
  await field("143:16","debtReminderDays","debt_reminder_days_before","10");
  await field("169:16","fundsDays","reminder_funds_days","7");
  await field("208:16","subsRemind","subs_remind","0");
  const budgetSwitch='[data-testid="budget-alerts"]';const next=(await b.$(budgetSwitch).getAttribute("aria-checked"))==="true"?"0":"1";
  await clickAt(budgetSwitch,"Предупреждать о бюджете");mark(settings+"192:16","Предупреждения",next,await stored("budget_alerts",next));
  const lead=await b.$('[data-testid="defaultLeadDays"]');await click(b,"за 2 недели",'//*[@data-testid="defaultLeadDays"]');
  await b.waitUntil(async()=> (await api("get_settings")).reminder_lead_days.split(",").includes("14"));
  mark(reminders+"47:8","За 2 недели","true",await lead.$("button=за 2 недели").getAttribute("aria-pressed"));
  await fill(b,"defaultLeadDaysOwn","11");await b.keys("Enter");await lead.$("button*=за 11").waitForDisplayed();
  await clickControl(b,await lead.$("button*=за 11"),"Убрать свой срок");await b.waitUntil(async()=>!(await api("get_settings")).reminder_lead_days.split(",").includes("11"));
  mark(reminders+"52:8","Убрать свой срок из уведомлений",false,(await api("get_settings")).reminder_lead_days.split(",").includes("11"));
  await openSettings(b,"appearance");
  for(const x of ["light","dark"])await field("224:16","uiTheme","p-treasury-theme",x,true);
  for(const x of ["plum","cobalt","petrol"])await look("233:16","uiPalette","palette",x);
  for(const x of ["100","90","125","100"])await field("242:16","uiScale","p-treasury-scale",x,true);
  for(const x of ["roomy","normal","compact"])await look("262:16","uiDensity","density",x);
  for(const value of ["lime","mint","blue","violet","amber","rose","graphite","palette"]){
    const sel='[data-testid="accent-pick"] [data-accent="'+value+'"]';await clickAt(sel,"Цвет "+value);
    await b.waitUntil(async()=>JSON.parse(JSON.parse((await api("get_settings")).ui_prefs)["kazna.look"]).accent===value);
    mark(settings+(value==="palette"?"274:16":"284:18"),"Цвет "+value,value,await b.execute(()=>document.documentElement.dataset.accent));
  }
  preferences["kazna.look"]=JSON.parse((await api("get_settings")).ui_prefs)["kazna.look"];
  await field("301:16","hints","hints","0");await openSettings(b,"controls");
  await field("321:16","txnOpen","kazna.txnOpen","panel",true);
  for(const x of ["1","0"])await field("338:16","closeToTray","close_to_tray",x);
  for(const x of ["Ctrl+Alt+N",""])await field("346:16","quickHotkey","quick_hotkey",x);
  await stop(b);b=undefined;await boot();
  const saved=await api("get_settings"),local=JSON.parse(saved.ui_prefs);
  for(const [key,v] of Object.entries(plain)){assert.equal(saved[key],v);reopened.push(key);}
  for(const [key,v] of Object.entries(preferences)){assert.equal(local[key],v);reopened.push(key);}
  assert.equal(await b.execute(()=>document.documentElement.dataset.accent),"palette");
}catch(e){if(b){try{await b.saveScreenshot(join(out,"error.png"));}catch{}}fs.writeFileSync(join(out,"error.txt"),String(e.stack));throw e;}
finally{fs.writeFileSync(join(out,"preferences.json"),JSON.stringify({log,reopened,plain,preferences},null,2));if(b)await stop(b);}
