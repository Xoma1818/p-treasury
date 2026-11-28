import * as H from "./qa-finance-helpers.mjs";
const {assert,cmd,read,one,op,ym,day,hit,has,gone,seen,push,tab,refresh,phase,journal}=H;
const log=(ids,a,e,v)=>H.mark("screens/Reports",ids,a,e,v);
export async function point(selector, avoidControls=false) {
  const pt = await H.b.execute((s,avoid)=>{
    const node=document.querySelector(s);if(!node)return null;
    node.scrollIntoView({block:"center"});const r=node.getBoundingClientRect();
    for(let y=Math.ceil(Math.max(0,r.top))+1;y<Math.min(r.bottom,innerHeight)-1;y+=2){
      for(let x=Math.ceil(Math.max(0,r.left))+1;x<Math.min(r.right,innerWidth)-1;x+=2){
        const e=document.elementFromPoint(x,y);
        if(e&&(e===node||node.contains(e))&&!(avoid&&e.closest("button,a,input")))return {x,y};
      }
    }
    return null;
  },selector,avoidControls);
  assert.ok(pt,"Visible point on "+selector);
  await H.b.performActions([{type:"pointer",id:"mouse",parameters:{pointerType:"mouse"},actions:[
   {type:"pointerMove",duration:0,x:pt.x,y:pt.y},{type:"pointerDown",button:0},{type:"pointerUp",button:0}]}]);
  await H.b.releaseActions();
}
async function openReport(label) {await tab("Отчёты"); if(label)await push(label);}
export async function reports(){
  await op("income",day(ym()),"Прочие доходы",240000,"Доход нынешний");
  await op("expense",day(ym()),"Питание",33300,"Магазин А");
  await op("expense",day(ym()),"Транспорт",11100,"Поездка Б");
  await op("income",day(ym(-1)),"Прочие доходы",120000,"Доход прошлый");
  await refresh();
  await phase("summary-period",async()=>{
    await tab("Отчёты");await hit('[aria-label="Предыдущий период"]');await seen('[data-testid="report-income"]',H.money("1200"));
    await hit('[aria-label="Следующий период"]');await seen('[data-testid="report-income"]',H.money("2400"));
    log("287:18","Следующий отчётный период","Предыдущий доход 1200 ₽ → текущий 2400 ₽",await H.text('[data-testid="report-income"]'));
    await hit('[data-report-source="total-income"]');
    log("324:14","Доходы отчёта → операции","Только доход 2400 ₽",await journal(["Доход нынешний"]));
    await tab("Отчёты");await seen('[data-testid="report-expense"]',H.money("444"));await hit('[data-report-source="total-expense"]');
    log("331:14","Расходы отчёта → операции","Расходы 333 + 111 = 444 ₽",await journal(["Магазин А","Поездка Б"]));
  });
  await phase("donut",async()=>{
    await tab("Отчёты");await push("Структура");await push("Доли");await has('[data-testid="structure-donut"] svg path');
    const path='[data-testid="structure-donut"] svg path';
    const label=await H.b.execute(s=>document.querySelector(s).querySelector("title").textContent,path);
    assert.match(label,/Питание|Транспорт/); await point(path);
    const payee=label.includes("Питание")?"Магазин А":"Поездка Б";
    log("592:10","Дуга круговой диаграммы → операции","Только выбранная категория "+label,await journal([payee]));
  });
  await phase("rows",async()=>{
    await openReport("По месяцам");const row='[data-testid="month-row"][data-month="'+ym()+'"]';
    await has(row);await point(row,true);
    log("667:16","Щелчок по свободной области строки месяца","3 исходные проводки",await journal(["Доход нынешний","Магазин А","Поездка Б"]));
    await openReport("Остатки на дату");const bal='[data-testid="balance-row"]';
    await seen(bal,H.money("13156")); await point(bal,true);
    log("887:14","Строка баланса → журнал счёта","10000+1200+2400−444 = 13156 ₽ и 4 проводки",await journal(["Доход прошлый","Доход нынешний","Магазин А","Поездка Б"]));
  });
  await phase("compare",async()=>{
    await openReport("Сравнение");await push("Доходы",'//*[contains(@class,"compare-switches")]');
    await seen('main',/Что изменилось в доходах/);
    const value=await H.text('[data-testid="cmp-income"]');assert.match(value,H.money("1200"));assert.match(value,H.money("2400"));
    H.mark("screens/Compare","117:16","Сравнить доходы двух месяцев","1200 ₽ → 2400 ₽, рост 100%",value);
  });
}
