import assert from 'node:assert/strict';
import {setTimeout as wait} from 'node:timers/promises';
import {launch} from './window.mjs';

const mode=process.argv[2];
assert.ok(['theme','reduced','controls','wide'].includes(mode));
process.env.KAZNA_QA_CLEAN='1';
const w=await launch(mode);
const observations=[];
const record=async (action,facts={})=>{observations.push({action,...facts});await w.evidence({observations});};
const move=(x,y)=>w.command('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
const rect=s=>w.run(selector=>{const el=document.querySelector(selector);const {x,y,width,height}=el.getBoundingClientRect();return {x,y,width,height};},s);
const click=async(s)=>{
  await w.run(selector=>document.querySelector(selector).scrollIntoView({block:'nearest'}),s);
  const r=await rect(s),x=r.x+r.width/2,y=r.y+r.height/2;
  assert.ok(await w.run((sel,x,y)=>document.querySelector(sel).contains(document.elementFromPoint(x,y)),s,x,y),'hittable: '+s);
  await move(x,y);
  for(const type of ['mousePressed','mouseReleased'])await w.command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,x,y});
};
const theme=async(t)=>{
  await record('Нажатие темы '+t);
  await click('[data-testid=theme-'+t+']');
  await w.until(()=>w.run(t=>document.documentElement.dataset.theme===t&&!document.documentElement.classList.contains('theme-fade'),t),'theme '+t);
  await record('Тема применена '+t,await w.run(()=>({theme:document.documentElement.dataset.theme,width:innerWidth,height:innerHeight,dpr:devicePixelRatio})));
};
try{
  await record('Начало',await w.run(()=>({os:navigator.userAgent,location:location.origin})));
  const account=(await w.invoke('list_accounts',{includeArchived:false}))[0].id;
  const cat=w.cats.find(c=>c.name==='Коммунальные платежи').id;
  if(mode==='controls'){
    const month=(await w.invoke('month_of',{date:w.today})).month;
    const budgetId=await w.invoke('create_budget',{month,copyPrevious:false});
    await w.invoke('set_budget_limit',{budgetId,categoryId:cat,limit:0});
    await w.refresh();await w.contains('.summary-lines','дневной лимит');
    for(const t of ['light','dark']){
      await theme(t);
      const q='[data-testid=home-summary] [data-testid=hint]';
      const tip='[data-testid=hint-tip]';
      const color=await w.run(q=>{
        const card=document.querySelector('[data-testid=home-summary]'),hint=document.querySelector(q),limit=[...card.querySelectorAll('li')].find(el=>el.textContent.includes('дневной лимит')).querySelector('b');
        const styles=e=>getComputedStyle(e),rgb=s=>s.match(/[\d.]+/g).slice(0,3).map(Number);
        const bg=rgb(styles(card).backgroundColor);
        const lum=c=>c.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
        const contrast=(e)=>{const opacity=Number(styles(e).opacity),c=rgb(styles(e).color).map((v,i)=>v*opacity+bg[i]*(1-opacity));const l=[lum(c),lum(bg)].sort((a,b)=>a-b);return (l[1]+.05)/(l[0]+.05);};
        return {bg:styles(card).backgroundColor,limit:styles(limit).color,hint:styles(hint).color,limitRatio:contrast(limit),hintRatio:contrast(hint)};
      },q);
      await record('Контраст '+t,color);
      assert.ok(color.limitRatio>=4.5&&color.hintRatio>=3,'контраст');
      await w.run(s=>document.querySelector(s).scrollIntoView({block:'center'}),q);
      const b=await rect(q);
      await move(b.x+b.width/2,b.y+b.height/2);await w.visible(tip);await wait(350);
      const f=await rect(tip);
      const y=f.y>b.y? (b.y+b.height+f.y)/2 : (f.y+f.height+b.y)/2;
      await move(b.x+b.width/2,y);await wait(450);await w.visible(tip);
      await move(f.x+f.width/2,f.y+f.height/2);await wait(500);await w.visible(tip);
      await w.shot(t+'-hint');
      await w.key('Escape');await w.until(()=>w.run(s=>!document.querySelector(s),tip),'Esc');
      await move(2,2);await w.focus(q);await w.visible(tip);await w.key('Tab');
      await w.until(()=>w.run(s=>!document.querySelector(s),tip),'tab exit');
      await record('Подсказка мышь, зазор, Esc, фокус, Tab '+t);
    }
  }else{
    await theme('dark');
    if(mode==='theme'||mode==='reduced'){
      await record('Исходный размер',await w.narrow());
      await w.nav('Настройки');await w.choose('[name=uiScale]','150');
      await w.until(()=>w.run(()=>devicePixelRatio>=1.49),'150%');
    }
    const title='Проверочный интернет';
    await w.txn(account,79000,title,cat,w.today);
    await w.invoke('create_reminder',{input:{title,startAt:w.plus(1)+'T12:00',repeat:'once',endDate:null,dayOfMonth:null,amount:79000,txnType:'expense',accountId:account,categoryId:cat,note:null,leadDays:null}});
    const initial=await w.bal(account), count=await w.count(account);
    await w.refresh();await w.nav('Календарь');await w.press('Напоминания');
    await w.command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:mode==='reduced'?'reduce':'no-preference'}]});
    const open=async()=>{await w.press('Учесть платёж','[data-testid=occurrence][data-title="'+title+'"]');await w.visible('.payment-review-actions .primary');await w.contains('.payment-review-actions .primary','Связать с платежом');};
    for(const t of ['dark','light','dark']){
      if(observations.at(-1)?.action==='Закрыт диалог клавишей Esc')await theme(t);
      await open();
      await w.focus('.payment-review-actions button');
      const focusOrder=[await w.focused()];await w.key('Tab');focusOrder.push(await w.focused());await w.key('Tab');focusOrder.push(await w.focused());
      assert.deepEqual(focusOrder,['Назад','Записать отдельный расход','Связать с платежом']);
      await wait(240);
      assert.equal(await w.bal(account),initial);assert.equal(await w.count(account),count);
      await record('Платёж открыт в '+t, {balance:initial,expenses:count,focusOrder});
      await w.shot(t+'-review');
      await w.key('Escape');await w.until(()=>w.run(()=>!document.querySelector('.payment-review-actions')),'платёж закрыт');
      await record('Закрыт диалог клавишей Esc');
    }
  }
  await record('PASS');
}catch(error){await record('FAIL',{error:String(error)});throw error;}finally{w.close();}
