//! Выгрузка операций в OFX 2.2 (XML, UTF-8): формат банковских выписок,
//! который читают GnuCash, Moneydance, Дзен-мани и другие программы учёта.
//!
//! По одной выписке (`STMTRS`) на счёт. Перевод между своими счетами даёт две
//! строки: списание на счёте-источнике и зачисление на счёте-получателе.
//! Если выгрузка по одному счёту, в неё попадает только его сторона перевода.
//! `FITID` — номер операции в Kazna (у зачисления перевода с суффиксом `-in`),
//! поэтому повторный импорт того же файла не задвоит операции.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use rusqlite::Connection;

use crate::export::all_transactions;
use crate::transactions::{Filter, Txn};
use crate::{accounts, Error, Result};

/// Строка выписки одного счёта.
struct Line {
    fitid: String,
    kind: &'static str,
    date: String,
    amount: i64,
    name: Option<String>,
    memo: Option<String>,
}

/// Текст OFX-файла по операциям фильтра; `today` — `YYYY-MM-DD`.
pub fn transactions_ofx(conn: &Connection, filter: &Filter, today: &str) -> Result<String> {
    let txns = all_transactions(conn, filter)?;
    let only = filter.account_id.as_deref();
    let mut by_account: BTreeMap<String, Vec<Line>> = BTreeMap::new();
    for t in &txns {
        for (account, line) in lines(t) {
            if only.is_none_or(|a| a == account) {
                by_account.entry(account).or_default().push(line);
            }
        }
    }
    if let Some(a) = only {
        by_account.entry(a.to_string()).or_default();
    }
    let all = accounts::list(conn, true)?;
    // Период выписки охватывает все её операции (и будущие), остаток — на его конец.
    let last = txns.last().map(|t| t.date.as_str()).unwrap_or(today);
    let to = filter
        .date_to
        .clone()
        .unwrap_or_else(|| last.max(today).to_string());
    let from = filter
        .date_from
        .clone()
        .or_else(|| txns.first().map(|t| t.date.clone()))
        .unwrap_or_else(|| to.clone())
        .min(to.clone());

    let mut out = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"no\"?>\n\
         <?OFX OFXHEADER=\"200\" VERSION=\"220\" SECURITY=\"NONE\" OLDFILEUID=\"NONE\" NEWFILEUID=\"NONE\"?>\n\
         <OFX>\n<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>",
    );
    out += &format!(
        "<DTSERVER>{}</DTSERVER><LANGUAGE>RUS</LANGUAGE></SONRS></SIGNONMSGSRSV1>\n",
        day(today)
    );
    out += "<BANKMSGSRSV1>\n";
    for (n, (account_id, lines)) in by_account.iter().enumerate() {
        // Служебные счета долгов в списке счетов не видны: их пропускаем.
        let Some(acc) = all.iter().find(|a| &a.id == account_id) else {
            continue;
        };
        let mu = acc.minor_units;
        out += &format!(
            "<STMTTRNRS><TRNUID>{}</TRNUID><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>\n<STMTRS><CURDEF>{}</CURDEF>\
             <BANKACCTFROM><BANKID>KAZNA</BANKID><ACCTID>{}</ACCTID><ACCTTYPE>{}</ACCTTYPE></BANKACCTFROM>\n",
            n + 1,
            esc(&acc.currency_code),
            acct_id(&acc.id),
            if acc.kind == "credit" { "CREDITLINE" } else { "CHECKING" },
        );
        out += &format!(
            "<BANKTRANLIST><DTSTART>{}</DTSTART><DTEND>{}</DTEND>\n",
            day(&from),
            day(&to)
        );
        for l in lines {
            out += &format!(
                "<STMTTRN><TRNTYPE>{}</TRNTYPE><DTPOSTED>{}</DTPOSTED><TRNAMT>{}</TRNAMT><FITID>{}</FITID>",
                l.kind,
                day(&l.date),
                amount(l.amount, mu),
                esc(&l.fitid),
            );
            if let Some(name) = &l.name {
                out += &format!("<NAME>{}</NAME>", esc(&cut(name, 32)));
            }
            if let Some(memo) = &l.memo {
                out += &format!("<MEMO>{}</MEMO>", esc(&cut(memo, 255)));
            }
            out += "</STMTTRN>\n";
        }
        let balance = accounts::balance(conn, account_id, Some(&to))?;
        out += &format!(
            "</BANKTRANLIST>\n<LEDGERBAL><BALAMT>{}</BALAMT><DTASOF>{}</DTASOF></LEDGERBAL></STMTRS></STMTTRNRS>\n",
            amount(balance, mu),
            day(&to),
        );
    }
    out += "</BANKMSGSRSV1>\n</OFX>\n";
    Ok(out)
}

/// Записать OFX во временный файл и переименовать (как и другие выгрузки).
pub fn write_transactions(
    conn: &Connection,
    filter: &Filter,
    path: &Path,
    today: &str,
) -> Result<()> {
    let text = transactions_ofx(conn, filter, today)?;
    let tmp = path.with_extension("ofx.tmp");
    fs::write(&tmp, text)?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        Error::from(e)
    })
}

/// Строки выписки по одной операции: `(счёт, строка)`.
fn lines(t: &Txn) -> Vec<(String, Line)> {
    let memo = {
        let parts: Vec<&str> = [t.category_name.as_deref(), t.note.as_deref()]
            .into_iter()
            .flatten()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        (!parts.is_empty()).then(|| parts.join(" · "))
    };
    let payee = t
        .payee
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let line = |fitid: String, kind, amount, name: Option<String>, memo: Option<String>| Line {
        fitid,
        kind,
        date: t.date.clone(),
        amount,
        name,
        memo,
    };
    match t.kind.as_str() {
        "expense" => vec![(
            t.account_id.clone(),
            line(t.id.clone(), "DEBIT", -t.amount, payee, memo),
        )],
        "income" => vec![(
            t.account_id.clone(),
            line(t.id.clone(), "CREDIT", t.amount, payee, memo),
        )],
        "transfer" => {
            let to_name = t.to_account_name.clone();
            let mut v = vec![(
                t.account_id.clone(),
                line(
                    t.id.clone(),
                    "XFER",
                    -t.amount,
                    to_name.clone().or(payee.clone()),
                    memo.clone(),
                ),
            )];
            if let Some(to) = &t.to_account_id {
                let got = t.to_amount.unwrap_or(t.amount);
                v.push((
                    to.clone(),
                    line(
                        format!("{}-in", t.id),
                        "XFER",
                        got,
                        Some(t.account_name.clone()),
                        memo,
                    ),
                ));
            }
            v
        }
        // Корректировка остатка: сумма уже со знаком.
        _ => vec![(
            t.account_id.clone(),
            line(
                t.id.clone(),
                if t.amount < 0 { "DEBIT" } else { "CREDIT" },
                t.amount,
                Some("Корректировка остатка".into()),
                memo,
            ),
        )],
    }
}

/// Номер счёта в OFX (до 22 знаков): постоянный — из id счёта, а не из
/// названия, поэтому не меняется при переименовании и не совпадает у двух
/// одноимённых карт. Хвост UUID v7 — случайная часть.
fn acct_id(id: &str) -> String {
    let hex: String = id.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    let start = hex.len().saturating_sub(22);
    hex[start..].to_uppercase()
}

/// `YYYY-MM-DD` → `YYYYMMDD`.
fn day(date: &str) -> String {
    date.replace('-', "")
}

/// Сумма в минимальных единицах → `-1234.50`.
fn amount(v: i64, mu: u32) -> String {
    if mu == 0 {
        return v.to_string();
    }
    let p = 10_i64.pow(mu);
    let sign = if v < 0 { "-" } else { "" };
    format!(
        "{sign}{}.{:0width$}",
        v.abs() / p,
        v.abs() % p,
        width = mu as usize
    )
}

fn cut(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::tests::input;
    use crate::categories;
    use crate::storage::Storage;
    use crate::transactions::{self, TxnInput};

    fn salary(c: &Connection) -> String {
        c.query_row(
            "SELECT id FROM categories WHERE name = 'Заработная плата'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn txn(kind: &str, date: &str, account: &str, amount: i64) -> TxnInput {
        TxnInput {
            kind: kind.into(),
            date: date.into(),
            account_id: account.into(),
            amount,
            category_id: None,
            to_account_id: None,
            to_amount: None,
            payee: None,
            note: None,
        }
    }

    #[test]
    fn statement_per_account_with_signed_amounts_and_both_sides_of_transfer() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        categories::seed_defaults(c).unwrap();
        let card =
            accounts::create(c, &input("Карта <Сбер> & Ко", "debit", "RUB", 10_000_000)).unwrap();
        let cash = accounts::create(c, &input("Наличные", "cash", "RUB", 0)).unwrap();
        let food: String = c
            .query_row(
                "SELECT id FROM categories WHERE name = 'Питание' AND kind = 'expense'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let mut e = txn("expense", "2026-10-05", &card, 234_050);
        e.category_id = Some(food);
        e.payee = Some("Пятёрочка".into());
        e.note = Some("у дома".into());
        let spent = transactions::create(c, &e).unwrap();
        let mut inc = txn("income", "2026-10-01", &card, 8_500_000);
        inc.category_id = Some(salary(c));
        transactions::create(c, &inc).unwrap();
        let mut tr = txn("transfer", "2026-10-07", &card, 100_000);
        tr.to_account_id = Some(cash.clone());
        let moved = transactions::create(c, &tr).unwrap();

        let all = transactions_ofx(c, &Filter::default(), "2026-11-04").unwrap();
        assert!(all.starts_with("<?xml"));
        assert_eq!(all.matches("<STMTRS>").count(), 2, "по выписке на счёт");
        assert!(all.contains(&format!("<ACCTID>{}</ACCTID>", acct_id(&card))));
        assert_eq!(acct_id(&card).len(), 22);
        assert_ne!(acct_id(&card), acct_id(&cash));
        assert!(all.contains(&format!(
            "<TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261005</DTPOSTED><TRNAMT>-2340.50</TRNAMT><FITID>{spent}</FITID><NAME>Пятёрочка</NAME><MEMO>Питание · у дома</MEMO>"
        )));
        assert!(all.contains(
            "<TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20261001</DTPOSTED><TRNAMT>85000.00</TRNAMT>"
        ));
        assert!(all.contains(&format!(
            "<TRNAMT>-1000.00</TRNAMT><FITID>{moved}</FITID><NAME>Наличные</NAME>"
        )));
        assert!(all.contains(&format!(
            "<TRNAMT>1000.00</TRNAMT><FITID>{moved}-in</FITID>"
        )));
        // Остаток карты: 100 000 + 85 000 − 2 340,50 − 1 000.
        assert!(all.contains("<BALAMT>181659.50</BALAMT><DTASOF>20261104</DTASOF>"));

        // Выгрузка по одному счёту: только его сторона перевода.
        let f = Filter {
            account_id: Some(cash.clone()),
            ..Filter::default()
        };
        let one = transactions_ofx(c, &f, "2026-11-04").unwrap();
        assert_eq!(one.matches("<STMTRS>").count(), 1);
        assert_eq!(one.matches("<STMTTRN>").count(), 1);
        assert!(one.contains(&format!("{moved}-in")));
        assert!(one.contains("<BALAMT>1000.00</BALAMT>"));
    }

    /// Даты выписки согласованы с операциями: будущая операция внутри
    /// периода, остаток — на его конец; одноимённые счета различаются.
    #[test]
    fn period_covers_future_operations_and_same_names_differ() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        categories::seed_defaults(c).unwrap();
        let a = accounts::create(c, &input("Сбер", "debit", "RUB", 0)).unwrap();
        let b = accounts::create(c, &input("Сбер", "debit", "RUB", 0)).unwrap();
        let mut inc = txn("income", "2026-12-20", &a, 500);
        inc.category_id = Some(salary(c));
        transactions::create(c, &inc).unwrap();
        let mut inc2 = txn("income", "2026-10-02", &b, 100);
        inc2.category_id = Some(salary(c));
        transactions::create(c, &inc2).unwrap();

        let all = transactions_ofx(c, &Filter::default(), "2026-11-04").unwrap();
        assert!(
            all.contains("<DTSTART>20261002</DTSTART><DTEND>20261220</DTEND>"),
            "{all}"
        );
        assert!(all.contains("<BALAMT>5.00</BALAMT><DTASOF>20261220</DTASOF>"));
        assert_eq!(all.matches("<ACCTID>").count(), 2);
        assert_ne!(acct_id(&a), acct_id(&b));

        // Период целиком в будущем: начало не позже конца.
        let f = Filter {
            date_from: Some("2027-01-01".into()),
            date_to: Some("2027-01-31".into()),
            ..Filter::default()
        };
        let future = transactions_ofx(c, &f, "2026-11-04").unwrap();
        assert!(!future.contains("<STMTTRN>"));
        let f = Filter {
            date_from: Some("2026-12-01".into()),
            ..Filter::default()
        };
        let tail = transactions_ofx(c, &f, "2026-11-04").unwrap();
        assert!(
            tail.contains("<DTSTART>20261201</DTSTART><DTEND>20261220</DTEND>"),
            "{tail}"
        );
    }

    #[test]
    fn amounts_keep_minor_units() {
        assert_eq!(amount(-234_050, 2), "-2340.50");
        assert_eq!(amount(5, 2), "0.05");
        assert_eq!(amount(-5, 2), "-0.05");
        assert_eq!(amount(1500, 0), "1500");
    }

    #[test]
    fn written_file_is_utf8_xml() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        categories::seed_defaults(c).unwrap();
        let card = accounts::create(c, &input("Карта", "debit", "RUB", 0)).unwrap();
        let mut inc = txn("income", "2026-10-01", &card, 100);
        inc.category_id = Some(salary(c));
        transactions::create(c, &inc).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("операции.ofx");
        write_transactions(c, &Filter::default(), &path, "2026-11-04").unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("<TRNAMT>1.00</TRNAMT>"));
        assert!(!dir.path().join("операции.ofx.tmp").exists());
    }
}
