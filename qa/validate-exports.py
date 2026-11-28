import csv
import json
import sqlite3
import sys
import zipfile
from decimal import Decimal
from pathlib import Path
from xml.etree.ElementTree import fromstring
from pypdf import PdfReader

sys.stdout.reconfigure(encoding="utf-8")
d = Path(sys.argv[1])
ns = {"x":"http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
with (d/"summary.csv").open(encoding="utf-8-sig", newline="") as f:
    csv_rows = list(csv.reader(f, delimiter=";"))
def as_minor(value):
    return Decimal(str(value).replace(" ","").replace("\xa0","").replace(",", "."))*100
def matches(rows, word, minor):
    return any(row and row[0]==word and len(row)>1 and as_minor(row[1])==minor for row in rows)
with zipfile.ZipFile(d/"summary.xlsx") as z:
    names=[s.attrib["name"] for s in fromstring(z.read("xl/workbook.xml")).findall(".//x:sheet",ns)]
    assert names==["Сводка","По категориям","Бюджет","По месяцам","Долги","Операции"],names
    ss=["".join(s.itertext()) for s in fromstring(z.read("xl/sharedStrings.xml")).findall("x:si",ns)] if "xl/sharedStrings.xml" in z.namelist() else []
    sheet=fromstring(z.read("xl/worksheets/sheet1.xml"))
    bookrows=[]
    for r in sheet.findall(".//x:row",ns):
        row=[]
        for c in r.findall("x:c",ns):
            v=c.findtext("x:v",default="",namespaces=ns)
            row.append(ss[int(v)] if c.attrib.get("t")=="s" else ("".join(c.itertext()) if c.attrib.get("t")=="inlineStr" else v))
        bookrows.append(row)
    print("Workbook rows:", bookrows[:14], flush=True)
for rows in (csv_rows,bookrows):
    assert matches(rows,"Доходы",123456), rows[:13]
    assert matches(rows,"Расходы",47039), rows[:13]
pdf=PdfReader(d/"loan.pdf")
pdf_text=" ".join(" ".join(p.extract_text() or "" for p in pdf.pages).split())
assert "Учебный Кредитор" in pdf_text and "Учебный Заёмщик" in pdf_text, pdf_text[:800]
con=sqlite3.connect(Path(sys.argv[2]).resolve().as_uri()+"?mode=ro",uri=True)
assert con.execute("SELECT COUNT(*) FROM transactions").fetchone()==(8,)
actual=con.execute("SELECT amount,type FROM transactions WHERE payee=?",("Учебный приёмочный чек",)).fetchall()
assert actual==[(1234,"expense")],actual
assert con.execute("PRAGMA integrity_check").fetchall()==[("ok",)]
assert con.execute("PRAGMA foreign_key_check").fetchall()==[]
result={"xlsxSheets":names,"csvIncomeMinor":123456,"csvExpenseMinor":47039,"xlsxIncomeMinor":123456,"xlsxExpenseMinor":47039,"pdfPages":len(pdf.pages),"pdfNames":True,"imported":actual,"journalCount":8}
print(result)
(d/"validation.json").write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding="utf-8")
