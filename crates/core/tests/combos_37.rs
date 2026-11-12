//! Тред 37: сочетания новых функций после 0.31.
//!
//! Готовые фильтры «Операций» (Р3) вместе с тегом (и возвратом покупки с тегом),
//! счётом, «Крупными» и «Той же суммой» (Р5): каждый набор — пересечение
//! отдельных фильтров, а список, выгрузка и счётчик совпадают.
//! «Как быстрее расплатиться» (Р17): долг без курса не входит, долг, который
//! не закрывается, остаётся в списке без месяца.

use std::collections::BTreeSet;

use budget_core::accounts::{self, AccountInput};
use budget_core::debts::{self, DebtInput};
use budget_core::receipts::{self, PartInput, ReceiptInput};
use budget_core::refunds::{self, RefundInput};
use budget_core::storage::Storage;
use budget_core::transactions::{self, Filter, TxnInput};
use budget_core::{categories, currencies, payoff, tags};
use rusqlite::Connection;

fn acc(c: &Connection, name: &str, cur: &str) -> String {
    accounts::create(
        c,
        &AccountInput {
            name: name.into(),
            kind: "debit".into(),
            currency_code: cur.into(),
            opening_balance: 100_000_000,
            opening_date: "2026-01-01".into(),
            credit_limit: None,
            include_in_total: true,
            invest_kind: None,
        },
    )
    .unwrap()
}

fn cat(c: &Connection, name: &str) -> String {
    c.query_row("SELECT id FROM categories WHERE name = ?1", [name], |r| {
        r.get(0)
    })
    .unwrap()
}

#[allow(clippy::too_many_arguments)]
fn txn(
    c: &Connection,
    kind: &str,
    acc: &str,
    date: &str,
    amount: i64,
    cat: Option<&str>,
    payee: Option<&str>,
    note: Option<&str>,
) -> String {
    transactions::create(
        c,
        &TxnInput {
            kind: kind.into(),
            date: date.into(),
            account_id: acc.into(),
            amount,
            category_id: cat.map(Into::into),
            to_account_id: None,
            to_amount: None,
            payee: payee.map(Into::into),
            note: note.map(Into::into),
        },
    )
    .unwrap()
}

struct World {
    db: Storage,
    card: String,
    tag: String,
}

/// Повторяющийся получатель, траты в «Прочих», валютные, с заметками,
/// чек с тегом и покупка с тегом, возвращённая в другом месяце.
fn world() -> World {
    let mut db = Storage::open_in_memory().unwrap();
    let c = db.conn();
    categories::seed_defaults(c).unwrap();
    currencies::set_rate(c, "2026-01-01", "USD", "RUB", "90").unwrap();
    let card = acc(c, "Карта", "RUB");
    let usd = acc(c, "Доллары", "USD");
    let food = cat(c, "Питание");
    let other = cat(c, "Прочие расходы");
    for m in ["07", "08", "09", "10"] {
        txn(
            c,
            "expense",
            &card,
            &format!("2026-{m}-05"),
            99_000,
            Some(&food),
            Some("Связь"),
            None,
        );
    }
    txn(
        c,
        "expense",
        &card,
        "2026-10-06",
        2_500_000,
        Some(&other),
        Some("Мебель"),
        Some("диван"),
    );
    txn(
        c,
        "expense",
        &usd,
        "2026-10-07",
        15_000,
        Some(&other),
        None,
        None,
    );
    txn(
        c,
        "expense",
        &usd,
        "2026-10-08",
        990,
        Some(&food),
        Some(" связь "),
        Some("роуминг"),
    );
    txn(
        c,
        "income",
        &card,
        "2026-10-09",
        5_000_000,
        Some(&cat(c, "Прочие доходы")),
        None,
        None,
    );
    receipts::create(
        db.conn_mut(),
        &ReceiptInput {
            date: "2026-10-12".into(),
            account_id: card.clone(),
            payee: Some("Ашан".into()),
            note: Some("дача".into()),
            total: 1_200_000,
            parts: vec![
                PartInput {
                    category_id: food.clone(),
                    amount: 200_000,
                    note: None,
                },
                PartInput {
                    category_id: other.clone(),
                    amount: 1_000_000,
                    note: None,
                },
            ],
            tags: vec!["дача".into()],
            event_id: None,
        },
    )
    .unwrap();
    let c = db.conn();
    let mower = txn(
        c,
        "expense",
        &card,
        "2026-09-15",
        3_000_000,
        Some(&cat(c, "Жильё")),
        Some("Газонокосилки"),
        None,
    );
    tags::set_for(c, &mower, &["дача".to_string()]).unwrap();
    // Вернули в октябре, в октябре же и считается.
    refunds::create(
        c,
        &RefundInput {
            of: mower,
            date: "2026-10-20".into(),
            account_id: None,
            amount: 3_000_000,
            in_purchase_month: false,
            note: None,
        },
    )
    .unwrap();
    let tag: String = c
        .query_row("SELECT id FROM tags WHERE name = 'дача'", [], |r| {
            r.get(0)
        })
        .unwrap();
    World { db, card, tag }
}

fn ids(c: &Connection, f: &Filter) -> BTreeSet<String> {
    let page = transactions::list(
        c,
        &Filter {
            limit: Some(5000),
            ..f.clone()
        },
    )
    .unwrap();
    let all = transactions::list_all(c, f).unwrap();
    assert_eq!(page.total as usize, page.items.len(), "{f:?}");
    assert_eq!(page.total as usize, all.len(), "выгрузка = список: {f:?}");
    page.items.into_iter().map(|t| t.id).collect()
}

#[test]
fn quick_filters_intersect_with_every_other_filter() {
    let w = world();
    let c = w.db.conn();
    let quick = ["uncategorized", "recurring", "note", "foreign"];
    // Дополнительные отборы: тег (с возвратом), счёт, «Крупные» от 10 000 ₽, та же сумма.
    let extras: Vec<(&str, Filter)> = vec![
        ("ничего", Filter::default()),
        (
            "тег",
            Filter {
                tag_id: Some(w.tag.clone()),
                ..Default::default()
            },
        ),
        (
            "счёт",
            Filter {
                account_id: Some(w.card.clone()),
                ..Default::default()
            },
        ),
        (
            "крупные",
            Filter {
                min_amount: Some(1_000_000),
                ..Default::default()
            },
        ),
        (
            "сумма",
            Filter {
                amount: Some(99_000),
                currency: Some("RUB".into()),
                ..Default::default()
            },
        ),
        (
            "октябрь",
            Filter {
                date_from: Some("2026-10-01".into()),
                date_to: Some("2026-10-31".into()),
                ..Default::default()
            },
        ),
    ];
    for (name, extra) in &extras {
        let base = ids(c, extra);
        let single: Vec<BTreeSet<String>> = quick
            .iter()
            .map(|q| {
                ids(
                    c,
                    &Filter {
                        quick: vec![q.to_string()],
                        ..extra.clone()
                    },
                )
            })
            .collect();
        for s in &single {
            assert!(s.is_subset(&base), "{name}");
        }
        // Все пары и все четыре сразу — пересечение по отдельности.
        for mask in 1u32..16 {
            let chosen: Vec<usize> = (0..4).filter(|i| mask & (1 << i) != 0).collect();
            let got = ids(
                c,
                &Filter {
                    quick: chosen.iter().map(|i| quick[*i].to_string()).collect(),
                    ..extra.clone()
                },
            );
            let want = chosen
                .iter()
                .fold(base.clone(), |acc, i| &acc & &single[*i]);
            assert_eq!(got, want, "{name}: {chosen:?}");
        }
    }
    let count = |f: Filter| ids(c, &f).len();
    // «Связь» в четырёх месяцах (и « связь » на долларовом счёте) — повторяющийся.
    assert_eq!(
        count(Filter {
            quick: vec!["recurring".into()],
            ..Default::default()
        }),
        5
    );
    // Без категории: диван, трата в долларах, доход в «Прочих», часть чека.
    assert_eq!(
        count(Filter {
            quick: vec!["uncategorized".into()],
            ..Default::default()
        }),
        4
    );
    // С тегом: две части чека, газонокосилка и её возврат.
    assert_eq!(
        count(Filter {
            tag_id: Some(w.tag.clone()),
            ..Default::default()
        }),
        4
    );
    // Крупные от 10 000 ₽: 150 $ = 13 500 ₽, диван, доход, часть чека, газонокосилка и возврат.
    assert_eq!(
        count(Filter {
            min_amount: Some(1_000_000),
            ..Default::default()
        }),
        6
    );
}

fn borrow(c: &mut Storage, name: &str, cur: &str, principal: i64, rate: i64) {
    debts::create(
        c.conn_mut(),
        &DebtInput {
            direction: "borrowed".into(),
            counterparty: name.into(),
            note: None,
            currency_code: cur.into(),
            principal,
            issue_date: "2026-10-01".into(),
            rate_bp: rate,
            repayment_type: "annuity".into(),
            term_months: Some(12),
            first_payment_date: None,
            maturity_date: None,
            account_id: None,
            interest_method: None,
            rate_period: None,
            pay_every: None,
            rate_changes: vec![],
            planned_early: vec![],
        },
    )
    .unwrap();
}

#[test]
fn payoff_without_rate_leaves_debt_out_and_says_so() {
    let mut db = Storage::open_in_memory().unwrap();
    categories::seed_defaults(db.conn()).unwrap();
    borrow(&mut db, "Банк", "RUB", 12_000_000, 1500);
    borrow(&mut db, "Друг в Казахстане", "KZT", 50_000_000, 0);
    let p = payoff::for_debts(db.conn(), "2026-10-20", 500_000, "costly").unwrap();
    assert_eq!(p.missing_rates, ["KZT"]);
    let names: Vec<&str> = p.order.iter().map(|o| o.name.as_str()).collect();
    assert_eq!(names, ["Банк"]);
    assert!(p.order[0].month.is_some());
    // С курсом долг входит, и оба закрываются.
    currencies::set_rate(db.conn(), "2026-10-01", "KZT", "RUB", "0.2").unwrap();
    let p = payoff::for_debts(db.conn(), "2026-10-20", 500_000, "costly").unwrap();
    assert!(p.missing_rates.is_empty());
    assert_eq!(p.order.len(), 2);
    assert!(p.order.iter().all(|o| o.month.is_some()));
    assert!(p.free_month.is_some());
}
