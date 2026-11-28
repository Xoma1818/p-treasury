import {existsSync,readFileSync,statSync} from "node:fs";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
export async function run(b,{assert,proof,act,btn,value,nav,wait,close,read,finances,shot}){
 const all=await read("list_debts");const d=all.find(x=>x.status==="active");
 const baseline=await finances(), me=async()=>(await read("get_settings")).loan_lender_name??"";
 const old=await me();
 const mark=(p,a,e,v)=>proof("ExportDialog",p,a,e,v);
 await nav("Займы и долги");await act('[data-testid="debt-row"][data-name="'+d.counterparty+'"]');
 const open=()=>btn("Скачать график");
 await open();await btn("Excel",true);await wait('[role="dialog"] h2',/Excel/);await btn("CSV",true);await wait('[role="dialog"] h2',/CSV/);await btn("PDF для подписи",true);await wait('[role="dialog"] h2',/PDF/);
 mark("78:14","Переключить Excel, CSV и PDF","Заголовок редактора принимает все три формата, PDF возвращает подписи", await b.$('[name="withSignatures"]').isSelected());
 await value("lenderName","Учебный займодавец");await close("Отмена");assert.equal(await me(),old);assert.deepEqual(await finances(),baseline);mark("106:10","Отменить экспорт с изменённым именем","Имя не записано и денежные данные сохранены", {previousName:old});
 const names=["no-signatures","signatures"],results=[];
 for(let i=0;i<2;i++){
   const path=join(process.env.KAZNA_CONTROLS_OUT,names[i]+".pdf");
   await open();if(!i)await act('[name="withSignatures"]');assert.equal(await b.$('[name="withSignatures"]').isSelected(),!!i);
   await value("lenderName","Учебный займодавец");await value("borrowerName","Учебный заёмщик");
   await b.execute(p=>window.__ptPick=[p],path);
   await close("Сохранить файл");await wait('[data-testid="export-status"]',/\.pdf/i);
   assert.ok(existsSync(path));assert.equal(readFileSync(path).subarray(0,4).toString(),"%PDF");
   const cmd=spawnSync("python",["-c","from pypdf import PdfReader;import sys;print('\\n'.join(p.extract_text() for p in PdfReader(sys.argv[1]).pages))",path],{encoding:"utf8",env:{...process.env,PYTHONIOENCODING:"utf-8"}});
   if(cmd.status!==0)throw Error(cmd.stderr||cmd.error?.message);
   assert.match(cmd.stdout,/Учебный займодавец/);assert.equal(cmd.stdout.includes("________"),!!i);
   results.push({file:names[i]+".pdf",bytes:statSync(path).size,signatureLines:(cmd.stdout.match(/_{8,}/g)||[]).length});
 }
 assert.deepEqual(await finances(),baseline);
 mark("68:6 92:12","Сохранить один PDF без подписей и один с подписями. Путь подставлен через тестовый ответ диалога","Оба PDF прочитаны независимым парсером. Подписи есть только во втором документе",results);
 await shot("export-verified");
}
