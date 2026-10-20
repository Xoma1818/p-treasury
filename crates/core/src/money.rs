//! Деньги: целое число в минимальных единицах валюты (копейки, центы).
//!
//! Никаких чисел с плавающей точкой: ввод разбирается из строки посимвольно,
//! вывод собирается целочисленной арифметикой.

use crate::{Error, Result};

/// Неразрывный пробел между разрядами: «1 234,56».
const GROUP_SEP: char = '\u{00A0}';

/// Разобрать сумму, введённую пользователем, в минимальные единицы.
///
/// Принимает `1234`, `1234,5`, `1 234.56`, `-50`, `+12,30`. Разделитель
/// дробной части: запятая или точка; пробелы (в том числе неразрывные)
/// между разрядами игнорируются. Больше знаков после запятой, чем у валюты,
/// считается ошибкой, а не округляется молча.
pub fn parse_amount(input: &str, minor_units: u32) -> Result<i64> {
    let err = || Error::InvalidAmount(input.to_string());
    let cleaned: String = input
        .chars()
        .filter(|c| !matches!(c, ' ' | '\u{00A0}' | '\u{202F}' | '\t'))
        .collect();
    let (negative, body) = match cleaned.as_bytes().first() {
        Some(b'-') => (true, &cleaned[1..]),
        Some(b'+') => (false, &cleaned[1..]),
        _ => (false, cleaned.as_str()),
    };
    if body.is_empty() {
        return Err(err());
    }
    let (int_part, frac_part) = match body.find([',', '.']) {
        Some(pos) => (&body[..pos], &body[pos + 1..]),
        None => (body, ""),
    };
    if int_part.is_empty() && frac_part.is_empty() {
        return Err(err());
    }
    let all_digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if !all_digits(int_part) || !all_digits(frac_part) || frac_part.len() > minor_units as usize {
        return Err(err());
    }

    let scale = 10i64.checked_pow(minor_units).ok_or_else(err)?;
    let int_value: i64 = if int_part.is_empty() {
        0
    } else {
        int_part.parse().map_err(|_| err())?
    };
    let mut frac_value: i64 = if frac_part.is_empty() {
        0
    } else {
        frac_part.parse().map_err(|_| err())?
    };
    for _ in frac_part.len()..minor_units as usize {
        frac_value *= 10;
    }
    let value = int_value
        .checked_mul(scale)
        .and_then(|v| v.checked_add(frac_value))
        .ok_or_else(err)?;
    Ok(if negative { -value } else { value })
}

/// Вывести сумму по-русски: «1 234,56». С `trim_zero_fraction` целые суммы
/// выводятся без «,00»: «14 977».
pub fn format_amount(amount: i64, minor_units: u32, trim_zero_fraction: bool) -> String {
    let scale = 10u64.pow(minor_units);
    let abs = amount.unsigned_abs();
    let int_part = abs / scale;
    let frac_part = abs % scale;

    let digits = int_part.to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            grouped.push(GROUP_SEP);
        }
        grouped.push(ch);
    }

    let mut out = String::new();
    if amount < 0 {
        out.push('−');
    }
    out.push_str(&grouped);
    if minor_units > 0 && !(trim_zero_fraction && frac_part == 0) {
        out.push(',');
        out.push_str(&format!(
            "{:0width$}",
            frac_part,
            width = minor_units as usize
        ));
    }
    out
}

/// Курс валюты: десятичное число без плавающей точки, `mantissa / 10^scale`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rate {
    mantissa: i128,
    scale: u32,
}

impl Rate {
    /// Разобрать курс: `92`, `92,15`, `0.0108`. Курс должен быть больше нуля,
    /// до 10 знаков после запятой.
    pub fn parse(input: &str) -> Result<Self> {
        let err = || Error::Validation(format!("некорректный курс: {input}"));
        let s: String = input.chars().filter(|c| !c.is_whitespace()).collect();
        let (int_part, frac_part) = match s.find([',', '.']) {
            Some(pos) => (&s[..pos], &s[pos + 1..]),
            None => (s.as_str(), ""),
        };
        let digits = |p: &str| p.bytes().all(|b| b.is_ascii_digit());
        if (int_part.is_empty() && frac_part.is_empty())
            || !digits(int_part)
            || !digits(frac_part)
            || frac_part.len() > 10
        {
            return Err(err());
        }
        let joined = format!("{int_part}{frac_part}");
        let mantissa: i128 = joined.parse().map_err(|_| err())?;
        if mantissa == 0 || int_part.len() > 12 {
            return Err(err());
        }
        Ok(Self {
            mantissa,
            scale: frac_part.len() as u32,
        }
        .normalized())
    }

    /// Курс по двум суммам перевода: сколько единиц `to` за одну единицу `from`.
    pub fn from_amounts(
        from_amount: i64,
        from_minor: u32,
        to_amount: i64,
        to_minor: u32,
    ) -> Option<Self> {
        if from_amount <= 0 || to_amount <= 0 {
            return None;
        }
        // to/from с поправкой на разную точность, 6 знаков после запятой.
        let num = to_amount as i128 * 10i128.pow(from_minor) * 1_000_000;
        let den = from_amount as i128 * 10i128.pow(to_minor);
        Some(
            Self {
                mantissa: div_round(num, den),
                scale: 6,
            }
            .normalized(),
        )
    }

    fn normalized(mut self) -> Self {
        while self.scale > 0 && self.mantissa % 10 == 0 {
            self.mantissa /= 10;
            self.scale -= 1;
        }
        self
    }

    /// Пересчитать сумму из валюты с `from_minor` знаками в валюту с `to_minor`.
    /// Округление до минимальной единицы: половина от нуля.
    pub fn convert(&self, amount: i64, from_minor: u32, to_minor: u32) -> i64 {
        let num = amount as i128 * self.mantissa * 10i128.pow(to_minor);
        let den = 10i128.pow(self.scale) * 10i128.pow(from_minor);
        div_round(num, den) as i64
    }

    /// Пересчёт по обратному курсу (курс задан как to→from).
    pub fn convert_inverse(&self, amount: i64, from_minor: u32, to_minor: u32) -> i64 {
        let num = amount as i128 * 10i128.pow(self.scale) * 10i128.pow(to_minor);
        let den = self.mantissa * 10i128.pow(from_minor);
        div_round(num, den) as i64
    }
}

impl std::fmt::Display for Rate {
    /// Строка для хранения в базе: `92.15`.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let scale = 10i128.pow(self.scale);
        if self.scale == 0 {
            write!(f, "{}", self.mantissa)
        } else {
            write!(
                f,
                "{}.{:0width$}",
                self.mantissa / scale,
                self.mantissa % scale,
                width = self.scale as usize
            )
        }
    }
}

/// Деление с округлением «половина от нуля»; знаменатель > 0.
fn div_round(num: i128, den: i128) -> i128 {
    let q = num / den;
    let r = num % den;
    if 2 * r.abs() >= den {
        q + num.signum()
    } else {
        q
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_common_inputs() {
        assert_eq!(parse_amount("1234", 2).unwrap(), 123_400);
        assert_eq!(parse_amount("1 234,56", 2).unwrap(), 123_456);
        assert_eq!(parse_amount("1\u{00A0}234.5", 2).unwrap(), 123_450);
        assert_eq!(parse_amount("0,07", 2).unwrap(), 7);
        assert_eq!(parse_amount(",5", 2).unwrap(), 50);
        assert_eq!(parse_amount("-50", 2).unwrap(), -5_000);
        assert_eq!(parse_amount("+12,30", 2).unwrap(), 1_230);
        assert_eq!(parse_amount("1500", 0).unwrap(), 1_500);
    }

    #[test]
    fn rejects_bad_inputs() {
        for bad in ["", " ", "-", "abc", "12,345", "1,2,3", "1e5", ",", "12-3"] {
            assert!(
                parse_amount(bad, 2).is_err(),
                "должно быть ошибкой: {bad:?}"
            );
        }
        assert!(parse_amount("10,5", 0).is_err());
        assert!(parse_amount("99999999999999999999", 2).is_err());
    }

    #[test]
    fn formats_amounts() {
        assert_eq!(format_amount(123_456, 2, false), "1\u{00A0}234,56");
        assert_eq!(format_amount(1_497_700, 2, true), "14\u{00A0}977");
        assert_eq!(format_amount(1_497_700, 2, false), "14\u{00A0}977,00");
        assert_eq!(format_amount(-35_000, 2, true), "−350");
        assert_eq!(format_amount(5, 2, false), "0,05");
        assert_eq!(
            format_amount(30_000_000, 0, true),
            "30\u{00A0}000\u{00A0}000"
        );
        assert_eq!(format_amount(0, 2, true), "0");
    }

    #[test]
    fn roundtrip() {
        for v in [0, 1, 99, 100, 123_456, -987_654_321] {
            let s = format_amount(v, 2, false).replace('−', "-");
            assert_eq!(parse_amount(&s, 2).unwrap(), v);
        }
    }

    #[test]
    fn rates_parse_and_convert() {
        let r = Rate::parse("92,15").unwrap();
        assert_eq!(r.to_string(), "92.15");
        // 1 000 $ → 92 150 ₽
        assert_eq!(r.convert(100_000, 2, 2), 9_215_000);
        // 9 215 ₽ → 100 $ по обратному курсу
        assert_eq!(r.convert_inverse(921_500, 2, 2), 10_000);
        // 1 ¥ (JPY, без копеек) по 0,62 ₽ → 0,62 ₽
        assert_eq!(Rate::parse("0.62").unwrap().convert(1, 0, 2), 62);
        // Округление: 0,01 $ по 92,15 = 0,9215 ₽ → 0,92 ₽
        assert_eq!(r.convert(1, 2, 2), 92);
        assert_eq!(r.convert(-1, 2, 2), -92);
        assert_eq!(Rate::parse("100.000").unwrap().to_string(), "100");
        for bad in ["", "0", "-1", "abc", "1,2,3", "0,00"] {
            assert!(Rate::parse(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn rate_from_transfer_amounts() {
        // Списано 92 000 ₽, зачислено 1 000 $ → курс 0,010870 $ за рубль
        let r = Rate::from_amounts(9_200_000, 2, 100_000, 2).unwrap();
        assert_eq!(r.to_string(), "0.01087");
        let back = Rate::from_amounts(100_000, 2, 9_200_000, 2).unwrap();
        assert_eq!(back.to_string(), "92");
    }
}
