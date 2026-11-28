import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { start, stop, waitText } from "./app.mjs";

const [dir, output] = process.argv.slice(2);
const expected = JSON.parse(readFileSync(join(output,"expected.json"), "utf8"));
const report = { cycles: 0, concurrentCommits: 0, verifiedObservations: 0, cycleMs: [] };
let browser;
async function launch(){
  ({browser} = await start(dir,{homeDefaults:true,verboseDriver:false}));
  const info = await call("app_info");
  assert.equal(info.version, "0.45.1");
  assert.equal(relative(join(dir,"budget.db"),info.dbPath),"");
  await waitText(browser,"main h1",/Главная/);
  return info.today;
}
async function call(cmd,args = {}){
  const response = await browser.executeAsync((cmd,args,done) => {
    window.__TAURI_INTERNALS__.invoke(cmd,args).then(value=>done({value}),error=>done({error:String(error)}));
  },cmd,args);
  assert.equal(response.error, undefined, cmd+": "+response.error);
  return response.value;
}
async function observe(n, added, today){
  const outcome = await browser.executeAsync((today,done)=>{
    const invoke=window.__TAURI_INTERNALS__.invoke;
    Promise.all([invoke("list_accounts",{includeArchived:false}),invoke("list_transactions",{filter:{limit:1}}),
                 invoke("explain_balance",{on:today})]).then(([accounts,journal,explain])=>
      done({balances:Object.fromEntries(accounts.map(a=>[a.id,a.balance])),n:journal.total,total:explain.total}),
      error=>done({error:String(error)}));
  },today);
  assert.equal(outcome.error,undefined);
  assert.equal(outcome.n,expected.count+n);
  assert.deepEqual(outcome.balances,{...expected.balances,[expected.card]:expected.balances[expected.card]-added});
  assert.equal(outcome.total,expected.totalRubMinor-added);
  report.verifiedObservations++;
}
function row(i,date){return {type:"expense",accountId:expected.card,categoryId:expected.category,amount:101+i,
  date,status:"cleared",payee:"Учебный импульс "+i,note:null,toAccountId:null,toAmount:null};}
try{
  const today=await launch();
  await observe(0,0,today);
  for(let i=0;i<120;i++){
    const t=performance.now();
    const input=row(i,today);
    await call("create_transaction",{input,eventId:null});
    await observe(1,input.amount,today);
    await call("undo");await observe(0,0,today);
    await call("redo");await observe(1,input.amount,today);
    await call("undo");await observe(0,0,today);
    report.cycleMs.push(Math.round(performance.now()-t));
    report.cycles++;
    if(report.cycles % 20 === 0) console.log("Verified cycles",report.cycles);
  }
  const inputs=Array.from({length:24},(_,i)=>row(300+i,today));
  const burst=await browser.executeAsync((inputs,done)=>{
    Promise.allSettled(inputs.map(input=>window.__TAURI_INTERNALS__.invoke("create_transaction",{input,eventId:null})))
      .then(out=>done(out.map(x=>x.status==="fulfilled"?{id:x.value}:{error:String(x.reason)})));
  },inputs);
  assert.ok(burst.every(x=>typeof x.id==="string"&&!x.error),JSON.stringify(burst));
  assert.equal(new Set(burst.map(x=>x.id)).size,inputs.length);
  report.concurrentCommits=burst.length;
  await observe(inputs.length,inputs.reduce((s,x)=>s+x.amount,0),today);
  for(let i=0;i<inputs.length;i++) await call("undo");
  await observe(0,0,today);
  await stop(browser);browser=undefined;
  await observe(0,0,await launch());
  const sorted=[...report.cycleMs].sort((a,b)=>a-b);
  report.medianMs=sorted[Math.ceil(sorted.length*.5)-1];
  report.p95Ms=sorted[Math.ceil(sorted.length*.95)-1];
  report.maxMs=sorted.at(-1);
  report.success=true;
} catch(error){report.error=error.stack;throw error;}
finally{
  writeFileSync(join(output,"runtime.json"),JSON.stringify(report,null,2));
  if(browser) await stop(browser);
}
