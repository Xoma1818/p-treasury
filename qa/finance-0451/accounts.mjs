export async function run(b,{assert,proof,act,btn,value,select,nav,wait,close,read,getAccounts,eventually,shot}) {
 const mark=(p,a,e,v)=>proof("Accounts",p,a,e,v), name="Счёт QA EUR",g1="Группа QA 1",g2="Группа QA 2";
 const mine=async()=>(await getAccounts()).find(x=>x.name===name);
 await nav("Счета");await btn("+ Новый счёт");await value("name",name);await select("currency","EUR");await value("openingBalance","237");
 await act('[name="inForecast"]');await act('[name="includeInTotal"]');assert.equal(await b.$('[name="inForecast"]').isEnabled(),false);
 await close();const saved=await mine();assert.equal(saved.balance,23700);assert.equal(saved.currencyCode,"EUR");assert.equal(saved.includeInTotal,false);assert.equal(saved.inForecast,false);
 mark("323:6 329:14 383:12 392:14","Новый счёт EUR, убрать из прогноза и из общего баланса","23 700 центов EUR, оба флага выключены. При выключенном балансе прогноз заблокирован",saved);
 const row='[data-testid="account-row"][data-name="'+name+'"]';
 await act('//*[@data-testid="account-row" and @data-name="'+name+'"]//button[normalize-space()="Операции"]');
 await wait("main h1",/Операции/);await wait('[data-testid="chip-account"]',/Счёт QA EUR/);
 mark("131:10","Открыть операции из конкретного счёта","Фильтр журнала указывает выбранный счёт",await b.$('[data-testid="chip-account"]').getText());
 await nav("Счета");const menu=()=>act('button[aria-label="Ещё: '+name+'"]');await menu();await btn("Закрыть счёт");
 await eventually(mine,a=>a.archived===true);await eventually(()=>b.$(row).isExisting(),e=>!e);
 const toggle='//label[contains(.,"Показать закрытые счета")]/input';
 await act(toggle);await wait(row,/Счёт QA EUR/);await menu();await btn("Вернуть из закрытых");await eventually(mine,a=>a.archived===false);
 await act(toggle);await wait(row,/Счёт QA EUR/);assert.deepEqual(await mine(),saved);
 mark("198:10","Закрыть, показать закрытые, вернуть, скрыть закрытые","Восстановленный активный счёт виден с прежними реквизитами",await mine());
 await act('[data-testid="account-groups-open"]');const groups=async()=>(await read("list_account_groups",{today:new Date().toISOString().slice(0,10)})).map(g=>g.name);
 const base=await groups();
 for(const n of [g1,g2]){await value("groupName",n);await btn("Добавить",true);await eventually(groups,g=>g.includes(n))}
 const order=await groups();assert.deepEqual(order,[...base,g1,g2]);mark("249:6","Добавить две группы","Новые группы в конце списка",order);
 await act('button[aria-label="Выше: '+g2+'"]');await eventually(groups,g=>JSON.stringify(g)===JSON.stringify([...base,g2,g1]));
 mark("237:12","Переместить вторую группу выше","Вторая группа стоит перед первой",await groups());
 await act('button[aria-label="Ниже: '+g2+'"]');await eventually(groups,g=>JSON.stringify(g)===JSON.stringify(order));
 mark("240:12","Переместить вторую группу ниже","Первоначальный порядок восстановлен",await groups());
 await shot("account-groups");
 for(const n of [g1,g2]){await act('//*[@data-testid="group-item" and @data-name="'+n+'"]//button[normalize-space()="Удалить"]');await eventually(groups,g=>!g.includes(n))}
 assert.deepEqual(await groups(),base);await close("Готово");
}
