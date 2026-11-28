export async function run(b,{assert,proof,btn,act,value,select,nav,close,read,finances,shot}){
 const mark=(p,a,e,v)=>proof("Assets",p,a,e,v), name="Автомобиль QA";
 const all=()=>read("list_assets"), get=async()=>(await all()).find(a=>a.name===name);
 const baseline=await all(),ledger=await finances();
 await nav("Счета");await btn("+ Имущество");await value("assetName",name);await select("assetKind","vehicle");await select("assetCurrency","EUR");await value("assetValue","3210");await close();
 const a=await get();assert.equal(a.kind,"vehicle");assert.equal(a.currencyCode,"EUR");assert.equal(a.value,321000);assert.equal(a.history.length,1);
 mark("102:6 109:14 120:14","Создать имущество в EUR с типом Транспорт","Одна оценка 3 210,00 EUR, тип vehicle",a);
 const edit=()=>act('//*[@data-testid="asset-row" and contains(.,"'+name+'")]');
 await edit();await value("assetValue","4500");await close("Отмена");assert.deepEqual(await get(),a);mark("157:10","Отменить изменение оценки транспорта","Исходная оценка 3 210 EUR и вся история совпадают",await get());
 await edit();await value("assetValue","3500");await close();assert.equal((await get()).value,350000);assert.equal((await get()).history.length,1);await edit();await shot("asset-value");await close("Удалить");
 assert.deepEqual(await all(),baseline);assert.deepEqual(await finances(),ledger);
 mark("152:12","Исправить оценку той же датой, удалить имущество","Одна оценка 3 500 EUR перед удалением, исходные активы и денежный журнал после",ledger);
}
