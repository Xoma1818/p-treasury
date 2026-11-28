export async function run(b,{assert,proof,btn,nav,wait,act,value,close,read}) {
 const mark=(p,a,expected,actual)=>proof("Invest",p,a,expected,actual);
 const title=async()=>b.$("main h1").getText();
 await btn("Завести счёт");await wait("main h1",/Счета/);
 mark("130:10","Завести счёт в пустой инвестиционной карточке","Открыт раздел Счета",await title());
 await nav("Бюджет");await act('[data-testid="invest-plan-edit"]');await act('[data-testid="invest-plan-percent"]');await value("investPlanPercent","12");await close();
 assert.equal((await read("invest_overview")).accounts.length,0);
 await nav("Главная");await btn("Завести брокерский счёт");await wait("main h1",/Счета/);
 mark("156:14","Завести брокерский счёт при плане 12% без инвестиционных счетов","Открыт раздел Счета",await title());
}
