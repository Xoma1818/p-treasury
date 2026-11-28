import assert from "node:assert/strict";
import { mkdirSync,writeFileSync } from "node:fs";
import { join } from "node:path";
import { start, stop, resizeAppWindow, showAllHomeCards, openSection, click, clickControl, save as confirm, fill, waitText, setDate, onboard } from "../../e2e/app.mjs";

const kind=process.argv[2], dir=process.env.KAZNA_CONTROLS_OUT;
mkdirSync(dir,{recursive:true});
const actions=[], json=(name,val)=>writeFileSync(join(dir,name),JSON.stringify(val,null,2));
let b, step="запуск";
const files={Accounts:"src/screens/Accounts.tsx",Figures:"src/components/Figures.tsx",Goals:"src/components/Goals.tsx",Invest:"src/components/Invest.tsx"};
function proof(file,points,action,expected,actual) {
  for (const point of points.split(" ")) actions.push({id:files[file]+":"+point,action,expected,actual:JSON.stringify(actual),status:"pass",evidence:"https://github.com/"+process.env.GITHUB_REPOSITORY+"/actions/runs/"+process.env.GITHUB_RUN_ID+" (finance-"+kind+"/evidence.json)"});
  json("evidence.json",actions);
}
const act=async(sel)=>{step="нажатие "+sel;await clickControl(b,await b.$(sel),sel)};
const btn=async(label,dialog=false)=>{step=label;await click(b,label,dialog?'//*[@role="dialog"]':"")};
const value=async(name,v)=>{step=name+"="+v;await fill(b,name,v)};
const select=async(name,v)=>{step=name+"="+v;await b.$('[role="dialog"] [name="'+name+'"]').selectByAttribute("value",v)};
const nav=(title)=>openSection(b,title);
const wait=(sel,re)=>waitText(b,sel,re,8000);
const close=(button="Сохранить")=>confirm(b,button);
const read=async(cmd,args={})=>{
  const answer=await b.executeAsync((cmd,args,done)=>window.__TAURI_INTERNALS__.invoke(cmd,args).then(data=>done({data}),e=>done({error:String(e)})),cmd,args);
  if(answer.error)throw new Error(cmd+" "+answer.error);
  return answer.data;
};
const getAccounts=()=>read("list_accounts",{includeArchived:true});
const finances=async()=>({accounts:(await getAccounts()).map(x=>[x.id,x.balance]),transactions:(await read("list_transactions",{filter:{limit:100}})).total,month:(await read("invest_overview")).month.income});
const eventually=async(fn,pred)=>{let got;await b.waitUntil(async()=>{got=await fn();return pred(got)}, {timeout:7000,timeoutMsg:"Проверка после "+step});return got};
const shot=(name)=>b.saveScreenshot(join(dir,name+".png"));
const test={assert,proof,act,btn,value,select,nav,wait,close,read,getAccounts,finances,eventually,shot,setDate};
try{
  ({browser:b}=await start());
  await resizeAppWindow(b,1280,980);
  if(kind==="empty"){await onboard(b,[{name:"Дебет QA",balance:"1000"}])}
  else {await b.$("//h1[normalize-space()='Основная валюта']").waitForDisplayed({timeout:15000});await btn("Посмотреть на примере")}
  await b.$('//main//h1[normalize-space()="Главная"]').waitForDisplayed({timeout:12000});
  await showAllHomeCards(b);
  const {run}=await import("./"+kind+".mjs");
  await run(b,test);
  json("status.json",{status:"pass",version:"0.45.1",actions:actions.length,kind});
}catch(e){
  console.error(e);
  if(b){await shot("failure").catch(()=>{});await b.execute(()=>document.body.innerText).then(s=>json("screen.json",s)).catch(()=>{})}
  json("status.json",{status:"failed",kind,step,error:String(e),stack:e.stack,actions:actions.length});process.exitCode=1;
}finally{if(b)await stop(b)}

