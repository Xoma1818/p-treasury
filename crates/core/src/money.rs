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
}
