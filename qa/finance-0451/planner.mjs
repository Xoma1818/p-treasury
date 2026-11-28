export async function run(b,{assert,proof,act,btn,value,select,nav,wait,close,read,finances,shot}){
 const mark=(p,a,e,v)=>proof("LoanPlanner",p,a,e,v);
 const all=()=>read("list_debts"), base=await all(), ledger=await finances(), n="Новый учебный заём 0451";
 await nav("Займы и долги");await btn("Калькулятор");await btn("Все долги");await wait("main h1",/Займы и долги/);assert.deepEqual(await all(),base);mark("86:6","Выйти из калькулятора кнопкой Все долги","Список долгов прежний",base.length);
 await btn("+ Новый долг");await value("principal","12000");await value("rate","12");await value("term","3");
 await btn("Ставка меняется?");await b.$('[name="rate-value-0"]').waitForDisplayed();await value("rate-value-0","10");
 mark("215:12","Открыть редактор ставок, задать 10%","Появилась первая строка переменной ставки",await b.$('[name="rate-value-0"]').getValue());
 await btn("+ Ставка с даты");await value("rate-value-1","15");assert.equal((await b.$$('[data-testid="rate-lines"] .loan-line')).length,2);
 proof("Editors","67:6","Добавить ставку с даты","Две ставки, вторая 15%",await b.$('[name="rate-value-1"]').getValue());
 await act('(//*[@data-testid="rate-lines"]//*[@aria-label="Убрать ставку"])[last()]');
 assert.equal((await b.$$('[data-testid="rate-lines"] .loan-line')).length,1);await act('[aria-label="Убрать ставку"]');await b.$('[data-testid="rate-lines"]').waitForExist({reverse:true});
 proof("Editors","62:10","Удалить две дополнительные ставки","Редактор исчез, расчёт вернулся к исходной ставке 12%",await b.$('[name="rate"]').getValue());
 await btn("Записать заём");await btn("Я дал в долг",true);await value("counterparty",n);await close("Отмена");assert.deepEqual(await all(),base);assert.deepEqual(await finances(),ledger);
 mark("510:10","Отменить запись рассчитанного займа","Ни долга, ни операции",ledger);
 await btn("Записать заём");await btn("Я дал в долг",true);await value("counterparty",n);await select("account","");await close();
 const d=(await all()).find(d=>d.counterparty===n);assert.equal(d.direction,"lent");assert.equal(d.outstanding,1200000);assert.equal(d.principal,1200000);assert.equal(d.rateBp,1200);assert.equal((await finances()).transactions,ledger.transactions);
 mark("474:6 483:12","Выбрать Я дал в долг и записать без счета","Долг 12 000 RUB под 12%, направление lent, без проводки",d);
 await btn("Удалить долг");await btn("Отмена");assert.deepEqual((await all()).find(x=>x.id===d.id),d);proof("Debts","399:14","Отменить удаление","Запись долга полностью совпадает",d.id);
 const rename=()=>btn("Изменить название и комментарий");
 await rename();await value("counterparty","Отменённое имя");await close("Отмена");assert.deepEqual((await all()).find(x=>x.id===d.id),d);proof("Debts","540:10","Отменить переименование","Имя, условия, остаток сохранены",d.counterparty);
 await rename();await value("counterparty",n+" A");await value("note","Учебная запись");await close();const changed=(await all()).find(x=>x.id===d.id);assert.equal(changed.counterparty,n+" A");assert.equal(changed.note,"Учебная запись");assert.equal(changed.outstanding,d.outstanding);
 proof("Debts","534:6","Сохранить имя и комментарий","Поля обновлены на том же долге, остаток прежний",{id:d.id,name:changed.counterparty,note:changed.note,outstanding:changed.outstanding});
 await shot("changed-debt");await btn("Удалить долг");await btn("Да, удалить");await wait("main h1",/Займы и долги/);assert.deepEqual(await all(),base);assert.deepEqual(await finances(),ledger);
}
