import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync,mkdtempSync,readFileSync,writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { start, stop, onboard, click, clickControl, fill, choose, openSection, waitText } from "./app.mjs";

export {assert,clickControl,fill,choose,waitText};
export let b, data, path, acct;
export const dlg='//*[@role="dialog"]';
const ev=process.env.KAZNA_CONTROLS_OUT;
const records=[];
const failures=[];
const today=new Date();
export const yyyy=today.getFullYear();
export function ym(delta=0){
  const d=new Date(yyyy,today.getMonth()+delta,1);
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0");
}
export const day=(m,n=1)=>m+"-"+String(n).padStart(2,"0");
export const alt=(s)=>new RegExp(s.replace(/\s/g,'[\\s\\u00a0]*'));
export function read(sql,...args) {
  const db=new DatabaseSync(path,{readOnly:true});
  try {return db.prepare(sql).all(...args).map(x=>({...x}));} finally{db.close();}
}
export function fixtureSql(fn){
  const db=new DatabaseSync(path);
  try {db.exec("PRAGMA foreign_keys=ON"); fn(db);}finally{db.close();}
}
export const one=(sql,...args)=>Object.values(read(sql,...args)[0]??{})[0];
export const cat=n=>one("SELECT id FROM categories WHERE name=? AND parent_id IS NULL",n);
export async function cmd(name,args={}){
  const result=await b.executeAsync((n,a,d)=>window.__TAURI_INTERNALS__.invoke(n,a).then(v=>d({v}),e=>d({e:String(e)})),name,args);
  assert.equal(result.e,undefined,name+" "+result.e); return result.v;
}
export async function op(kind,date,category,amount,payee){
  const categoryId=cat(category);assert.ok(categoryId,category);
  return cmd("create_transaction",{input:{type:kind,accountId:acct,categoryId,amount,date,payee,toAccountId:null,toAmount:null,note:null},eventId:null});
}
export async function budget(m,limits={}){
  const budgetId=(await cmd("create_budget",{month:m,copyPrevious:false}));
  for(const [name,limit] of Object.entries(limits)) await cmd("set_budget_limit",{budgetId,categoryId:cat(name),limit});
  return budgetId;
}
export const savedLimit=(m,name)=>one("SELECT l.limit_amount FROM budget_lines l JOIN budgets b ON b.id=l.budget_id JOIN categories c ON c.id=l.category_id WHERE b.period_start=? AND c.name=?",day(m),name);
export const el=async s=>await b.$(s);
export const has=async s=>{await (await el(s)).waitForDisplayed({timeout:11000});};
export const gone=async s=>{await (await el(s)).waitForExist({reverse:true,timeout:7000});};
export const text=async s=>await (await el(s)).getText();
export const hit=async s=>{await clickControl(b,await el(s),s);};
export const push=async (label,scope="")=>await click(b,label,scope);
export const tab=async screen=>await openSection(b,screen);
export const refresh=async()=>{await b.refresh(); await has('nav');};
export const seen=async (selector,regex)=>await waitText(b,selector,regex,10000);
export const money=(n)=>new RegExp(String(n).split("").map(x=>x.replace(/[.*+?^$|(){}\[\]\\]/g,"\\$&")).join("[\\s\\u00a0]*"));
export async function journal(names) {
  await has("//main//h1[normalize-space()='Операции']");
  const visibleRows=()=>b.execute(()=>[...document.querySelectorAll('[data-testid="txn-row"]')].filter(r=>r.offsetHeight>0).map(r=>r.innerText));
  await b.waitUntil(async()=>{
    const texts=await visibleRows();
    if (texts.length!==names.length) return false;
    for (const name of names) {
      const ix=texts.findIndex(t=>t.includes(name));
      if (ix<0) return false;
      texts.splice(ix,1);
    }
    return true;
  },{timeout:10000,timeoutMsg:"Expected exact journal "+names.join("/")});
  return (await visibleRows()).map(s=>s.replace(/\s+/g," ")).join(" | ");
}
export function mark(file,ids,action,expected,actual) {
  for(const at of ids.split(" "))records.push({id:"src/"+file+".tsx:"+at,action,expected,actual:String(actual),status:"pass",
    evidence:"https://github.com/"+process.env.GITHUB_REPOSITORY+"/actions/runs/"+process.env.GITHUB_RUN_ID});
  writeFileSync(join(ev,"actions.json"),JSON.stringify(records,null,2));
  console.log("PASS",file,ids,action,String(actual).slice(0,250));
}
export async function phase(name,fn) {
  try { await fn(); await b.saveScreenshot(join(ev,name+"-ok.png")); } catch(error) {
    failures.push(name); console.log("FAILED",name,error.stack);
    try {await b.saveScreenshot(join(ev,name+"-failure.png"));}catch{}
    try {writeFileSync(join(ev,name+"-failure.txt"),String(error.stack)+"\n"+await text("body"));}catch{}
    await refresh();
  }
}
export async function boot(){
  assert.equal(process.env.RUNNER_ENVIRONMENT,"github-hosted"); assert.equal(process.platform,"win32");
  mkdirSync(ev,{recursive:true});data=mkdtempSync(join(process.env.RUNNER_TEMP,"finance-"));
  ({browser:b}=await start(data,{bin:process.env.PTREASURY_BIN,env:{
    WEBVIEW2_USER_DATA_FOLDER:join(data,"webview"),PTREASURY_VAULT_DIR:join(data,"Kazna")}}));
  const info=await cmd("app_info"); assert.equal(info.version,"0.45.1"); path=info.dbPath;
  await onboard(b,[{name:"Карта QA",type:"Карта",balance:"10000"}]);
  acct=one("SELECT id FROM accounts WHERE name='Карта QA'");
  writeFileSync(join(ev,"build.json"),JSON.stringify({version:info.version,month:ym(),releaseSHA256:createHash("sha256").update(readFileSync(process.env.PTREASURY_BIN)).digest("hex")},null,2));
}
export async function done(){
  try {
    if(path){
      assert.deepEqual(read("PRAGMA integrity_check"),[{integrity_check:"ok"}]); assert.deepEqual(read("PRAGMA foreign_key_check"),[]);
      writeFileSync(join(ev,"ledger.json"),JSON.stringify(read("SELECT id,type,date,amount,payee FROM transactions ORDER BY date,id"),null,2));
    }
  } finally {if(b)await stop(b);}
  if(failures.length)throw Error("Failed scenarios: "+failures.join(", "));
}
