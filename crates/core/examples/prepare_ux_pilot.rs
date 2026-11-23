//! Подготовка отдельного учебного профиля для встречи по протоколу 0.41.

use std::error::Error;
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use budget_core::accounts::{self, AccountInput};
use budget_core::onboarding::{self, Setup};
use budget_core::storage::{self, Storage};
use budget_core::transactions::{self, TxnInput};
use budget_core::{budgets, categories, settings, time};
use chrono::{Days, NaiveDate};

type Result<T> = std::result::Result<T, Box<dyn Error>>;
const USAGE: &str = "Запуск: prepare_ux_pilot <rent|budget> <новая папка профиля> [YYYY-MM-DD]";

#[derive(Clone, Copy)]
enum Scenario {
    Rent,
    Budget,
}

fn seed(scenario: Scenario, today: NaiveDate) -> Result<Storage> {
    let mut db = Storage::open_in_memory()?;
    let openings: &[(&str, &str, i64)] = match scenario {
        Scenario::Rent => &[("Карта", "debit", 4_000_000)],
        Scenario::Budget => &[("Карта", "debit", 2_600_000), ("Наличные", "cash", 600_000)],
    };
    let opening_date = (today - Days::new(60)).to_string();
    onboarding::finish(
        db.conn_mut(),
        &Setup {
            base_currency: "RUB".into(),
            default_categories: true,
            accounts: openings
                .iter()
                .map(|&(name, kind, opening_balance)| AccountInput {
                    name: name.into(),
                    kind: kind.into(),
                    currency_code: "RUB".into(),
                    opening_balance,
                    opening_date: opening_date.clone(),
                    credit_limit: None,
                    include_in_total: true,
                    invest_kind: None,
                })
                .collect(),
        },
    )?;
    settings::set(db.conn(), "home_layout", r#"{"order":[],"hidden":[]}"#)?;

    let accounts = accounts::list(db.conn(), false)?;
    let categories = categories::list(db.conn(), false)?;
    let expense = |conn: &budget_core::Connection,
                   account: &str,
                   category_id: &str,
                   date: NaiveDate,
                   amount: i64,
                   payee: &str|
     -> Result<()> {
        let account = accounts
            .iter()
            .find(|a| a.name == account)
            .ok_or_else(|| format!("Не найден учебный счёт «{account}»"))?;
        transactions::create(
            conn,
            &TxnInput {
                kind: "expense".into(),
                date: date.to_string(),
                account_id: account.id.clone(),
                amount,
                category_id: Some(category_id.into()),
                to_account_id: None,
                to_amount: None,
                payee: Some(payee.into()),
                note: None,
            },
        )?;
        Ok(())
    };
    let category_id = |name: &str| {
        categories
            .iter()
            .find(|c| c.name == name && c.kind == "expense")
            .map(|c| c.id.as_str())
            .ok_or_else(|| format!("Не найдена учебная категория «{name}»"))
    };
    match scenario {
        Scenario::Rent => expense(
            db.conn(),
            "Карта",
            category_id("Аренда")?,
            today - Days::new(28),
            1_000_000,
            "Аренда",
        )?,
        Scenario::Budget => {
            let period = budgets::month_of(db.conn(), &today.to_string())?;
            let budget = budgets::create(db.conn_mut(), &period.month, false)?;
            for (category, limit, account, amount, payee) in [
                ("Питание", 300_000, "Карта", 340_000, "Продукты"),
                ("Досуг", 200_000, "Наличные", 100_000, "Музей"),
            ] {
                let id = category_id(category)?;
                budgets::set_limit_kind(db.conn(), &budget, id, "month", limit)?;
                expense(db.conn(), account, id, today, amount, payee)?;
            }
        }
    }
    Ok(db)
}

fn prepare(scenario: Scenario, dir: &Path, today: NaiveDate) -> Result<()> {
    let db = seed(scenario, today)?;
    fs::create_dir(dir).map_err(|e| match e.kind() {
        ErrorKind::AlreadyExists => {
            format!("Путь «{}» уже занят. Укажите новую папку.", dir.display())
        }
        _ => format!("Не удалось создать папку «{}»: {e}", dir.display()),
    })?;
    if let Scenario::Rent = scenario {
        let mut statement = fs::File::create_new(dir.join("аренда.csv"))?;
        writeln!(
            statement,
            r#""Дата операции";"Номер карты";"Статус";"Сумма операции";"Валюта операции";"Сумма платежа";"Валюта платежа";"Категория";"Описание""#
        )?;
        writeln!(
            statement,
            r#""{} 10:00:00";"*1140";"OK";"-10000,00";"RUB";"-10000,00";"RUB";"Жильё";"Аренда""#,
            today.format("%d.%m.%Y")
        )?;
    }
    storage::backup_to(db.conn(), &dir.join("budget.db"))?;
    Ok(())
}

fn run() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    let scenario = match args.next().as_deref().and_then(|s| s.to_str()) {
        Some("rent") => Scenario::Rent,
        Some("budget") => Scenario::Budget,
        _ => return Err(USAGE.into()),
    };
    let dir = PathBuf::from(args.next().ok_or(USAGE)?);
    let date = match args.next() {
        Some(value) => value.into_string().map_err(|_| USAGE)?,
        None => time::today_local(),
    };
    if args.next().is_some() {
        return Err(USAGE.into());
    }
    let today = time::parse_date(&date)?;
    prepare(scenario, &dir, today)?;
    println!(
        "Учебный профиль на {today} готов в папке «{}».",
        dir.display()
    );
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("Не удалось подготовить профиль. {e}");
            ExitCode::FAILURE
        }
    }
}
