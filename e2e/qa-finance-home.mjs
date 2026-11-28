import * as H from "./qa-finance-helpers.mjs";
const {assert,one,read,cat,cmd,op,ym,day,hit,has,gone,seen,push,tab,refresh,phase,journal}=H;
const log=(ids,a,e,v)=>H.mark("components/QuickWins",ids,a,e,v);
export async function homeActions(){
 const current=day(ym(),Math.min(new Date().getDate(),27));
 for(const m of [-3,-2,-1]) await op("expense",day(ym(m)),"Питание",20000,"Старый магазин");
 await op("expense",day(ym()),"Питание",350000,"Покупка QA");
 const other=await op("expense",current,"Прочие расходы",733,"Без категории QA");
 await cmd("create_asset",{input:{name:"Учебная вещь",kind:"other",currencyCode:"RUB",value:5000,date:day(ym(-2)),note:null}});
 await H.budget(ym(),{"Питание":100000,"Жильё":500000,"Транспорт":410000});
 let pair;
 for(let i=0;i<7;i++){
   const payee="Повтор QA "+i;
   const a=await op("expense",current,"Транспорт",100+i,payee);
   const b=await op("expense",current,"Транспорт",100+i,payee);
   if(!i)pair=[a,b];
 }
 H.fixtureSql(db=>{
   db.prepare("INSERT INTO import_batches(id,created_at,origin,file_name) VALUES ('qa-batch',?,'manual','Учебная.csv')").run(current);
   db.prepare("INSERT INTO import_suggestions(id,import_id,kind,new_id,old_id,created_at) VALUES('qa-pair','qa-batch','same',?,?,?)").run(...pair,current);
 });
 await refresh();
 await phase("unusual",async()=>{
   await tab("Главная");const r='//*[@data-testid="home-unusual"]//li[.//b[normalize-space()="Питание"]]';
   await push("Посмотреть операции",r);
   log("59:18","Посмотреть аномальные расходы","Только магазин текущего месяца на 3500 ₽",await journal(["Покупка QA"]));
   await tab("Главная");await push("Изменить план",r);await has('//main//h1[normalize-space()="Бюджет"]');
   const focus=await H.b.waitUntil(()=>H.b.execute(()=>document.activeElement?.closest('[data-category]')?.getAttribute("data-category")==="Питание"||document.activeElement?.getAttribute("aria-label")?.includes("Питание")),{timeout:5000});
   assert.equal(H.savedLimit(ym(),"Питание"),100000);
   log("63:20","Изменить план необычной траты","Открыт редактор категории Питание с лимитом 1000 ₽","Фокус на поле лимита; SQLite 100000 коп.");
 });
 await phase("duplicates",async()=>{
   await tab("Главная"); await has('[data-testid="checks-more"]');
   const home='[data-testid="home-checks"]';
   const count=async()=> (await H.b.$$(home+' [data-testid="check-row"]')).length;
   const before=await count(); assert.equal(before,5);
   await hit('[data-testid="checks-more"]');await H.b.waitUntil(async()=>await count()>5);
   const expanded=await count();await hit('[data-testid="checks-more"]');await H.b.waitUntil(async()=>await count()===5);
   log("276:8","Развернуть и свернуть проверки","5 строк → больше 5 → 5",before+" → "+expanded+" → "+await count());
   await push("Разобрать",'//*[@data-testid="checks-matches"]'); await seen('[role="dialog"]',/Повтор QA 0/);
   assert.equal(one("SELECT count(*) FROM import_suggestions"),1);
   log("205:10","Открыть совпадения выписки","В диалоге видна тестовая пара Повтор QA 0","1 предложение; обе исходные операции сохранены");
   await H.b.keys("Escape");await gone('[role="dialog"]');
   await tab("Бюджет");await hit('[data-testid="month-review-open"]'); await push("Проверить",'//*[@data-testid="review-todo"]');
   await has('//main//h1[normalize-space()="Главная"]');H.mark("components/MonthReview","113:20","Проверить совпадения из итогов","Открылась Главная с одной парой",await H.text('[data-testid="checks-matches"]'));
 });
 await phase("cover-warning",async()=>{
   await tab("Главная");const w='//*[@data-testid="warning-row"][.//*[contains(text(),"Питание")]]';
   await hit(w+'//button[@data-testid="warning-cover"]');await has('[data-testid="cover-source"]');
   await (await H.el('[data-testid="cover-source"]')).selectByVisibleText("Транспорт");await seen('[role="dialog"]',H.money("2500"));
   H.mark("components/BudgetCoverDialog","43:10","Выбрать источник покрытия","Перерасход 3500−1000 = 2500 ₽","В предпросмотре 2500 ₽ из транспорта");
   await push("Отмена",H.dlg);await gone('[role="dialog"]');
   assert.equal(H.savedLimit(ym(),"Питание"),100000);assert.equal(H.savedLimit(ym(),"Транспорт"),410000);
   H.mark("components/BudgetCoverDialog","66:8","Отмена покрытия","Оба лимита сохранены","100000 и 410000 коп.");
   await push("Понятно",w);await gone(w);
   log("365:8","Скрыть предупреждение","Строка расхода исчезает, лимит прежний",H.savedLimit(ym(),"Питание")+" коп.");
 });
 await phase("status-actions",async()=>{
   await tab("Главная");
   await hit('[data-testid="data-status-row"][data-key="backup"] button'); await has('[data-testid="backup-card"]');
   log("335:14","Состояние данных → Копии","Открыта карточка резервных копий","Видна карточка backup-card");
   await tab("Главная");await hit('[data-testid="data-status-row"][data-key="uncategorized"] button');
   log("335:14","Состояние данных → Разобрать","Только расход 7,33 ₽ без категории",await journal(["Без категории QA"]));
   await tab("Главная");await hit('[data-testid="open-operations-review"]');await has('[data-testid="review-uncategorized"]');
   await push("Открыть операции",'//*[@data-testid="review-uncategorized"]');
   log("214:10","Проверки операций → без категории","Только расход 7,33 ₽",await journal(["Без категории QA"]));
 });
 await phase("net-worth",async()=>{
   await tab("Главная");await hit('[data-testid="home-net-worth-spark"]');await has('[data-testid="networth-report"]');
   const expected=1000000-3*20000-350000-733-2*(100+101+102+103+104+105+106)+5000;
   await seen('[data-testid="networth-last"]',H.money((expected/100).toFixed(2).replace(".",",")));
   log("380:4","Мини-график капитала → отчёт","587825 коп. денег + 5000 коп. имущества",await H.text('[data-testid="networth-last"]'));
 });
}
