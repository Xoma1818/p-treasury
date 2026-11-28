export async function run(b,{assert,proof,btn,act,value,nav,wait,close,read,getAccounts,eventually,shot}) {
 const mark=(p,a,e,v)=>proof("ReconcileAccount",p,a,e,v);
 const today=new Date().toISOString().slice(0,10), acc=(await getAccounts()).find(x=>x.type==="debit"&&x.currencyCode==="RUB"), cat=(await read("list_categories",{includeArchived:false})).find(x=>x.kind==="expense");
 const txn=()=>read("list_transactions",{filter:{accountId:acc.id,limit:1,dateTo:today}});
 const add=()=>read("create_transaction",{input:{type:"expense",amount:100,date:today,payee:"Учебная строка сверки",categoryId:cat.id,accountId:acc.id}});
 for(let i=(await txn()).total;i<22;i++)await add();
 const preview=()=>read("reconciliation_preview",{id:acc.id,date:today}), records=()=>read("list_reconciliations");
 const start=await preview(),initial=await records(), count=(await txn()).total;
 const amount=n=>(n/100).toFixed(2).replace(".",",");
 await nav("Счета");
 const open=()=>act('//*[@data-testid="account-row" and @data-name="'+acc.name+'"]//button[normalize-space()="Сверить"]');
 await open();await wait('[data-testid="reconcile-book-balance"]',/В Kazna/);await value("actualBalance",amount(start.balance+100));await close("Отмена");
 assert.deepEqual(await records(),initial);assert.equal((await txn()).total,count);
 mark("129:10","Отменить расхождение 1 ₽","Ни корректировки, ни отметки сверки, баланс тот же",{balance:(await preview()).balance,count});
 await open();await btn("Посмотреть операции",true);await wait('[data-testid="reconcile-operations"]',/Открыть весь список/);
 const rows=await b.$$('[data-testid="reconcile-operations"] tbody tr');assert.equal(rows.length,20);
 await act('//*[@data-testid="reconcile-operations"]//button[contains(.,"Открыть весь список")]');await wait("main h1",/Операции/);await wait('[data-testid="chip-account"]',new RegExp(acc.name));assert.equal((await txn()).total,count);
 mark("120:14","Открыть полный журнал из списка сверки","20 строк предпросмотра, больше 20 в журнале выбранного счёта", {rows:rows.length,total:count,account:acc.name});
 await nav("Счета");await open();await wait('[data-testid="reconcile-book-balance"]',/В Kazna/);await value("actualBalance",amount(start.balance));await wait('[data-testid="reconcile-difference"]',/совпадают/);
 await add();await btn("Завершить сверку",true);await wait('[role="dialog"]',/изменились после проверки/);assert.deepEqual(await records(),initial);
 await btn("Обновить расчёт",true);await wait('[data-testid="reconcile-difference"]',/Расхождение/);
 const next=await preview();assert.equal(next.balance,start.balance-100);await value("actualBalance",amount(next.balance));await close("Завершить сверку");
 const rec=(await records()).find(x=>x.accountId===acc.id);assert.equal(rec.date,today);assert.equal(rec.balance,next.balance);assert.equal(rec.stale,false);assert.equal((await txn()).total,count+1);
 mark("51:6 91:10","Провести учебный расход 1 ₽ во время сверки, отклонить устаревшую сумму, обновить расчёт и завершить","После конфликта ничего не сохранено, записан свежий остаток, лишней операции нет",{initialBalance:start.balance,reconciled:rec,total:(await txn()).total});
 await shot("reconciled");
}
