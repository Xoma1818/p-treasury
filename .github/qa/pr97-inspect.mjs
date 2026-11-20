import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, extname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const work = dirname(import.meta.filename);
const app = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
const run = Date.now().toString();
const sources = resolve(work, "../..", "dist");
const override = !process.argv.includes("--packaged");
await mkdir(output, { recursive: true });
const listener = createServer();
await new Promise((ready, reject) => listener.once("error",reject).listen(0,"127.0.0.1",ready));
const {port} = listener.address();
await new Promise(ready=>listener.close(ready));
const data = join(work,"data-" + run);
const profile = join(work,"webview-" + run);
const proc = spawn(app, ["--data-dir=" + data], {
  cwd: dirname(app),
  env: {...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=" + port + " --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-features=CalculateNativeWinOcclusion",
    WEBVIEW2_USER_DATA_FOLDER: profile, PTREASURY_CBR_URL: "http://127.0.0.1:9", PTREASURY_UPDATE_URL: "http://127.0.0.1:9"},
  stdio: "ignore",
});
const wait = async (read, label, limit = 15000) => {
  const end = Date.now() + limit;
  let last;
  while (Date.now() < end) {
    try { last = await read(); if (last) return last; } catch (e) { last = String(e); }
    await sleep(150);
  }
  throw Error(label + ": " + JSON.stringify(last));
};
let client;
const errors = [];
const snapshots = [];
const files = new Set();
const events = new Map();
const cmds = new Map();
let id = 0;
function send(method,params={}) {
  return new Promise((ok,fail)=>{
    const request=++id;
    const timeout=setTimeout(()=>{cmds.delete(request);fail(Error("CDP timeout: "+method));},16000);
    cmds.set(request,{ok,fail,timeout});
    client.send(JSON.stringify({id:request,method,params}));
  });
}
async function evaluate(expression) {
  const response=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
  if(response.exceptionDetails) throw Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  return response.result.value;
}
async function click(selector, label="", scope="") {
  const match = "Array.from(document.querySelectorAll(" + JSON.stringify(scope?scope+" "+selector:selector) + ")).find(x=>x.getClientRects().length && !x.disabled && (!" + JSON.stringify(label) + " || x.textContent.trim().replace(/\\s+/g,' ') === " + JSON.stringify(label) + "))";
  const point = await wait(()=>evaluate("(()=>{const x="+match+";if(!x)return null;x.scrollIntoView({block:'nearest'});const r=x.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()"),"Не найдена кнопка "+selector+" "+label);
  await send("Input.dispatchMouseEvent",{...point,type:"mouseMoved"});
  await send("Input.dispatchMouseEvent",{...point,type:"mousePressed",button:"left",clickCount:1});
  await send("Input.dispatchMouseEvent",{...point,type:"mouseReleased",button:"left",clickCount:1});
}
const shot = async name => {
  if(process.argv.includes("--no-shots")) return;
  await sleep(280);
  const r=await send("Page.captureScreenshot",{format:"png"});
  await writeFile(join(output,name+".png"),Buffer.from(r.data,"base64"));
};
try {
  const url="http://127.0.0.1:"+port+"/json/list";
  const page=await wait(async()=>(await (await fetch(url)).json()).find(x=>x.type==="page"&&x.webSocketDebuggerUrl&&/^https?:\/\/tauri\.localhost\b/.test(x.url)),"Окно WebView2");
  client = new WebSocket(page.webSocketDebuggerUrl);
  client.addEventListener("message", ({data})=>{
    const e=JSON.parse(data);
    if(e.id&&cmds.has(e.id)){const item=cmds.get(e.id);cmds.delete(e.id);clearTimeout(item.timeout);if(e.error)item.fail(Error(JSON.stringify(e.error)));else item.ok(e.result);}
    if(e.method) events.get(e.method)?.(e.params);
  });
  await new Promise((ok,fail)=>{client.addEventListener("open",ok,{once:true});client.addEventListener("error",fail,{once:true});});
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.bringToFront").catch(()=>{});
  await wait(()=>evaluate("!!document.querySelector('h1') && document.readyState==='complete'"),"Готовность окна до проверки");
  events.set("Runtime.exceptionThrown",e=>errors.push(e.exceptionDetails.exception?.description ?? e.exceptionDetails.text));
  if (override) {
    const origin = new URL(page.url).origin;
    assert.match(origin,/^https?:\/\/tauri\.localhost$/,"ожидается локальный протокол тестового приложения");
    const contentTypes={".html":"text/html; charset=utf-8",".js":"text/javascript",".css":"text/css",".svg":"image/svg+xml",".png":"image/png",".woff2":"font/woff2"};
    events.set("Fetch.requestPaused", async e=>{
      try {
        const u=new URL(e.request.url);
        const name=u.pathname==="/"?"index.html":decodeURIComponent(u.pathname).slice(1);
        if(!/^(index\.html|assets\/[a-zA-Z0-9_.-]+)$/.test(name)) { await send("Fetch.continueRequest",{requestId:e.requestId}); return; }
        const body=await readFile(join(sources,name));
        files.add(name);
        await send("Fetch.fulfillRequest",{requestId:e.requestId,responseCode:200,responseHeaders:[{name:"Content-Type",value:contentTypes[extname(name)]??"application/octet-stream"},{name:"Cache-Control",value:"no-store"}],body:body.toString("base64")});
      } catch(err) {
        errors.push(String(err));
        await send("Fetch.failRequest",{requestId:e.requestId,errorReason:"Failed"}).catch(()=>{});
      }
    });
    await send("Fetch.enable",{patterns:[{urlPattern:origin+"/*"}]});
    await send("Page.reload",{ignoreCache:true});
  }
  await wait(()=>evaluate("!!document.querySelector('.onboarding-header')"),"Мастер запуска");
  await wait(()=>evaluate("!document.querySelector('[name=baseCurrency]')?.matches(':empty')"),"Список валют");
  await shot("00-first-run");
  await click("button","Посмотреть на примере");
  await wait(()=>evaluate("!!document.querySelector('.layout .sidebar')"),"Главная на тестовых данных");
  await shot("01-home");
  if(process.argv.includes("--showcase")) {
    await click(".sidebar button.nav-item","Бюджет");
    await click('[data-testid="budget-mode-year"]');
    await wait(()=>evaluate("document.querySelector('[data-testid=budget-mode-year]').getAttribute('aria-pressed')==='true'"),"Годовой вид бюджета");
    await shot("02-budget-year");
    await click(".sidebar button.nav-item","Операции");
    await shot("03-operations");
    process.exitCode=0;
  } else {
  if(override){
    assert.ok(files.has("index.html"));
    assert.ok([...files].some(x=>x.endsWith(".css")));
  }
  const screens = process.argv.includes("--all") ? ["Главная","Операции","Бюджет","Отчёты","Займы и долги","Счета","Категории","Заметки","Настройки","Взгляд вперёд","Календарь"] : ["Главная","Операции","Бюджет","Взгляд вперёд"];
  for (const [index,title] of screens.entries()) {
    console.log("Проверка: " + title);
    await click(".sidebar button.nav-item",title);
    await wait(()=>evaluate("document.querySelector('main h1')?.textContent.trim() === "+JSON.stringify(title)),"Открыть "+title);
    await sleep(250);
    const s=await evaluate("(()=>{const main=document.querySelector('main');return {title:main.querySelector('h1').textContent,viewport:innerWidth,width:document.documentElement.scrollWidth,mainWidth:main.clientWidth,mainScroll:main.scrollWidth,buttons:[...main.querySelectorAll('button')].filter(b=>b.getClientRects().length).length};})()");
    assert.ok(s.width <= s.viewport && s.mainScroll <= s.mainWidth + 1, "Переполнение " + title);
    snapshots.push(s);
    if (index < 2 || title === "Бюджет") await shot(String(index+1).padStart(2,"0")+"-screen");
  }
  await click(".sidebar button.nav-item","Бюджет");
  const segment=await wait(()=>evaluate("Boolean(document.querySelector('[data-testid=budget-mode] .tab.active'))"),"Переключатель бюджета");
  const readSegment="(()=>{const g=document.querySelector('[data-testid=budget-mode]');const a=g.querySelector('.active');const p=getComputedStyle(g,'::before');const r=g.getBoundingClientRect();return {text:a.textContent.trim(),width:r.width,pill:p.transform,duration:p.transitionDuration,shadow:getComputedStyle(a).boxShadow};})()";
  const before=await evaluate(readSegment);
  await click("button.tab:not(.active)","", "[data-testid=budget-mode]");
  await sleep(350);
  const after=await evaluate(readSegment);
  assert.notEqual(after.text,before.text);
  assert.notEqual(after.pill,before.pill);
  assert.ok(Math.abs(after.width-before.width)<.1, "Ширина переключателя не должна меняться");
  assert.equal(after.shadow,"none");
  assert.ok(await evaluate("!document.querySelector('[data-testid=month-review-open]') && !document.querySelector('[data-testid=budget-month]')"));
  await shot("12-budget-year");
  await send("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]});
  const reduced=await evaluate(readSegment);
  assert.equal(reduced.duration,"0s");
  await send("Emulation.setEmulatedMedia",{features:[]});
  await click(".sidebar button.nav-item","Операции");
  await click('[data-testid="filters-toggle"]');
  assert.ok(await evaluate("document.querySelector('[data-testid=filters-toggle]').getAttribute('aria-expanded')==='true'"));
  await shot("13-operation-filters");
  await click('[data-testid="txn-import"]');
  await wait(()=>evaluate("Boolean(document.querySelector('[role=dialog]'))"),"Импорт");
  await shot("14-import");
  await send("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
  await send("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
  await wait(()=>evaluate("!document.querySelector('[role=dialog]')"),"Закрытие импорта клавишей Escape");
  await click('button[data-testid="theme-light"]');
  await wait(()=>evaluate("document.documentElement.dataset.theme==='light'"),"Светлая тема");
  await shot("15-operations-light");
  await send("Emulation.setDeviceMetricsOverride",{width:1024,height:720,deviceScaleFactor:1,mobile:false});
  for(const title of screens){
    console.log("1024 px: " + title);
    await click(".sidebar button.nav-item",title);
    await wait(()=>evaluate("document.querySelector('main h1')?.textContent.trim() === "+JSON.stringify(title)),"Узкий экран "+title);
    assert.ok(await evaluate("document.documentElement.scrollWidth<=innerWidth"),"Переполнение при 1024 px: "+title);
  }
  console.log(JSON.stringify({app:basename(app),data,override,files:[...files],screens:snapshots,segment:{before,after,reduced},errors},null,2));
  }
} catch (e) {
  console.error(e,JSON.stringify({data,files:[...files],screens:snapshots,errors},null,2));
  if (client?.readyState===WebSocket.OPEN) await shot("failure").catch(()=>{});
  process.exitCode=1;
} finally {
  client?.close();
  proc.kill();
}
