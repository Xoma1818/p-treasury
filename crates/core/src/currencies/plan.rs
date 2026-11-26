//! Курсы для факта фиксированного плана. Каждый перевод оценивается в валюте
//! самого плана, даже если в ту дату ЦБ загружал котировки к другой валюте.
use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};

use super::{find, minor_units, Currency};
use crate::money::Rate;
use crate::Result;

type Leg = (Rate, bool);

struct Quote {
    date: String,
    from_minor: u32,
    first: Leg,
    second: Option<Leg>,
}

struct Window {
    through: String,
    quote: Option<Quote>,
}

pub(crate) struct PlanRates<'a> {
    target: &'a Currency,
    by_currency: HashMap<String, Window>,
}

impl<'a> PlanRates<'a> {
    pub(crate) fn new(target: &'a Currency) -> Self {
        Self {
            target,
            by_currency: HashMap::new(),
        }
    }

    pub(crate) fn convert(
        &mut self,
        conn: &Connection,
        amount: i64,
        from: &str,
        date: &str,
    ) -> Result<Option<i64>> {
        if from == self.target.code {
            return Ok(Some(amount));
        }
        // Взносы идут от новых к старым. Курс действует до следующей
        // котировки; отсутствие курса на дату означает его отсутствие и раньше.
        let hit = self.by_currency.get(from).filter(|w| {
            date <= w.through.as_str() && w.quote.as_ref().is_none_or(|q| q.date.as_str() <= date)
        });
        let window = if let Some(w) = hit {
            w
        } else {
            let w = Window {
                through: date.to_owned(),
                quote: quote_on(conn, from, &self.target.code, date)?,
            };
            self.by_currency
                .entry(from.to_owned())
                .insert_entry(w)
                .into_mut()
        };
        let Some(q) = &window.quote else {
            return Ok(None);
        };
        let to_minor = self.target.minor_units;
        let value = match q.second {
            Some(next) => Rate::convert_cross(q.first, next, amount, q.from_minor, to_minor)?,
            None if q.first.1 => q.first.0.convert_inverse(amount, q.from_minor, to_minor)?,
            None => q.first.0.convert(amount, q.from_minor, to_minor)?,
        };
        Ok(Some(value))
    }
}

fn quote_on(conn: &Connection, from: &str, to: &str, on: &str) -> Result<Option<Quote>> {
    let direct = find(conn, from, to, on)?;
    let last_direct = direct.as_ref().map(|q| q.date.as_str()).unwrap_or("");
    // Кросс-курс может выиграть только более свежей датой. Обе его части
    // должны быть за один день. Для равных вариантов сначала ручные ставки,
    // затем стабильный код промежуточной валюты, затем прямое направление.
    let cross: Option<(String, String, bool, String, bool)> = if last_direct == on {
        None
    } else {
        conn.prepare_cached(
            "SELECT a.date, a.rate, a.from_code <> ?1, b.rate, b.to_code <> ?2
             FROM exchange_rates a CROSS JOIN exchange_rates b ON b.date=a.date
             WHERE ?1 IN (a.from_code,a.to_code) AND ?2 IN (b.from_code,b.to_code)
               AND a.date > ?3 AND a.date <= ?4
               AND (CASE WHEN a.from_code=?1 THEN a.to_code ELSE a.from_code END)
                 = (CASE WHEN b.from_code=?2 THEN b.to_code ELSE b.from_code END)
             ORDER BY a.date DESC, ((a.source='manual')+(b.source='manual')) DESC,
               (CASE WHEN a.from_code=?1 THEN a.to_code ELSE a.from_code END),
               a.from_code=?1 DESC, b.to_code=?2 DESC LIMIT 1",
        )?
        .query_row(params![from, to, last_direct, on], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .optional()?
    };
    let (date, first, second) = if let Some((date, a, ai, b, bi)) = cross {
        (date, (Rate::parse(&a)?, ai), Some((Rate::parse(&b)?, bi)))
    } else if let Some(d) = direct {
        (d.date, (d.rate, d.inverse), None)
    } else {
        return Ok(None);
    };
    Ok(Some(Quote {
        date,
        from_minor: minor_units(conn, from)?,
        first,
        second,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{currencies, storage::Storage};

    #[test]
    fn conversion_rounds_only_in_the_final_currency_and_reuses_daily_quote() {
        let db = Storage::open_in_memory().unwrap();
        let c = db.conn();
        let d = "2026-11-20";
        // 1 цент USD = 0.004 EUR = 1 JPY. Округление в EUR потеряло бы всю иену.
        currencies::set_rate(c, d, "USD", "EUR", ".4").unwrap();
        currencies::set_rate(c, d, "JPY", "EUR", ".004").unwrap();
        let yen = currencies::get(c, "JPY").unwrap();
        let mut rates = PlanRates::new(&yen);
        for (amount, want) in [(1, 1), (0, 0), (-1, -1), (12, 12)] {
            assert_eq!(rates.convert(c, amount, "USD", d).unwrap(), Some(want));
        }
        assert_eq!(rates.by_currency.len(), 1);
        let usd = currencies::get(c, "USD").unwrap();
        let mut inverse = PlanRates::new(&usd);
        assert_eq!(inverse.convert(c, 1, "JPY", d).unwrap(), Some(1));
    }
}
