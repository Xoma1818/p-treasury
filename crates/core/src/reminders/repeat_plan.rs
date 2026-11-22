use super::{create, get, parse_dt, Reminder, ReminderInput, Repeat};
use crate::{currencies, error::invalid, time, Result};
use chrono::{NaiveDate, NaiveDateTime};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

/// Созданная из операции серия либо серия, очередной платёж которой уже
/// учтён этой операцией. Утратившая силу привязка из выписки не учитывается.
fn existing(conn: &Connection, source_id: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "WITH linked AS (
                 SELECT o.reminder_id FROM reminder_occurrences o
                 JOIN reminders r ON r.id = o.reminder_id
                 WHERE o.transaction_id = ?1 AND o.source = 'reminder' AND o.status = 'done'
                   AND (r.repeat <> 'once' OR r.amount_currency IS NOT NULL)
                   AND (o.linked_actual_amount IS NULL OR EXISTS
                     (SELECT 1 FROM valid_reminder_actual_links v WHERE v.occurrence_id = o.id))
             ), matching(series_id, from_source) AS (
                 SELECT DISTINCT series_id, 1 FROM reminder_plan_sources WHERE transaction_id = ?1
                 UNION ALL SELECT s.series_id, 0 FROM reminder_plan_sources s JOIN linked l USING (reminder_id)
             ), candidates AS (
                 SELECT s.reminder_id, m.from_source, s.is_current AS priority, r.start_at
                 FROM matching m JOIN reminder_plan_sources s USING (series_id)
                 JOIN reminders r ON r.id = s.reminder_id
                 UNION ALL SELECT reminder_id, 0, -1, '' FROM linked
             )
             SELECT reminder_id FROM candidates ORDER BY from_source DESC, priority DESC, start_at DESC, reminder_id LIMIT 1",
            [source_id],
            |r| r.get(0),
        )
        .optional()?)
}

pub(super) fn is_source(
    conn: &Connection,
    reminder_id: &str,
    transaction_id: &str,
) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM reminder_plan_sources WHERE transaction_id = ?1 AND reminder_id = ?2)",
        params![transaction_id, reminder_id],
        |r| r.get(0),
    )?)
}

struct Source {
    date: String,
    kind: String,
    account: String,
    category: String,
    amount: i64,
    currency: String,
}

fn source(conn: &Connection, id: &str) -> Result<Source> {
    let row = conn
        .query_row(
            "SELECT t.date, t.type, t.account_id, t.category_id, t.amount, a.currency_code
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         JOIN categories c ON c.id = t.category_id
         LEFT JOIN categories parent ON parent.id = c.parent_id
         WHERE t.id = ?1 AND t.status = 'cleared' AND t.type IN ('income', 'expense')
           AND t.amount > 0 AND t.debt_id IS NULL AND t.split_id IS NULL AND t.refund = 0
           AND t.spread_months IS NULL AND t.event_id IS NULL
           AND t.recurring_rule_id IS NULL AND a.type NOT IN ('debt', 'investment')
           AND c.kind = t.type AND a.archived_at IS NULL AND c.archived_at IS NULL
           AND parent.archived_at IS NULL",
            [id],
            |r| {
                let source = Source {
                    date: r.get(0)?,
                    kind: r.get(1)?,
                    account: r.get(2)?,
                    category: r.get(3)?,
                    amount: r.get(4)?,
                    currency: r.get(5)?,
                };
                Ok(source)
            },
        )
        .optional()?;
    let Some(source) = row else {
        return invalid("для повтора нужна проведённая разовая операция с открытым счётом и действующей категорией");
    };
    let base = currencies::base_currency(conn)?;
    if source.currency != base {
        return invalid(format!(
            "для повтора выберите платёж в основной валюте ({base})"
        ));
    }
    Ok(source)
}

pub fn get_repeat_plan(
    conn: &Connection,
    source_id: &str,
    now: NaiveDateTime,
) -> Result<Option<Reminder>> {
    if let Some(id) = existing(conn, source_id)? {
        return Ok(Some(get(conn, &id, now)?));
    }
    source(conn, source_id)?;
    Ok(None)
}

pub fn create_repeat_plan(
    conn: &mut Connection,
    source_id: &str,
    input: &ReminderInput,
    today: NaiveDate,
) -> Result<String> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if let Some(id) = existing(&tx, source_id)? {
        tx.commit()?;
        return Ok(id);
    }
    let source = source(&tx, source_id)?;
    if input.amount != Some(source.amount)
        || input.txn_type.as_deref() != Some(source.kind.as_str())
        || input.account_id.as_deref() != Some(source.account.as_str())
        || input.category_id.as_deref() != Some(source.category.as_str())
    {
        return invalid("исходная операция изменилась. Откройте её снова и проверьте реквизиты");
    }
    let start = parse_dt(&input.start_at)?.date();
    if start <= today || start <= time::parse_date(&source.date)? {
        return invalid("выберите будущую дату после исходной операции");
    }
    if Repeat::parse(&input.repeat)? == Repeat::Once {
        return invalid("выберите период повтора");
    }
    if input.count.is_some_and(|n| !(1..=600).contains(&n)) {
        return invalid("повторить можно от 1 до 600 раз");
    }
    if input.event_id.is_some() || input.note_id.is_some() {
        return invalid("повтор операции создаётся отдельно от события и заметки");
    }
    let id = create(&tx, input)?;
    tx.execute(
        "UPDATE reminders SET amount_currency = ?2 WHERE id = ?1",
        params![id, source.currency],
    )?;
    tx.execute(
        "INSERT INTO reminder_plan_sources (transaction_id, reminder_id, series_id, is_current)
         VALUES (?1, ?2, ?2, 1)",
        params![source_id, id],
    )?;
    tx.commit()?;
    Ok(id)
}

/// При правке «этот и следующие» источник относится ко всей цепочке.
/// Только актуальное продолжение открывается из исходной операции.
pub(super) fn inherit_segment(conn: &Connection, previous: &str, next: &str) -> Result<()> {
    let current: Option<bool> = conn
        .query_row(
            "SELECT is_current FROM reminder_plan_sources WHERE reminder_id = ?1",
            [previous],
            |r| r.get(0),
        )
        .optional()?;
    let Some(current) = current else {
        return Ok(());
    };
    conn.execute(
        "UPDATE reminder_plan_sources SET is_current = 0 WHERE reminder_id = ?1",
        [previous],
    )?;
    conn.execute(
        "INSERT INTO reminder_plan_sources (reminder_id, series_id, transaction_id, is_current)
         SELECT ?2, series_id, transaction_id, ?3 FROM reminder_plan_sources WHERE reminder_id = ?1",
        params![previous, next, current],
    )?;
    conn.execute(
        "UPDATE reminders SET amount_currency = (SELECT amount_currency FROM reminders WHERE id = ?1)
         WHERE id = ?2",
        params![previous, next],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{accounts, categories, reminders, storage::Storage, transactions, undo::Journal};

    fn fixture(
        conn: &Connection,
        currency: &str,
        kind: &str,
        amount: i64,
    ) -> (String, ReminderInput) {
        let card = accounts::create(
            conn,
            &accounts::tests::input("Карта", "debit", currency, 400_000),
        )
        .unwrap();
        categories::seed_defaults(conn).unwrap();
        let category: String = conn
            .query_row(
                "SELECT id FROM categories WHERE kind = ?1 LIMIT 1",
                [kind],
                |r| r.get(0),
            )
            .unwrap();
        let payment = transactions::TxnInput {
            account_id: card.clone(),
            amount,
            kind: kind.into(),
            category_id: Some(category.clone()),
            to_account_id: None,
            to_amount: None,
            date: "2026-10-19".into(),
            payee: Some("Аванс".into()),
            note: None,
        };
        let id = transactions::create(conn, &payment).unwrap();
        let input = ReminderInput {
            title: "Аванс".into(),
            repeat: "monthly".into(),
            start_at: "2026-10-20T09:00".into(),
            amount: Some(payment.amount),
            txn_type: Some(payment.kind),
            category_id: Some(category),
            account_id: Some(card),
            ..Default::default()
        };
        (id, input)
    }

    #[test]
    fn repeat_source_stays_paid_and_does_not_match_first_future_occurrence() {
        let mut db = Storage::open_in_memory().unwrap();
        let c = db.conn_mut();
        let (source, input) = fixture(c, "RUB", "income", 10_501);
        let now = parse_dt("2026-10-19T12:00").unwrap();
        let balance = |c: &Connection| {
            accounts::balance(c, input.account_id.as_ref().unwrap(), None).unwrap()
        };
        let mut journal = Journal::default();
        let id = journal
            .record(c, "Повтор", |c| {
                create_repeat_plan(c, &source, &input, now.date())
            })
            .unwrap();
        let plan = get_repeat_plan(c, &source, now).unwrap().unwrap();
        assert_eq!(plan.amount, Some(10_501));
        assert_eq!(plan.txn_type.as_deref(), Some("income"));
        assert_eq!(balance(c), 410_501);
        let key = reminders::Key {
            source: "reminder".into(),
            ref_id: id.clone(),
            scheduled_at: input.start_at.clone(),
        };
        let review = reminders::payment_review(c, &key, "2026-10-20").unwrap();
        assert!(review.candidates.is_empty());
        assert!(
            reminders::attach_payment(c, &key, &source, &review.revision, "2026-10-20").is_err()
        );
        assert!(reminders::complete(c, &key, Some(&source)).is_err());
        let state = journal.state().undo;
        journal
            .record(c, "Повтор ещё раз", |c| {
                create_repeat_plan(c, &source, &input, now.date())
            })
            .unwrap();
        assert_eq!(journal.state().undo, state);
        journal.undo(c).unwrap();
        assert!(get_repeat_plan(c, &source, now).unwrap().is_none());
        assert_eq!(balance(c), 410_501);
        journal.redo(c).unwrap();
        assert_eq!(get_repeat_plan(c, &source, now).unwrap().unwrap().id, id);

        journal
            .record(c, "Удаление операции", |c| {
                transactions::delete(c, &source)
            })
            .unwrap();
        assert!(get_repeat_plan(c, &source, now).is_err());
        assert!(reminders::get(c, &id, now).is_ok());
        assert_eq!(balance(c), 400_000);
        journal.undo(c).unwrap();
        assert_eq!(get_repeat_plan(c, &source, now).unwrap().unwrap().id, id);
        journal
            .record(c, "Удаление серии", |c| {
                reminders::delete(c, &id)
            })
            .unwrap();
        assert!(get_repeat_plan(c, &source, now).unwrap().is_none());
        assert_eq!(balance(c), 410_501);
        journal.undo(c).unwrap();
        assert!(is_source(c, &id, &source).unwrap());

        // Ошибка после записи факта из уведомления откатывает и сам факт.
        c.execute_batch(
            "CREATE TEMP TRIGGER fail_mark BEFORE INSERT ON reminder_occurrences
                         BEGIN SELECT RAISE(ABORT,'ошибка отметки'); END",
        )
        .unwrap();
        assert!(reminders::pay(c, &key, "2026-10-20").is_err());
        assert_eq!(balance(c), 410_501);
    }

    #[test]
    fn repeat_requires_eligible_source_exact_money_and_future_schedule() {
        let now = parse_dt("2026-10-19T12:00").unwrap();
        let mut db = Storage::open_in_memory().unwrap();
        let c = db.conn_mut();
        let (source, input) = fixture(c, "RUB", "income", 10_501);
        for bad in [
            ReminderInput {
                repeat: "once".into(),
                ..input.clone()
            },
            ReminderInput {
                start_at: "2026-10-19T22:00".into(),
                ..input.clone()
            },
            ReminderInput {
                amount: Some(10_500),
                ..input.clone()
            },
            ReminderInput {
                txn_type: Some("expense".into()),
                ..input.clone()
            },
        ] {
            assert!(create_repeat_plan(c, &source, &bad, now.date()).is_err());
        }
        for update in [
            "UPDATE transactions SET status = 'planned'",
            "UPDATE transactions SET split_id = 'receipt'",
            "UPDATE transactions SET spread_months = 3",
            "UPDATE transactions SET refund = 1",
            "UPDATE categories SET archived_at = 'yesterday'",
            "UPDATE accounts SET archived_at = 'yesterday'",
            "UPDATE accounts SET type = 'investment'",
        ] {
            c.execute_batch("SAVEPOINT fixture").unwrap();
            c.execute_batch(update).unwrap();
            assert!(get_repeat_plan(c, &source, now).is_err(), "{update}");
            c.execute_batch("ROLLBACK TO fixture; RELEASE fixture")
                .unwrap();
        }
        let (foreign, input) = fixture(c, "USD", "income", 10_501);
        assert!(create_repeat_plan(c, &foreign, &input, now.date()).is_err());
        assert!(reminders::list(c, now).unwrap().is_empty());
    }

    #[test]
    fn repeat_keeps_rubles_after_base_change_source_deletion_and_split() {
        let mut db = Storage::open_in_memory().unwrap();
        let c = db.conn_mut();
        let (source, mut input) = fixture(c, "RUB", "expense", 1_000_000);
        let account = input.account_id.clone().unwrap();
        let now = parse_dt("2026-10-19T12:00").unwrap();
        let id = create_repeat_plan(c, &source, &input, now.date()).unwrap();
        let key = reminders::Key {
            source: "reminder".into(),
            ref_id: id.clone(),
            scheduled_at: input.start_at.clone(),
        };
        crate::settings::set(c, "base_currency", "USD").unwrap();
        let occurrence = reminders::occurrence(c, &key).unwrap();
        assert_eq!(
            (
                occurrence.amount_currency.as_str(),
                occurrence.amount,
                occurrence.minor_units
            ),
            ("RUB", Some(1_000_000), 2)
        );
        let calendar = crate::calendar::month(c, "2026-10", "2026-10-19").unwrap();
        assert_eq!(calendar.planned_expense, 0);
        assert_eq!(calendar.missing_rates, ["RUB"]);

        currencies::set_rate(c, "2026-10-19", "USD", "RUB", "90").unwrap();
        let calendar = crate::calendar::month(c, "2026-10", "2026-10-19").unwrap();
        assert_eq!(calendar.planned_expense, 11_111); // 111,11 USD
        let projection = crate::forecast::known_items(
            c,
            "USD",
            "2026-10-19",
            "2026-10-21",
            &Default::default(),
            &mut Vec::new(),
        )
        .unwrap();
        assert_eq!(projection[0].amount, -11_111);
        assert_eq!(
            reminders::shortfalls(c, now, 3).unwrap().get(&key),
            Some(&1_000_000)
        );
        let actual = transactions::create(
            c,
            &transactions::TxnInput {
                kind: "expense".into(),
                date: "2026-10-20".into(),
                account_id: account.clone(),
                amount: 1_000_000,
                category_id: input.category_id.clone(),
                payee: Some(input.title.clone()),
                to_account_id: None,
                to_amount: None,
                note: None,
            },
        )
        .unwrap();
        let review = reminders::payment_review(c, &key, "2026-10-20").unwrap();
        assert_eq!(review.candidates.len(), 1);
        assert_eq!(review.candidates[0].expected_amount, 1_000_000);
        reminders::attach_payment(c, &key, &actual, &review.revision, "2026-10-20").unwrap();

        input.title = "Следующий платёж".into();
        reminders::update(c, &id, &input).unwrap();
        let next_at = "2026-11-20T09:00";
        let next_key = reminders::Key {
            scheduled_at: next_at.into(),
            ..key.clone()
        };
        input.start_at = next_at.into();
        let mut journal = Journal::default();
        let next_id = journal
            .record(c, "Продолжение", |c| {
                reminders::split_from(c, &next_key, &input)
            })
            .unwrap();
        assert_ne!(id, next_id);
        journal.undo(c).unwrap();
        assert_eq!(get_repeat_plan(c, &source, now).unwrap().unwrap().id, id);
        journal.redo(c).unwrap();
        for from in [&source, &actual] {
            let r = get_repeat_plan(c, from, now).unwrap().unwrap();
            assert_eq!(
                (r.id.as_str(), r.amount_currency.as_str()),
                (next_id.as_str(), "RUB")
            );
        }
        assert!(is_source(c, &id, &source).unwrap());
        assert!(is_source(c, &next_id, &source).unwrap());
        transactions::delete(c, &source).unwrap();
        assert_eq!(
            get_repeat_plan(c, &actual, now).unwrap().unwrap().id,
            next_id
        );
        let key = reminders::Key {
            ref_id: next_id,
            ..next_key
        };
        let before = accounts::balance(c, &account, None).unwrap();
        let result = reminders::pay(c, &key, "2026-11-20").unwrap();
        let reminders::Paid::Transaction(id) = &result else {
            panic!("ожидалась операция")
        };
        assert_eq!(transactions::get(c, id).unwrap().amount, 1_000_000);
        assert_eq!(reminders::pay(c, &key, "2026-11-20").unwrap(), result);
        assert_eq!(
            before - accounts::balance(c, &account, None).unwrap(),
            1_000_000
        );
    }
}
