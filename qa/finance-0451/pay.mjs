export async function run(b,{assert,proof,btn,act,value,nav,wait,close,read,getAccounts,eventually,finances,shot,setDate}){
 const offset=i=>new Date(Date.now()+i*86400000).toISOString().slice(0,10),name="Банк QA 0451", account=(await getAccounts()).find(x=>x.type==="debit"&&x.currencyCode==="RUB");
 const id=await read("create_debt",{input:{counterparty:name,direction:"borrowed",currencyCode:"RUB",principal:1200000,rateBp:0,repaymentType:"annuity",termMonths:3,issueDate:offset(-2),firstPaymentDate:offset(3),accountId:account.id}});
 const get=()=>read("get_debt",{id}), bal=async()=>(await getAccounts()).find(a=>a.id===account.id).balance;
 const initial=await get(),beforeBalance=await bal(),ledger=await finances();
 const mark=(p,a,e,v)=>proof("PayForm",p,a,e,v);
 await nav("Займы и долги");await act('//*[@data-testid="upcoming"]//li[contains(.,"'+name+'")]');await wait("main h1",new RegExp(name));
 proof("Debts","107:14","Открыть помеченный предстоящий платёж","Открылась карточка нужного долга", (await get()).card.counterparty);
 await btn("Оплачено");await act('[name="asEarly"]');await value("earlyAmount","1000");await setDate(b,"payDate",offset(-10));await wait('[role="dialog"]',/раньше даты выдачи/);
 await btn("Повторить расчёт",true);await wait('[role="dialog"]',/раньше даты выдачи/);assert.equal(await b.$('[role="dialog"] button[type="submit"]').isEnabled(),false);
 await setDate(b,"payDate",offset(0));await wait('[data-testid="pay-quote"]',/1|0/);assert.equal((await get()).payments.length,0);
 mark("163:23","Повторить расчёт с датой до выдачи, затем исправить дату","Невалидная дата снова отклонена, исправленная дата даёт предварительный расчёт, записей нет",await b.$('[data-testid="pay-quote"]').getText());
 await close("Отмена");assert.deepEqual(await finances(),ledger);assert.deepEqual(await get(),initial);
 mark("170:10","Отменить досрочку 1000 RUB","Без платежа или проводки", {count:ledger.transactions,balance:beforeBalance});
 await btn("Оплачено");await act('[name="asEarly"]');await value("earlyAmount","1000");await wait('[data-testid="pay-quote"]',/1|0/);await close();
 const after=await get();assert.equal(after.payments.length,1);assert.equal(after.payments[0].principal,100000);assert.equal(after.payments[0].interest,0);assert.equal(after.card.outstanding,1100000);assert.equal(await bal(),beforeBalance-100000);assert.equal((await finances()).transactions,ledger.transactions+1);
 mark("99:6 118:14 173:10","В сроковом платеже выбрать досрочку и записать 1000 RUB","Остаток долга 11 000 RUB, один перевод, проценты 0, счёт -1000 RUB", {payment:after.payments[0],outstanding:after.card.outstanding,balance:await bal(),ledgerDelta:1});
 await act('[data-testid="tab-history"]');await act('//*[@data-testid="payments"]//button[@title="Удалить платёж и его операции"]');await eventually(get,d=>d.payments.length===0);
 assert.equal((await get()).card.outstanding,1200000);assert.deepEqual(await finances(),ledger);
 await shot("payment-removed");
}
