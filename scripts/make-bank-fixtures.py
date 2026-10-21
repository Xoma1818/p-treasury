"""Тестовые выписки для разбора банковских форматов (crates/core/testdata).

Сбер: PDF «Выписка по счёту дебетовой карты» с той же раскладкой, что у
СберБанк Онлайн: строка операции (дата и время, категория, сумма, остаток),
под ней дата обработки, код авторизации и описание; длинное описание
переносится на третью строку. Расход без знака, доход с «+». Две страницы,
шапка таблицы повторяется, внизу страницы сноска и номер.

Запуск: python3 scripts/make-bank-fixtures.py (нужен reportlab и шрифт DejaVu).
"""
from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

OUT = Path(__file__).resolve().parent.parent / "crates/core/testdata"
pdfmetrics.registerFont(TTFont("Sans", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"))
pdfmetrics.registerFont(TTFont("SansB", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"))

# (дата и время, категория, сумма, остаток, дата обработки, код, описание…)
PAGES = [
    [
        ("20.10.2026 13:08", "Супермаркеты", "1 250,00", "45 678,90", "20.10.2026", "284711", ["PYATEROCHKA 1234 Moscow RUS"]),
        ("18.10.2026 10:00", "Перевод на карту", "+50 000,00", "46 928,90", "18.10.2026", "000000", ["Зарплата ООО Ромашка"]),
        ("15.10.2026 09:12", "Связь", "650,00", "-3 071,10", "15.10.2026", "123456", ["МТС мобильная связь, оплата по номеру", "+7 916 ***-**-12"]),
        ("05.10.2026 00:01", "Прочие операции", "399,00", "-2 421,10", "06.10.2026", "777777", ["YANDEX*PLUS Moscow RUS"]),
    ],
    [
        ("03.10.2026 19:45", "Рестораны и кафе", "1 840,50", "-2 022,10", "04.10.2026", "555555", ["KOFEMANIYA Moscow RUS"]),
    ],
]


def header(c, y):
    c.setFont("SansB", 7)
    c.drawString(40, y, "ДАТА ОПЕРАЦИИ (МСК)")
    c.drawString(150, y, "КАТЕГОРИЯ")
    c.drawRightString(440, y, "СУММА В ВАЛЮТЕ СЧЁТА")
    c.drawRightString(555, y, "ОСТАТОК СРЕДСТВ")
    c.setFont("Sans", 7)
    c.drawString(40, y - 10, "Дата обработки¹ и код авторизации")
    c.drawString(150, y - 10, "Описание операции")
    c.drawRightString(555, y - 10, "В ВАЛЮТЕ СЧЁТА")
    return y - 30


def sber():
    c = canvas.Canvas(str(OUT / "sber-card.pdf"), pagesize=A4)
    for n, rows in enumerate(PAGES, 1):
        y = 800
        if n == 1:
            c.setFont("SansB", 14)
            c.drawString(40, y, "Выписка по счёту дебетовой карты")
            c.setFont("Sans", 9)
            c.drawString(40, y - 18, "СберКарта •• 4321")
            c.drawString(40, y - 30, "Иванов Иван Иванович")
            c.drawString(40, y - 42, "Итого по операциям с 01.10.2026 по 20.10.2026")
            c.drawRightString(555, y - 42, "Остаток на 20.10.2026: 45 678,90")
            y -= 70
        y = header(c, y)
        for when, cat, amount, rest, proc_date, code, desc in rows:
            c.setFont("Sans", 9)
            c.drawString(40, y, when)
            c.drawString(150, y, cat)
            c.drawRightString(440, y, amount)
            c.drawRightString(555, y, rest)
            c.setFont("Sans", 8)
            c.drawString(40, y - 11, f"{proc_date} {code}")
            for i, line in enumerate(desc):
                c.drawString(150, y - 11 - 10 * i, line)
            y -= 22 + 10 * len(desc)
        c.setFont("Sans", 6)
        c.drawString(40, 60, "¹ Дата обработки банком. Продолжение на следующей странице")
        c.drawRightString(555, 48, f"Страница {n} из {len(PAGES)}")
        c.showPage()
    c.save()


def tbank():
    head = '"Дата операции";"Дата платежа";"Номер карты";"Статус";"Сумма операции";"Валюта операции";"Сумма платежа";"Валюта платежа";"Кэшбэк";"Категория";"MCC";"Описание";"Бонусы (включая кэшбэк)";"Округление на инвесткопилку";"Сумма операции с округлением"'
    rows = [
        '"20.10.2026 16:29:51";"20.10.2026";"*1140";"OK";"-1053,77";"RUB";"-1053,77";"RUB";"";"Супермаркеты";"5411";"Пятерочка";"10,00";"0,00";"1053,77"',
        '"19.10.2026 12:43:25";"19.10.2026";"*1140";"FAILED";"-350,00";"RUB";"-350,00";"RUB";"";"Рестораны";"5812";"KAFE DEDUSHKA KHO";"0,00";"0,00";"350,00"',
        '"18.10.2026 09:00:00";"18.10.2026";"*1140";"OK";"-12,99";"USD";"-1200,00";"RUB";"";"Цифровые товары";"5815";"Steam";"0,00";"0,00";"1200,00"',
        '"15.10.2026 10:00:00";"15.10.2026";"";"OK";"85000,00";"RUB";"85000,00";"RUB";"";"Пополнения";"";"Зарплата";"0,00";"0,00";"85000,00"',
        '"10.10.2026 18:20:00";"10.10.2026";"*8305";"OK";"-2500,00";"RUB";"-2500,00";"RUB";"";"Такси";"4121";"Яндекс Go";"0,00";"0,00";"2500,00"',
    ]
    # Т-Банк отдаёт CSV в кодировке Windows-1251.
    (OUT / "tbank.csv").write_bytes(("\n".join([head, *rows]) + "\n").encode("cp1251"))


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    sber()
    tbank()
