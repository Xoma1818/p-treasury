import * as H from "./qa-finance-helpers.mjs";
const {assert,one,cat,cmd,op,budget,ym,day,hit,has,gone,seen,push,fill,tab,refresh,savedLimit,phase,journal}=H;
const screen="screens/Budget";
const log=(ids,a,e,v)=>H.mark(screen,ids,a,e,v);
export async function groups(){
  await budget(ym(),{"Питание":40000});
  await op("income",day(ym()),"Прочие доходы",400000,"Доход группы");
  await op("expense",day(ym()),"Питание",35000,"Продукты группы");
  await refresh(); await tab("Бюджет");
  await phase("custom-groups", async()=>{
    await push("Свои группы"); await has('[name="budgetGroupName"]');
    log("618:10","Открыть свои группы","Пустой редактор","Поле budgetGroupName отображено");
    await fill(H.b,"budgetGroupName","Обед QA"); await fill(H.b,"budgetGroupShare","25");
    await push("Добавить",H.dlg);
    await H.b.waitUntil(()=>one("SELECT share_bp FROM budget_groups WHERE name='Обед QA'")===2500);
    log("703:6 706:8","Сохранить группу 25%","Строка группы и 2500 базисных пунктов","2500 б.п. в SQLite");
    await (await H.el('[aria-label="Группа «Питание»"]')).selectByVisibleText("Обед QA");
    await H.b.waitUntil(()=>one("SELECT g.name FROM categories c JOIN budget_groups g ON g.id=c.budget_group_id WHERE c.name='Питание'")==="Обед QA");
    log("720:20","Назначить категорию","У категории Питание сохранена группа Обед QA","Связь прочитана из SQLite");
    await push("Готово",H.dlg); await gone('[role="dialog"]');
    const row='[data-testid="budget-group"][data-name="Обед QA"]';
    await seen(row,H.money("350")); await seen(row,H.money("1000"));
    log("738:8","Закрыть редактор с назначением","Расход 350 ₽, цель 25% × 4000 ₽ = 1000 ₽",await H.text(row));
    await hit('[data-testid="budget-groups-edit"]'); await has('[aria-label="Название группы"]');
    log("608:10","Настроить сохранённую группу","Редактор показывает текущее имя",await (await H.el('[aria-label="Название группы"]')).getValue());
    await push("Удалить",'//*[@data-testid="budget-group-list"]'); await gone('[aria-label="Название группы"]');
    assert.equal(one("SELECT count(*) FROM budget_groups"),0); assert.equal(one("SELECT budget_group_id FROM categories WHERE name='Питание'"),null);
    assert.equal(one("SELECT SUM(amount) FROM transactions WHERE type='expense'"),35000);
    log("697:12","Удалить группу","Категория освобождена; расход 350 ₽ сохранён","0 групп, связь NULL, расходы 35000 коп.");
    await push("Готово",H.dlg);
  });
}
export async function month(){
  for(const [i,amt] of [[-3,10000],[-2,30000],[-1,50000]])await op("expense",day(ym(i)),"Питание",amt,"База "+i);
  await op("expense",day(ym()),"Питание",350000,"Текущая покупка");
  await budget(ym(1),{"Питание":900000});
  await refresh(); await tab("Бюджет");
  await phase("budget-average",async()=>{
    await push("По тратам за 3 месяца"); await H.b.waitUntil(()=>savedLimit(ym(),"Питание")===30000);
    log("120:8","Создать бюджет по прошлым тратам","(100 + 300 + 500)/3 = 300 ₽","Лимит 30000 коп.");
    const bid=one("SELECT id FROM budgets WHERE period_start=?",day(ym()));
    await cmd("set_budget_limit",{budgetId:bid,categoryId:cat("Питание"),limit:10000});
    await refresh(); await tab("Бюджет"); await hit('[aria-label="Лимит «Питание» по среднему за 3 месяца"]');
    await H.b.waitUntil(()=>savedLimit(ym(),"Питание")===30000);
    log("386:22","Вернуть лимит одной категории по среднему","100 ₽ заменились на 300 ₽","30000 коп.");
  });
  await phase("copy-year",async()=>{
    await tab("Бюджет"); await (await H.el('[name="copyMonths"]')).selectByAttribute("value","1");
    await hit('[name="copyOverwrite"]'); await push("Скопировать",'//*[@data-testid="copy-forward"]');
    await seen('[data-testid="copy-done"]',/заменено: 1/);
    assert.equal(savedLimit(ym(1),"Питание"),30000);
    log("582:8","Заменить существующий будущий план","9000 ₽ заменяются на 300 ₽",savedLimit(ym(1),"Питание")+" коп.");
    await push("Удалить бюджет месяца"); await push("Отмена");
    assert.equal(savedLimit(ym(),"Питание"),30000);
    log("246:14","Отменить удаление бюджета","Лимит 300 ₽ сохраняется",savedLimit(ym(),"Питание")+" коп.");
    await hit('[data-testid="budget-mode-year"]'); await hit('[aria-label="Предыдущий год"]');
    await seen('[data-testid="budget-year"] h2',new RegExp(String(H.yyyy-1)));
    log("760:10","Предыдущий год в бюджете","Год "+(H.yyyy-1),await H.text('[data-testid="budget-year"] h2'));
    await hit('[aria-label="Следующий год"]'); await seen('[data-testid="budget-year"] h2',new RegExp(String(H.yyyy)));
    log("764:10","Следующий год в бюджете","Год "+H.yyyy,await H.text('[data-testid="budget-year"] h2'));
  });
  await phase("month-review",async()=>{
    await tab("Бюджет"); await hit('[data-testid="budget-mode-month"]'); await hit('[data-testid="month-review-open"]');
    await seen('[data-testid="review-over"]',H.money("3500")); await push("Питание",'//*[@data-testid="review-over"]');
    const found=await journal(["Текущая покупка"]); H.mark("components/MonthReview","96:20","Открыть перерасход категории","Одна операция на 3500 ₽",found);
    await tab("Бюджет"); await hit('[data-testid="month-review-open"]'); await push("Закрыть",H.dlg); await gone('[role="dialog"]');
    H.mark("components/MonthReview","140:12","Закрыть итоги месяца","Возврат к бюджету без изменений",savedLimit(ym(),"Питание")+" коп.");
  });
}
