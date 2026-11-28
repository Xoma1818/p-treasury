import assert from "node:assert/strict";
import fs from "node:fs";
import {join} from "node:path";
import {start,stop,openSection,clickControl,click,fill,setDate,save,waitText} from "./app.mjs";
const [dir,out]=process.argv.slice(2), log=[],failures=[], names={};
let b,id;
async function api(cmd,args={}){
  const r=await b.executeAsync((cmd,args,done)=>window.__TAURI_INTERNALS__.invoke(cmd,args).then(value=>done({value}),e=>done({error:String(e)})),cmd,args);
  assert.equal(r.error,undefined,cmd+" "+r.error);return r.value;
}
const detail=()=>api("get_debt",{id});
const dialog='//*[@role="dialog"]';
async function press(q){await clickControl(b,await b.$(q),q);}
async function select(name,v){await b.$('select[name="'+name+'"]').selectByAttribute("value",v);}
function check(ids,action,expected,actual){
  assert.deepEqual(actual,expected,action);
  for(const source of ids.split(","))log.push({id:"src/screens/debts/LoanTools.tsx:"+source,action,expected,actual,status:"pass"});
}
async function cancel(){await click(b,"Отмена",dialog);await b.$('[role="dialog"]').waitForExist({reverse:true});}
async function group(key,work){
  try{
    await openSection(b,"Главная");await openSection(b,"Займы и долги");
    const d=names[key];id=d.id;await press('[data-testid="debt-row"][data-name="'+d.title+'"]');
    await b.waitUntil(async()=>(await b.$("main h1").getText()).includes(d.title));
    await work();
  }catch(e){failures.push({key,error:String(e.stack)});console.log(key,String(e.stack));try{await b.saveScreenshot(join(out,key+".png"));await b.keys("Escape");}catch{}}
}
try{
  ({browser:b}=await start(dir,{homeDefaults:true,verboseDriver:false}));await b.$("main h1").waitForDisplayed();
  const today=(await api("app_info")).today;
  const day=delta=>{const d=new Date(today+"T12:00:00Z");d.setUTCDate(d.getUTCDate()+delta);return d.toISOString().slice(0,10);};
  for(const [n,k] of ["terms","rate","holiday","row","preview"].entries()){
    const title="Учебный кредит "+(n+1);
    names[k]={title,id:await api("create_debt",{input:{direction:"borrowed",counterparty:title,currencyCode:"RUB",principal:30000000,
      rateBp:1200,repaymentType:"annuity",termMonths:24,issueDate:day(-2),firstPaymentDate:day(28),maturityDate:null,accountId:null,note:null,interestMethod:"daily",ratePeriod:"year",payEvery:"month"}})};
  }
  await group("terms",async()=>{
    const before=await detail();await click(b,"Изменить условия");await fill(b,"termsPrincipal","312500");await cancel();
    check("230:10","Отменить изменённую сумму",before.card.principal,(await detail()).card.principal);
    await click(b,"Изменить условия");await select("termsRepayment","differentiated");await select("termsTermUnit","years");await fill(b,"termsTerm","2");
    await click(b,"по месяцам",dialog);await b.$('[data-testid="terms-preview"]').waitForDisplayed();
    await fill(b,"termsPrincipal","312500");await save(b);const after=await detail();
    check("154:6,173:14,190:20,214:14,233:10","Сохранить новые условия и график",[31250000,24,"monthly","differentiated",24],[after.card.principal,after.card.termMonths,after.card.interestMethod,after.card.repaymentType,after.schedule.length]);
  });
  await group("rate",async()=>{
    await click(b,"Ставка изменилась");await fill(b,"newRate","7");await cancel();
    check("272:10","Отменить новую ставку",0,(await detail()).rateChanges.length);
    await click(b,"Ставка изменилась");await setDate(b,"rateFrom",day(2));await fill(b,"newRate","11");await save(b);
    const r=(await detail()).rateChanges[0];check("256:6,275:10","Сохранить 11 % со своей даты",[1100,day(2)],[r.rateBp,r.from]);
    await press('button[aria-label="Удалить смену ставки"],button[aria-label="Удалить изменение ставки"]');
    await b.waitUntil(async()=>(await detail()).rateChanges.length===0);
    check("372:12","Удалить изменение ставки",0,(await detail()).rateChanges.length);
  });
  await group("holiday",async()=>{
    await click(b,"Каникулы");await select("holidayKind","shift");await cancel();
    check("343:10","Отменить каникулы",0,(await detail()).holidays.length);
    await click(b,"Каникулы");await select("holidayKind","shift");await select("holidayFrom","2");await select("holidayMonths","2");await save(b);
    const h=(await detail()).holidays[0];check("298:6,302:12,314:14,325:14,346:10","Два месяца переноса со второго платежа",["shift",2,2],[h.kind,h.fromSeq,h.months]);
    await press('button[aria-label="Удалить каникулы"]');await b.waitUntil(async()=>(await detail()).holidays.length===0);
    check("382:12","Удалить каникулы",0,(await detail()).holidays.length);
  });
  await group("row",async()=>{
    await press('[data-testid="row-amount"]');await fill(b,"rowAmount","50000");await cancel();
    check("679:10","Отменить ручную сумму строки",0,(await detail()).rowAmounts.length);
    await press('[data-testid="row-amount"]');await fill(b,"rowAmount","50000");await click(b,"уменьшать платёж",dialog);await save(b);
    const r=(await detail()).rowAmounts[0];check("652:6,662:14,682:10","Сохранить 50 000 ₽ в первой строке",[1,5000000,"reduce_payment"],[r.seq,r.amount,r.mode]);
    await press('[data-testid="row-amount"]');await click(b,"Вернуть сумму по графику",dialog);await b.$('[role="dialog"]').waitForExist({reverse:true});
    check("674:12","Вернуть сумму по графику",0,(await detail()).rowAmounts.length);
  });
  await group("preview",async()=>{
    await press('[data-testid="tab-planned"]');await click(b,"+ Досрочное погашение");await fill(b,"early-amount-0","10000");await click(b,"Сохранить досрочки");
    await b.waitUntil(async()=>(await detail()).plannedEarly.length===1);
    check("424:10","Сохранить досрочный платёж в плане",1000000,(await detail()).plannedEarly[0].amount);
    const before=await detail();await press('[data-testid="tab-whatif"]');await fill(b,"whatIfAmount","25000");
    for(const m of ["reduce_payment","reduce_term"]){
      await select("whatIfMode",m);await waitText(b,'[data-testid="whatif-result"]',/Экономия/);
      const after=await detail();assert.deepEqual(after,before);
      check("505:14","Посчитать сценарий "+m+" без записи в заём",before.card.outstanding,after.card.outstanding);
    }
  });
  assert.deepEqual(failures,[]);
}finally{fs.writeFileSync(join(out,"loan-controls.json"),JSON.stringify({log,failures},null,2));if(b)await stop(b);}
