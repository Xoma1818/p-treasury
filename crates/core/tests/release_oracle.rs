use budget_core::{accounts::{self,AccountInput},assets,budgets,calendar,categories,currencies,debts,events,explain,forecast,goals,invest,net_worth,receipts,refunds,reports,settings,storage::Storage,subscriptions,tags,transactions::{self,TxnInput},year};
use budget_core::Connection;
use chrono::{Datelike, Duration, NaiveDate};
use rusqlite::params;
use serde_json::json;
use std::collections::BTreeMap;
use std::io::Write;

fn check(label: &str, expected:i64, actual:i64) {
    let record=json!({"metric":label,"expected":expected,"actual":actual,"pass":expected==actual});
    let p = std::env::var("KAZNA_NUM_PROOF").unwrap_or_else(|_| "math-proof.jsonl".into());
    writeln!(std::fs::OpenOptions::new().create(true).append(true).open(p).unwrap(),"{record}").unwrap();
    if expected!=actual {eprintln!("MISMATCH {record}");}
}
fn account(c:&Connection,n:&str,kind:&str,cur:&str,opening:i64)->String{
    accounts::create(c,&AccountInput{name:n.into(), kind:kind.into(), currency_code:cur.into(),opening_balance:opening,opening_date:"2023-01-01".into(),credit_limit:None,include_in_total:true, invest_kind:if kind=="investment"{Some("broker".into())}else{None}}).unwrap()
}
fn cat(c:&Connection,n:&str)->String {c.query_row("SELECT id FROM categories WHERE name=?1",[n],|r|r.get(0)).unwrap()}
fn post(c:&Connection,kind:&str,date:&str,id:&str,amount:i64,category:Option<&str>,to:Option<(&str,i64)>,payee:&str)->String {
 transactions::create(c,&TxnInput{kind:kind.into(),date:date.into(),account_id:id.into(),amount,category_id:category.map(Into::into),to_account_id:to.map(|x|x.0.into()),to_amount:to.map(|x|x.1),payee:Some(payee.into()),note:None}).unwrap()
}
#[test]
fn deterministic_stress_oracle() {
 // 731 days incl leap day; independently accumulated RUB/USD account movements and dated RUB flows.
 let mut db=Storage::open_in_memory().unwrap(); let c=db.conn();
 categories::seed_defaults(c).unwrap();
 let card=account(c,"Stress Card","debit","RUB",1_200_000); let usd=account(c,"Stress USD","cash","USD",8500);
 let income=cat(c,"Прочие доходы");let food=cat(c,"Питание");
 currencies::set_rate(c,"2023-01-01","USD","RUB","89").unwrap();
 currencies::set_rate(c,"2025-01-01","USD","RUB","97").unwrap();
 let start=NaiveDate::from_ymd_opt(2024,1,1).unwrap(); let mut daily=BTreeMap::new(); let mut monthly:BTreeMap<String,(i64,i64)>=BTreeMap::new();
 let mut rb=1_200_000i64; let mut ub=8500i64; let mut count=0;
 let tx=db.conn_mut().transaction().unwrap();
 {
 let mut st=tx.prepare("INSERT INTO transactions(id,type,date,account_id,amount,category_id,to_account_id,to_amount,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?3,?3)").unwrap();
 for day in 0..731 {let when=start+Duration::days(day);let date=when.to_string();let fx=if when.year()==2024{89}else{97};let mut inc=0;let mut exp=0;
   for j in 0..160 {let val= (day*97+j*13)%2731+1; let (kind,acc,act,ct,to,other)=match j%8{
       0=>{let v=val*120;rb+=v;inc+=v;("income",&card,v,Some(&income),None,None)},
       1=>{ub+=val;inc+=val*fx;("income",&usd,val,Some(&income),None,None)},
       2=>{rb-=val*fx;ub+=val;("transfer",&card,val*fx,None,Some(&usd),Some(val))},
       3=>{ub-=val;exp+=val*fx;("expense",&usd,val,Some(&food),None,None)},
       _=>{rb-=val;exp+=val;("expense",&card,val,Some(&food),None,None)}};
    count+=1; st.execute(params![format!("fixture-{count}"),kind,date,acc,act,ct,to,other]).unwrap();
   }
   let m=monthly.entry(date[..7].to_owned()).or_default();m.0+=inc;m.1+=exp;
   daily.insert(date,(inc,exp,rb,ub,rb+ub*fx));
 }}
 tx.commit().unwrap();
 let c=db.conn();check("stress/journal row count",116960,transactions::list(c,&Default::default()).unwrap().total as i64);
 let ms=reports::by_month(c,"2024-01","2025-12").unwrap();check("stress/month rows",24,ms.months.len() as i64);
 for m in &ms.months {let key=&m.period.month;let (i,e)=monthly[key];
   check(&format!("stress/reports/{key}/income"),i,m.income);check(&format!("stress/reports/{key}/expense"),e,m.expense);
   check(&format!("stress/reports/{key}/saldo"),i-e,m.balance);
   let budget=budgets::get(c,key,&m.period.end).unwrap();check(&format!("stress/budget/{key}/income"),i,budget.actual_income);check(&format!("stress/budget/{key}/expense"),e,budget.actual_expense);
   let cal=calendar::month(c,key,"2025-12-31").unwrap();for d in cal.days{let (i,e,_,_,_)=daily[&d.date];check(&format!("stress/calendar/{}/income",d.date),i,d.income);check(&format!("stress/calendar/{}/expense",d.date),e,d.expense);}
   let (..,cash,dollars,total)=daily[&m.period.end];
   check(&format!("stress/accounts/{key}/rub"),cash,accounts::balance(c,&card,Some(&m.period.end)).unwrap());
   check(&format!("stress/accounts/{key}/usd"),dollars,accounts::balance(c,&usd,Some(&m.period.end)).unwrap());
   check(&format!("stress/home/{key}/balance"),total,accounts::totals(c,&m.period.end).unwrap().total);
   check(&format!("stress/explanation/{key}/balance"),total,explain::balance(c,&m.period.end).unwrap().total);
 }
 let (..,total)=daily["2025-12-31"];check("stress/net worth after two years",total,net_worth::on_date(c,"2025-12-31",&mut vec![]).unwrap().net);
 for y in [2024,2025] {let (i,e)=monthly.iter().filter(|(m,_)|m.starts_with(&y.to_string())).fold((0,0),|(a,b),(_,v)|(a+v.0,b+v.1));
 let row=year::review(c,y,"2025-12-31").unwrap();check(&format!("stress/year/{y}/income"),i,row.income);check(&format!("stress/year/{y}/expense"),e,row.expense);}
}
#[test]
fn period_split_refund_and_exchange(){
 let mut db=Storage::open_in_memory().unwrap(); let c=db.conn();
 categories::seed_defaults(c).unwrap();settings::set(c,"month_start_day","10").unwrap();
 currencies::set_rate(c,"2026-01-01","USD","RUB","90.125").unwrap();
 let rub=account(c,"Карта","debit","RUB",950000);let usd=account(c,"Валюта","debit","USD",5000);
 let food=cat(c,"Питание");let other=cat(c,"Жильё");let income=cat(c,"Прочие доходы");
 post(c,"income","2026-01-10",&rub,111111,Some(&income),None,"Доход");
 let buy=post(c,"expense","2026-01-12",&usd,101,Some(&food),None,"Отдельная покупка");
 post(c,"transfer","2026-01-17",&rub,18025,None,Some((&usd,200)),"Обмен");
 let spread=post(c,"expense","2026-01-31",&rub,10003,Some(&food),None,"На три месяца");
 transactions::set_spread(c,&spread,Some(3)).unwrap();
 let refund=refunds::create(c,&refunds::RefundInput{of:buy,date:"2026-02-11".into(),account_id:None,amount:17,in_purchase_month:false,note:None}).unwrap();
 let _=refund;
 receipts::create(db.conn_mut(),&receipts::ReceiptInput{date:"2026-02-09".into(),account_id:rub.clone(),payee:Some("Два товара".into()),note:None,total:5500,parts:vec![receipts::PartInput{category_id:food.clone(),amount:3700,note:None},receipts::PartInput{category_id:other,amount:1800,note:None}],tags:vec!["witness".into()],event_id:None}).unwrap();
 let budget=budgets::create(db.conn_mut(),"2026-02",false).unwrap();let c=db.conn();budgets::set_limit(c,&budget,&food,Some(25000)).unwrap();
 // Raw debit on Jan 31; reporting splits 10003 into 3335 + 3334 + 3334.
 // USD: 101*90.125 = 9102.625 -> 9103; 17*90.125 = 1532.125 -> 1532.
 let win=[("2026-02","2026-01-10","2026-02-09",3335+9103+5500,111111),("2026-03","2026-02-10","2026-03-09",3334-1532,0),("2026-04","2026-03-10","2026-04-09",3334,0)];
 for (m,from,to,exp,inc) in win {let b=budgets::get(c,m,to).unwrap();check(&format!("boundary/{m}/budget_expense"),exp,b.actual_expense);check(&format!("boundary/{m}/budget_income"),inc,b.actual_income);check(&format!("boundary/{m}/report"),exp,reports::by_category(c,"expense",from,to).unwrap().total);check(&format!("boundary/{m}/home_drilldown"),exp,explain::period(c,from,to,"expense").unwrap().total);}
 let card=950000+111111-18025-10003-5500;let dollar=5000-101+200+17;
 check("boundary/card after all postings",card,accounts::balance(c,&rub,None).unwrap());check("boundary/USD after all postings",dollar,accounts::balance(c,&usd,None).unwrap());
 check("boundary/total; round current USD balance once",card+(dollar*90125+500)/1000,accounts::totals(c,"2026-04-09").unwrap().total);
 let d=calendar::month(c,"2026-01","2026-02-28").unwrap();check("calendar/actual debit Jan31",10003,d.days.iter().find(|d|d.date=="2026-01-31").unwrap().expense);
 let d=calendar::month(c,"2026-02","2026-02-28").unwrap();check("calendar/refund net Feb11",-1532,d.days.iter().find(|d|d.date=="2026-02-11").unwrap().expense);
 let tag:String=c.query_row("SELECT id FROM tags WHERE name='witness'",[],|r|r.get(0)).unwrap();check("tag/receipt children",5500,tags::report(c,&tag,"2026-02-01","2026-02-28").unwrap().expense);
 let event=events::create(c,&events::EventInput{name:"Сбор".into(),start_date:"2026-01-30".into(),end_date:"2026-02-01".into(),budget:Some(20000),note:None}).unwrap();
 events::assign(c,Some(&event),&[spread]).unwrap();check("event/actual full purchase",10003,events::list(c,"2026-02-28").unwrap()[0].spent);
}

#[test]
fn positions_interest_plans_and_subscriptions(){
 let mut db=Storage::open_in_memory().unwrap();let c=db.conn();categories::seed_defaults(c).unwrap();
 let card=account(c,"Карта","debit","RUB",1_000_000);let broker=account(c,"Брокер","investment","RUB",0);let food=cat(c,"Питание");
 let debt:debts::DebtInput=serde_json::from_value(json!({"direction":"borrowed","counterparty":"Учебный кредитор","note":null,"currencyCode":"RUB","principal":100000,"issueDate":"2026-01-02","rateBp":1200,"repaymentType":"bullet","termMonths":null,"firstPaymentDate":null,"maturityDate":"2026-12-02","accountId":card})).unwrap();
 let id=debts::create(db.conn_mut(),&debt).unwrap();
 let payment=|p,i| debts::PaymentInput{principal:p,interest:i,account_id:card.clone(),date:"2026-03-03".into(),schedule_id:None,recalc_mode:None};
 debts::pay(db.conn_mut(),&id,&payment(25000,1234)).unwrap();
 check("debts/overpayment rejected",1,debts::pay(db.conn_mut(),&id,&payment(75001,0)).is_err() as i64);
 let c=db.conn();
 post(c,"transfer","2026-03-02",&card,80000,None,Some((&broker,80000)),"Взнос");
 invest::set_value(c,&broker,"2026-03-04",92222).unwrap(); invest::set_value(c,&broker,"2026-04-04",110000).unwrap();
 invest::set_month_plan(c,"2026-03","amount",100000,Some("RUB")).unwrap();
 let asset=assets::create(c,&assets::AssetInput{name:"Велосипед".into(),kind:"vehicle".into(),currency_code:"RUB".into(),value:70000,date:"2026-01-02".into(),note:None}).unwrap();
 assets::set_value(c,&asset,"2026-02-02",77111).unwrap();assets::set_value(c,&asset,"2026-04-02",90000).unwrap();
 for date in ["2026-01-15","2026-02-15","2026-03-15"]{post(c,"expense",date,&card,2345,Some(&food),None,"Ежемесячный сервис");}
 let g=goals::create(c,&goals::GoalInput{name:"Резерв".into(),currency_code:"RUB".into(),target:40000,account_id:Some(card.clone()),reserve:true,deadline:None}).unwrap();
 goals::deposit(c,&g,"2026-03-05",10000).unwrap();
 let end="2026-03-30";
 let goals=goals::list(c,end).unwrap();let goal=&goals[0];
 check("goals/saved",10000,goal.saved);check("goals/remaining",30000,goal.remaining);check("goals/percent",25,goal.percent as i64);
 let rows=subscriptions::list(c,end).unwrap();check("subscriptions/yearly",12*2345,rows.yearly_total);check("subscriptions/monthly",2345,rows.monthly_total);
 let card_value=1_000_000+100_000-25_000-1234-80000-3*2345;
 check("balances/actual cash",card_value,accounts::balance(c,&card,Some(end)).unwrap());
 let info=debts::get(c,&id,end).unwrap();check("debts/outstanding",75000,info.card.outstanding);
 let bs=reports::by_month(c,"2026-03","2026-03").unwrap();check("reports/net interest plus subscription",1234+2345,bs.expense);check("reports/principal excluded from income",0,bs.income);
 let nw=net_worth::on_date(c,end,&mut vec![]).unwrap();
 check("positions/rubles",card_value,nw.cash);check("positions/latest investment valuation",92222,nw.investments);check("positions/latest asset valuation",77111,nw.assets);check("positions/outstanding debts",75000,nw.i_owe);
 check("positions/net worth",card_value+92222+77111-75000,nw.net);
 let p=invest::month_progress(c,"2026-03").unwrap();check("invest/plan",100000,p.planned.unwrap());check("invest/saved",80000,p.saved);check("invest/plan percent",80,p.percent.unwrap());
 let i=invest::overview(c,end).unwrap();check("invest/result",12222,i.result);check("invest/value",92222,i.value);check("invest/contributions",80000,i.invested);
}
#[test]
fn fixed_forecast_and_currency_edges(){
 let db=Storage::open_in_memory().unwrap();let c=db.conn();
 account(c,"Начало","debit","RUB",750000);let start="2026-11-15";
 let id=forecast::create(c,&forecast::ScenarioInput{name:"Отдельный сценарий".into(),changes:vec![
 forecast::ChangeInput{kind:"once".into(),title:"Покупка".into(),amount:Some(-12345),start_month:"2026-12".into(),..Default::default()},
 forecast::ChangeInput{kind:"monthly".into(),title:"Пополнение".into(),amount:Some(1111),start_month:"2027-01".into(),months:Some(3),..Default::default()}]}).unwrap();
 let data=forecast::forecast(c,start,Some(&id)).unwrap();
 for (i,m) in data.months.iter().enumerate(){let paid:i64=if i>=1 {12345}else{0};let installments=(i as i64-1).clamp(0,3);
 check(&format!("forecast/{} baseline",m.month),750000,m.closing);
 check(&format!("forecast/{} scenario",m.month),750000-paid+1111*installments,m.scenario.as_ref().unwrap().closing);}
 currencies::set_rate(c,"2026-02-02","USD","RUB","90.125").unwrap();
 for (n,want) in [(1,90),(4,361),(12,1082),(-4,-361),(0,0),(101,9103)] {check(&format!("FX/half-away/{n}"),want,currencies::convert(c,n,"USD","RUB","2026-02-02").unwrap().unwrap());}
 check("FX/missing historical rate",1,currencies::convert(c,101,"USD","RUB","2026-02-01").unwrap().is_none() as i64);
}

#[test]
fn available_money_budget_and_nonfinancial_screens() {
 let mut db=Storage::open_in_memory().unwrap();let c=db.conn();categories::seed_defaults(c).unwrap();
 let card=account(c,"Карта","debit","RUB",234567);let food=cat(c,"Питание");let inc=cat(c,"Прочие доходы");
 let spent=post(c,"expense","2026-11-01",&card,7312,Some(&food),None,"Магазин");
 let p=post(c,"expense","2026-11-19",&card,15000,Some(&food),None,"Будущий платёж");
 let salary=post(c,"income","2026-11-23",&card,50000,Some(&inc),None,"Будущий доход");
 for id in [&p,&salary]{c.execute("UPDATE transactions SET status='planned' WHERE id=?1",[id]).unwrap();}
 let id=goals::create(c,&goals::GoalInput{name:"Резерв".into(),target:10000,currency_code:"RUB".into(),account_id:Some(card.clone()),deadline:None,reserve:true}).unwrap();
 goals::deposit(c,&id,"2026-11-01",7011).unwrap();
 let budget=budgets::create(db.conn_mut(),"2026-11",false).unwrap();let c=db.conn();budgets::set_limit(c,&budget,&food,Some(55000)).unwrap();
 let b=budgets::get(c,"2026-11","2026-11-15").unwrap();let line=b.lines.iter().find(|l|l.category_id==food).unwrap();
 check("budget/food limit",55000,line.limit);check("budget/food actual excluding planned outflow",7312,line.actual);check("budget/food remaining",47688,line.remaining);
 check("budget/available per day incl today",47688/16,b.safe_to_spend_today.unwrap());
 let f=budget_core::free_money::until_income(c,"2026-11-15").unwrap();
 check("free/balance before pending payments",227255,f.liquid);check("free/known spending before salary",15000,f.payments_total);check("free/reserved",7011,f.reserved_total);
 check("free/days before salary",8,f.days);check("free/after planned spending and reserve",205244,f.free);check("free/daily",205244/8,f.per_day);
 // The Calendar labels its plan as open debt payments and priced reminders.
 // Give the reminders different amounts from the standalone planned postings.
 for (kind,when,amount,category) in [("income","2026-11-24T13:00",46543,&inc),("expense","2026-11-25T13:00",21234,&food)] {
    let reminder=budget_core::reminders::ReminderInput {
        title:format!("План {kind}"),start_at:when.into(),repeat:"once".into(),
        amount:Some(amount),txn_type:Some(kind.into()),account_id:Some(card.clone()),
        category_id:Some(category.clone()),..Default::default()
    };
    budget_core::reminders::create(c,&reminder).unwrap();
 }
 let month=calendar::month(c,"2026-11","2026-11-15").unwrap();check("calendar/planned income from reminders",46543,month.planned_income);check("calendar/planned expense from reminders",21234,month.planned_expense);check("calendar/factual expense",7312,month.expense);
 let n=budget_core::notes::create(c,&budget_core::notes::NoteInput{body:"Числовой контроль".into(),date:Some("2026-11-15".into()),transaction_id:Some(spent),..Default::default()}).unwrap();
 check("notes/linked entry present",1,budget_core::notes::list(c,&Default::default()).unwrap().iter().filter(|x|x.id==n).count() as i64);
 settings::set(c,"home_layout",r#"{"v":3,"preset":"overview"}"#).unwrap();
 check("settings and notes/no monetary journal mutation",227255,accounts::balance(c,&card,None).unwrap());
}
#[test]
fn three_payment_amortization_by_hand() {
 // Differential 12% yearly, three monthly periods. Principal 100001 cents:
 // Two equal principal payments round to 33334, followed by a residual of 33333.
 // Independently recompute each interest from outstanding, payment identity,
 // and final closure; annuity expects rounded scheduled payment from formula.
 for model in ["annuity","differentiated"] {
   let mut db=Storage::open_in_memory().unwrap();categories::seed_defaults(db.conn()).unwrap();
   let loan:debts::DebtInput=serde_json::from_value(json!({"direction":"borrowed","counterparty":"Тест","currencyCode":"RUB","principal":100001,"issueDate":"2026-01-01","rateBp":1200,"repaymentType":model,"termMonths":3,"firstPaymentDate":"2026-02-01","interestMethod":"monthly"})).unwrap();
   let id=debts::create(db.conn_mut(),&loan).unwrap();let dd=debts::get(db.conn(),&id,"2026-01-01").unwrap();check(&format!("loan/{model}/rows"),3,dd.schedule.len() as i64);
   let mut balance=100001;let r=1.01f64;let std_payment=(100001f64*0.01/(1.0-r.powi(-3))).round() as i64;
   for (ix,row) in dd.schedule.iter().enumerate(){
      let interest=(balance+50)/100;check(&format!("loan/{model}/{ix}/interest"),interest,row.interest_part);
      let principal=if ix==2{balance}else if model=="annuity"{std_payment-interest}else{33334};
      check(&format!("loan/{model}/{ix}/principal"),principal,row.principal_part);
      check(&format!("loan/{model}/{ix}/payment"),principal+interest,row.payment);
      balance-=principal;check(&format!("loan/{model}/{ix}/closing"),balance,row.balance_after);
   }
 }
}
