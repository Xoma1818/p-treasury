export async function run(b,{assert,proof,act,btn,value,select,wait,close,read,eventually,finances,shot}) {
 const mark=(p,a,e,v)=>proof("Goals",p,a,e,v);
 const name="Цель QA 0451", second="Цель QA вторая";
 const all=()=>read("list_goals");
 const mine=async()=>(await all()).find(g=>g.name===name);
 const order=async()=>(await all()).map(g=>g.name);
 const selector='[data-testid="goal"][data-name="'+name+'"]';
 const edit=()=>act(selector+' .goal-title button.link');
 const dep=()=>act(selector+' [data-testid="goal-deposit"]');
 const ledger=await finances();
 for(const n of [name,second]){
   await btn("+ Цель");await value("goalName",n);await select("goalCurrency","USD");await value("goalTarget","400");await close();
   await wait('[data-testid="goal"][data-name="'+n+'"]',/0 %/);
 }
 const g=await mine();assert.equal(g.currencyCode,"USD");assert.equal(g.target,40000);assert.equal(g.saved,0);assert.equal(g.accountId,null);
 mark("181:6 190:16","Создать ручную цель в USD","Цель 400,00 USD, прогресс 0",g);
 const orig=await order();const i=orig.indexOf(name);assert.ok(i>=0 && i<orig.length-1);
 const changed=[...orig];[changed[i],changed[i+1]]=[changed[i+1],changed[i]];
 await act('button[aria-label="Менее важна: '+name+'"]');await eventually(order,o=>JSON.stringify(o)===JSON.stringify(changed));
 mark("74:20","Понизить важность","Ровно две соседние цели поменялись местами",{before:orig,after:changed});
 await edit();await value("goalTarget","999");await close("Отмена");assert.equal((await mine()).target,40000);
 mark("66:16 251:10","Открыть цель, ввести 999 и отменить","Прежняя цель 400,00 USD", (await mine()).target);
 await dep();await wait('[role="dialog"]',/Сумма/);await value("amount","11");await close("Отмена");assert.equal((await mine()).saved,0);
 mark("120:16 296:10","Открыть ручное пополнение, отменить сумму 11","Накоплено 0,00 USD", (await mine()).saved);
 await dep();await btn("Взять из цели",true);await btn("Отложить",true);await value("amount","80");await close();
 const saved=await mine();assert.equal(saved.saved,8000);assert.equal(saved.remaining,32000);assert.equal(saved.percent,20);
 mark("275:6 277:10 299:10","Переключить с изъятия на пополнение, сохранить 80","Накоплено 80,00 USD, осталось 320,00 USD, прогресс 20%", {saved:saved.saved,remaining:saved.remaining,percent:saved.percent});
 await dep();await btn("Взять из цели",true);await value("amount","20");await close();
 assert.equal((await mine()).saved,6000);await shot("goal-60-usd");
 await edit();await close("Удалить");assert.equal(await mine(),undefined);assert.deepEqual(await finances(),ledger);
 mark("246:12","Изъять 20 USD, удалить ручную цель","Цель исчезла, сверены неизменные остатки счетов, доход и число операций",{goalPresent:false,ledger});
}
