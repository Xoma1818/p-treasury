import assert from "node:assert/strict";
import fs from "node:fs";
import {join} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";
import {start,stop,openSection,openSettings,selectTheme,clickControl} from "./app.mjs";
const [dir,out]=process.argv.slice(2);
const report={routes:[],exceptions:[],renderedDisagreements:[],noGlyphs:[]};
let b;
async function cdp(cmd,params={}){
  const response=await fetch("http://127.0.0.1:4444/session/"+b.sessionId+"/ms/cdp/execute",{
    method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({cmd,params})});
  const body=await response.json();
  assert.ok(response.ok&&body.value&&!body.value.error,cmd+" "+JSON.stringify(body));
  return body.value;
}
async function audit(theme,route){
  await sleep(280);
  const {measured,samples,mismatches}=await b.execute(()=>{
    for(const n of document.querySelectorAll("[data-type-witness]"))n.removeAttribute("data-type-witness");
    const groups=new Set(),samples=[],mismatches=[];
    let measured=0;
    for(const n of document.querySelectorAll("nav *,main *,[role=dialog] *,[role=listbox] *")){
      if(!n.getClientRects().length||getComputedStyle(n).visibility!=="visible")continue;
      if(n.closest("details:not([open])")&&!n.closest("summary"))continue;
      const text=Array.from(n.childNodes).filter(c=>c.nodeType===3).map(c=>c.textContent).join("").trim();
      if(!text||!/[а-яёA-Z0-9₽]/iu.test(text))continue;
      const css=getComputedStyle(n),family=css.fontFamily.split(",")[0].replace(/"/g,"");
      const tag=n.tagName.toUpperCase(),root=n.closest("[role=dialog]")?"окно":n.closest("nav")?"панель":"раздел";
      const role=n.getAttribute("role")||"";
      measured++;
      if(!/^Segoe UI Variable (Text|Display)$/i.test(family))mismatches.push({tag,text:text.slice(0,180),family});
      const key=[root,tag,family,role,/\d/.test(text),/[а-яё]/iu.test(text),css.fontWeight].join("|");
      if(groups.has(key))continue;
      groups.add(key);
      const id=String(samples.length);
      n.setAttribute("data-type-witness",id);
      samples.push({id,tag,root,role,text:text.slice(0,140),family});
    }
    return {measured,samples,mismatches};
  });
  assert.ok(measured>8,route+" "+measured);
  const {root}=await cdp("DOM.getDocument",{depth:0});
  const rows=[];
  for(const s of samples){
    const {nodeId}=await cdp("DOM.querySelector",{nodeId:root.nodeId,selector:'[data-type-witness="'+s.id+'"]'});
    if(!nodeId){report.noGlyphs.push({theme,route,...s,vanished:true});continue;}
    const {fonts}=await cdp("CSS.getPlatformFontsForNode",{nodeId});
    const used=fonts.filter(f=>f.glyphCount>0);
    if(!used.length){report.noGlyphs.push({theme,route,...s});continue;}
    const variant=s.family.endsWith("Display")?"Display":"Text";
    if(!used.some(f=>new RegExp("Segoe.*Variable.*"+variant,"i").test(f.familyName+" "+f.postScriptName))){
      report.renderedDisagreements.push({theme,route,...s,used});
    }
    rows.push({...s,used});
  }
  report.exceptions.push(...mismatches.map(x=>({theme,route,...x})));
  report.routes.push({theme,route,cssTextNodes:measured,renderedSamples:rows});
  console.log(theme,route,measured,rows.length);
}
try{
  ({browser:b}=await start(dir,{homeDefaults:true,verboseDriver:false}));
  await b.$("main h1").waitForDisplayed();
  await cdp("DOM.enable");await cdp("CSS.enable");
  const sections=await b.execute(()=>Array.from(document.querySelectorAll("nav button[data-section]"),n=>n.getAttribute("aria-label")));
  assert.equal(sections.length,11);
  for(const theme of ["light","dark"]){
    await selectTheme(b,theme);
    assert.equal(await b.execute(()=>document.documentElement.dataset.theme),theme);
    for(const section of sections){
      await openSection(b,section);
      const active=await b.$("nav button[aria-current=page]").getAttribute("aria-label");
      assert.equal(active,section);await audit(theme,section);
    }
    for(const topic of ["general","notifications","appearance","controls","data","about"]){
      await openSettings(b,topic);await audit(theme,"Настройки/"+topic);
    }
    const details=await b.$('[data-testid="about-details"]');
    if(await details.getAttribute("open")===null)await clickControl(b,await details.$("summary"),"Технические сведения");
    await details.$("dd").waitForDisplayed();await audit(theme,"О программе/Технические сведения");
    for(const id of ["hotkeys-open","open-palette"]){
      await clickControl(b,await b.$('[data-testid="'+id+'"]'),id);
      await b.$("[role=dialog]").waitForDisplayed();await audit(theme,id);
      await b.keys("Escape");await b.$("[role=dialog]").waitForExist({reverse:true});
    }
  }
  assert.deepEqual(report.exceptions,[],"CSS font exceptions");
  assert.deepEqual(report.renderedDisagreements,[],"Rendered font exceptions");
  report.success=true;
}catch(e){report.error=e.stack;throw e;}
finally{fs.writeFileSync(join(out,"typeface.json"),JSON.stringify(report));if(b)await stop(b);}
