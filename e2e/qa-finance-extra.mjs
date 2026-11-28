import * as H from "./qa-finance-helpers.mjs";
import {point} from "./qa-finance-reports.mjs";
import {spawnSync} from "node:child_process";
const {assert,one,cmd,op,ym,day,hit,has,gone,seen,push,fill,tab,refresh,phase,journal}=H;
export async function extras(){
 const merchant="Сервис QA";let id;
 for(let i=-2;i<=0;i++) id=await op("expense",day(ym(i)), "Питание",1999,merchant);
 const outside=await op("expense",day(ym()),"Транспорт",777,"Попутная покупка");
 await cmd("set_transaction_tags",{id,tags:["Метка QA"]});await cmd("set_transaction_tags",{id:outside,tags:["Метка QA"]});
 await refresh();
 await phase("subscriptions",async()=>{
   await tab("Главная");await push("Все подписки",'//*[@data-testid="home-subs"]');await seen('[data-testid="subs-year"]',H.money("239,88"));
   H.mark("components/Subscriptions","91:8","Открыть все подписки","19,99 × 12 = 239,88 ₽",await H.text('[data-testid="subs-year"]'));
   const scope='//*[@data-testid="subs"]//li[@data-testid="sub-row"]';
   await push(merchant,scope);
   H.mark("components/Subscriptions","47:8","Открыть платежи одной подписки","Три списания по 19,99 ₽",await journal([merchant,merchant,merchant]));
 });
 await phase("tags",async()=>{
   await tab("Отчёты");await push("По тегу");await (await H.el('[name="reportTag"]')).selectByVisibleText("Метка QA");
   await seen('[data-testid="tag-expense"]',H.money("27,76"));await hit('[data-testid="tag-expense"] button');
   H.mark("components/Tags","180:14","Расходы тега → журнал","19,99 + 7,77 = 27,76 ₽",await journal([merchant,"Попутная покупка"]));
   await tab("Отчёты");await push("По тегу");await (await H.el('[name="reportTag"]')).selectByVisibleText("Метка QA");
   const button='//*[@data-testid="tag-cat"]//button[contains(.,"Питание")]';await hit(button);
   H.mark("components/Tags","205:22","Строка категории тега","Только продуктовая подписка текущего месяца",await journal([merchant]));
 });
 await phase("years",async()=>{
   await tab("Отчёты");await push("Итоги года");await hit('[aria-label="Прошлый год"]');await seen('[data-testid="year-title"]',new RegExp(String(H.yyyy-1)));
   H.mark("components/YearReview","32:10","Год назад","Итоги предыдущего года",await H.text('[data-testid="year-title"]'));
   await hit('[data-testid="year-review"] [aria-label="Следующий год"]');
   await seen('[data-testid="year-expense"]',H.money("67,74"));
   H.mark("components/YearReview","36:10","Вернуться в текущий год","3 × 19,99 + 7,77 = 67,74 ₽",await H.text('[data-testid="year-expense"]'));
   await hit('[data-testid="year-share"]');await has('[data-testid="year-card"]');
   const dims=await H.b.execute(()=>{const c=document.querySelector('[data-testid="year-card"]');return [c.width,c.height];});
   await push("Копировать",H.dlg);await seen('[role="dialog"]',/Картинка скопирована/);
   const check=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-STA","-Command",
    "Add-Type -AssemblyName System.Windows.Forms; $i=[System.Windows.Forms.Clipboard]::GetImage(); if (!$i) {throw 'No image on the clipboard'}; Write-Output ($i.Width.ToString()+'x'+$i.Height.ToString())"],{encoding:"utf8",windowsHide:true});
   assert.equal(check.stdout.trim(),dims.join("x"));
   H.mark("components/YearReview","222:12","Скопировать годовую картинку","Системный буфер содержит изображение размера холста",dims.join("×")+" px");
   await H.b.keys("Escape");
 });
 await phase("net-assets",async()=>{
   await tab("Отчёты");await push("Чистые активы");await has('.nw-dot');
   const len=await H.b.$$('.nw-dot');assert.ok(len.length>=2);
   const sel='[data-testid="networth-report"] svg g:last-of-type rect.hit';await point(sel);
   await seen('[data-testid="networth-tip"]',H.money("9932,26"));
   H.mark("components/NetWorth","123:10","Выбрать месяц на графике","Чистые активы 10000−67,74 = 9932,26 ₽",await H.text('[data-testid="networth-tip"]'));
 });
 await phase("events",async()=>{
   await tab("Бюджет");await push("+ Событие");await fill(H.b,"eventName","Отмена QA");await push("Отмена",H.dlg);await gone('[role="dialog"]');
   assert.equal(one("SELECT count(*) FROM events"),0);
   H.mark("components/Events","137:10","Отменить создание события","0 событий в SQLite","0");
   await push("+ Событие");await fill(H.b,"eventName","Поездка QA");await push("Сохранить",H.dlg);await gone('[role="dialog"]');
   assert.equal(one("SELECT count(*) FROM events WHERE name='Поездка QA'"),1);assert.equal(one("SELECT SUM(amount) FROM transactions"),6774);
   H.mark("components/Events","117:6","Сохранить событие","Появилось одно событие, сумма расходов прежняя","1 событие; 6774 коп.");
 });
 await phase("finished-month",async()=>{
   const dom=new Date().getDate();await cmd("set_setting",{key:"month_start_day",value:String(dom)});await refresh();await tab("Главная");
   await hit('[data-testid="month-review-banner"] button');await seen('[data-testid="review-expense"]',H.money("27,76"));
   H.mark("components/MonthReview","174:8","Открыть итоги только что закончившегося периода","В периоде две операции: 19,99 + 7,77 ₽",await H.text('[data-testid="review-expense"]'));
 });
}
