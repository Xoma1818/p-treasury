import * as H from "./qa-finance-helpers.mjs";
const {assert}=H;
const {one,read,cmd,op,ym,day,hit,has,gone,seen,push,fill,tab,refresh,phase,journal}=H;
const log=(ids,a,e,v)=>H.mark("screens/Forecast",ids,a,e,v);
export async function scenarios(){
 const other=await cmd("create_scenario",{input:{name:"Сохранить",changes:[{kind:"once",title:"Книга",amount:-10000,startMonth:ym()}]}});
 let id;
 await refresh(); await tab("Взгляд вперёд");
 await phase("scenario-edit",async()=>{
   await hit('[data-testid="scenario-new"]'); await fill(H.b,"scenario-name","Разовый подарок"); await hit('[data-testid="scenario-add"]');
   await has('[data-testid="scenario-row"]');log("742:8","Добавить изменение","Появляется строка сценария","Строка добавлена");
   await (await H.el('[aria-label="Что меняется"]')).selectByAttribute("value","once");
   await (await H.el('[aria-label="Трата или доход"]')).selectByAttribute("value","1");
   await (await H.el('[aria-label="Подпись"]')).setValue("Подарок"); await fill(H.b,"scenario-amount","400");
   await hit('[data-testid="scenario-add"]');
   const remove=await H.b.$$('[aria-label="Убрать изменение"]');assert.equal(remove.length,2);await remove[1].click();
   assert.equal((await H.b.$$('[data-testid="scenario-row"]')).length,1);
   log("736:12","Убрать второй черновик","Одна строка","Осталась 1 строка");
   await hit('[data-testid="scenario-save"]'); await gone('[role="dialog"]');
   id=one("SELECT id FROM forecast_scenarios WHERE name=?","Разовый подарок");
   const saved=read("SELECT kind,title,amount FROM forecast_changes WHERE scenario_id=?",id);
   assert.deepEqual(saved,[{kind:"once",title:"Подарок",amount:40000}]);
   await seen('[data-testid="fc-end"] .tile-value',H.money("10400"));
   log("684:6 697:12 707:16","Сохранить разовый доход 400 ₽","В SQLite +40000 коп., из 10000 ₽ получается 10400 ₽",JSON.stringify(saved)+"; "+await H.text('[data-testid="fc-end"]'));
   await hit('[aria-label="Изменить сценарий «Разовый подарок»"]'); await fill(H.b,"scenario-name","Не сохранять");
   await push("Отмена",H.dlg); await gone('[role="dialog"]');assert.equal(one("SELECT name FROM forecast_scenarios WHERE id=?",id),"Разовый подарок");
   log("758:10","Отменить новое название","Сохранённое имя Разовый подарок","Имя в SQLite сохранилось");
 });
 await phase("refresh-comparison",async()=>{
   id=one("SELECT id FROM forecast_scenarios WHERE name=?","Разовый подарок");
   assert.ok(id); await has('[data-testid="scenario-second"]'); await seen('[data-testid="fc-now"]',H.money("10000"));
   // Simulate a concurrent legitimate account opening. The comparison will legitimately
   // load its second snapshot against a newer balance than the first, exercising recovery.
   await cmd("create_account",{ input:{name:"Второй кошелёк QA",type:"cash",currencyCode:"RUB",openingBalance:150000,openingDate:day(ym()),creditLimit:null,includeInTotal:true,investKind:null}});
   await (await H.el('[data-testid="scenario-second"]')).selectByAttribute("value",other);
   await push("Обновить сравнение"); await seen('[data-testid="fc-now"]',H.money("11500"));
   await seen('[data-testid="fc-end"] .tile-value',H.money("11900"));
   await gone('//button[normalize-space()="Обновить сравнение"]');
   assert.equal(one("SELECT SUM(opening_balance) FROM accounts"),1150000);
   log("166:8","Обновить сравнение на изменившейся базе","У обоих сценариев новый остаток 11500 ₽, основной +400 ₽","В окне 11900 ₽; кнопка сверки исчезла, в SQLite два счета на 1150000 коп.");
 });
}
export async function flow(){
 const categories=read("SELECT name FROM categories WHERE kind='expense' AND parent_id IS NULL AND name<>'Без категории' ORDER BY name LIMIT 10").map(r=>r.name);
 assert.ok(categories.length>=8);
 for(let i=0;i<categories.length;i++)await op("expense",day(ym(-2)),categories[i],(100+i)*100,"Поток-"+i);
 await op("income",day(ym(-2)),"Прочие доходы",500000,"Поток дохода");
 await refresh(); await tab("Взгляд вперёд"); await hit('[data-testid="tab-flow"]');
 await phase("flow-details",async()=>{
   await hit('[data-testid="flow-card"] [aria-label="Раньше"]');await has('[data-testid="flow-chart"]');
   const result=await cmd("money_flow",{kind:"month",month:ym(-2)});
   assert.equal(result.period.start,day(ym(-2)));
   log("807:10","Предыдущий период потока","Поток двухмесячной давности",result.period.start+" — "+result.period.end+"; "+await H.text('[data-testid="flow-title"]'));
   await hit('.flow-details summary');await push("Прочее",'//*[@data-testid="flow-table"]');await has('[role="dialog"] table');
   const btn=await H.el('[role="dialog"] tbody button');const name=await btn.getText();const ix=categories.indexOf(name);assert.ok(ix>=0);
   await btn.click();const found=await journal(["Поток-"+ix]);
   log("963:20","Из группы Прочее в её категорию","Только операция категории "+name+" на "+(100+ix)+" ₽",found);
 });
}
