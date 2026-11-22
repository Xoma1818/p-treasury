import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const output = process.env.KAZNA_QA_OUTPUT ?? "qa-linux-repeat";

export async function snapshot(browser, step, field) {
  const description = await browser.execute((select) => {
    const rect = el => { const b = el.getBoundingClientRect(); return [b.x,b.y,b.width,b.height].map(Math.round); };
    const info = el => {
      if (!el) return null;
      const css = getComputedStyle(el);
      return { tag:el.tagName, id:el.id, name:el.getAttribute("name"), classes:el.className, role:el.getAttribute("role"),
        test:el.dataset.testid, rect:rect(el), visible:css.visibility, display:css.display, opacity:css.opacity, position:css.position,
        z:css.zIndex, pointer:css.pointerEvents, overflowY:css.overflowY, scroll:el.scrollTop, scrollHeight:el.scrollHeight };
    };
    const b = select.getBoundingClientRect(), x = Math.floor(b.x + b.width/2), y = Math.floor(b.y + b.height/2);
    const parents=[];
    for(let e=select;e;e=e.parentElement) parents.push(info(e));
    return { viewport:[innerWidth,innerHeight], dpr:devicePixelRatio, center:[x,y], value:select.value,
      focused:info(document.activeElement), documentFocus:document.hasFocus(), parents,
      hit:document.elementsFromPoint(x,y).map(info), dialogs:[...document.querySelectorAll('[role=dialog],[role=menu]')].map(info) };
  }, field);
  console.log(step, JSON.stringify(description));
  await writeFile(join(output,step+".json"),JSON.stringify(description,null,2));
  await browser.saveScreenshot(join(output,step+"-web.png"));
  for(const [cmd,args,file] of [["xdotool",["getwindowfocus","getwindowname"],"focus"],["xwininfo",["-root","-tree"],"windows"]]) {
    try { await writeFile(join(output,step+"-"+file+".txt"),execFileSync(cmd,args)); } catch(e) { console.log(cmd,e.message); }
  }
  const scrot=spawnSync("scrot",["-o",join(output,step+"-x11.png")]);
  if(scrot.status!==0) console.log("scrot",scrot.status,scrot.stderr?.toString());
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  await mkdir(output,{recursive:true});
  const original = await readFile("e2e/repeat-and-cover.test.mjs","utf8");
  const anchor = '  await repeat.scrollIntoView({ block: "center" });\n  await repeat.waitForClickable();';
  if (original.split(anchor).length !== 2) throw Error("frequency test changed");
  const start = '  await snapshot(browser,"MODE-before-scroll",await repeat);\n';
  const before = `  await repeat.scrollIntoView({ block:"center" });
  await snapshot(browser,"pointer-after-scroll",await repeat);
  try { await repeat.waitForClickable(); } catch(e) { await snapshot(browser,"pointer-failed",await repeat); throw e; }`;
  const keyboard = `  const title = browser.$('[data-testid="repeat-plan-form"] input[name="reminderTitle"]');
  await title.click();
  const visited=[];
  for(let i=0;i<12;i++){
    const active=await browser.execute(()=>[document.activeElement?.tagName,document.activeElement?.name,document.activeElement?.getAttribute("data-testid")]);
    visited.push(active);
    if(active[1]==="repeat") break;
    await browser.keys(Key.Tab);
  }
  console.log("real tab order",JSON.stringify(visited));
  await snapshot(browser,"keyboard-focused",await repeat);
  assert.equal(visited.at(-1)[1],"repeat","клавиатура достигает списка");`;
  let keyboardPassed=false;
  for(const [mode,attempt] of [["pointer",before],["keyboard",keyboard]]) {
    const copy='import {snapshot} from "./qa-linux-repeat.mjs";\n'+original.replace(anchor,start.replace("MODE",mode)+attempt);
    const path="e2e/.qa-repeat-"+mode+".mjs";
    await writeFile(path,copy);
    const result=spawnSync(process.execPath,["--test","--test-reporter=tap","--test-name-pattern=Повтор дохода",path],{encoding:"utf8",maxBuffer:8*1024*1024});
    process.stdout.write(result.stdout??""); process.stderr.write(result.stderr??"");
    await writeFile(join(output,mode+".tap"),(result.stdout??"")+(result.stderr??""));
    console.log(mode,"exit",result.status);
    if(mode==="keyboard") keyboardPassed=result.status===0;
  }
  process.exitCode=keyboardPassed?0:1;
}
