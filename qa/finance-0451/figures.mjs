export async function run(b,{assert,proof,act,value,select,nav,wait,close,read,eventually,shot}) {
 const mark=(p,a,e,v)=>proof("Figures",p,a,e,v), a="Показатель QA A",c="Показатель QA B";
 const all=async()=>JSON.parse((await read("get_settings")).home_figures||"[]");
 const titles=async()=>(await all()).map(f=>f.title);
 const edit=()=>act('button[aria-label="Изменить «'+a+'»"]');
 const tags=await read("list_tags");assert.ok(tags.length,"В вымышленной базе ожидается тег");
 for(const name of [a,c]){
   await act('[data-testid="figure-add"]');await value("figureTitle",name);
   if(name===a){await select("figureMeasure","income");await select("figureTag",tags[0].id)}
   await close("На Главную");
 }
 const added=(await all()).find(f=>f.title===a);assert.equal(added.measure,"income");assert.equal(added.tagId,tags[0].id);
 mark("186:6 198:14 235:16 266:10","Создать доходный показатель с тегом","В настройках сохранены заголовок, мера income и выбранный тег",added);
 await edit();await value("figureTitle","Не сохранять");await close("Отмена");assert.deepEqual((await all()).find(f=>f.title===a),added);
 mark("105:16 263:10","Открыть показатель, отменить переименование","Полное описание показателя совпадает",added);
 const before=await titles();const i=before.indexOf(a);assert.ok(i>=0&&before[i+1]===c);const right=[...before];[right[i],right[i+1]]=[right[i+1],right[i]];
 await edit();await act('[aria-label="Правее"]');await eventually(titles,x=>JSON.stringify(x)===JSON.stringify(right));
 mark("257:14","Переместить вправо","Порядок соседних показателей изменён",{before,right});
 await edit();await act('[aria-label="Левее"]');await eventually(titles,x=>JSON.stringify(x)===JSON.stringify(before));
 mark("254:14","Переместить влево","Исходный порядок восстановлен",before);
 await act('[data-testid="figure"][data-name="'+a+'"] [data-testid="figure-value"]');await wait("main h1",/Операции/);
 await wait('[data-testid="chip-tag"]',new RegExp(tags[0].name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
 const tag=await b.$('[data-testid="chip-tag"]').getText();await shot("tag-filter");
 mark("109:14","Открыть сумму доходов с тегом","Открыты операции с ожидаемым тегом",{title:await b.$("main h1").getText(),tag});
 await nav("Главная");await edit();await close("Убрать с Главной");assert.deepEqual(await titles(),before.filter(x=>x!==a));mark("251:14","Убрать выбранный показатель","Другие показатели и их порядок сохранены",await titles());
}
