import { beforeEach, afterEach } from 'node:test';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
const output=process.env.KAZNA_CONTROLS_OUT;
let test='подготовка';
const active=new Set();
const file=basename(process.argv[1]);
beforeEach(t=>{test=t.name;});
afterEach(async t=>{for(const b of active)await drain(b,t.name);});
function hook(){
 if(window.__kaInstalled)return;
 window.__kaInstalled=true;
 let store=[], sequence=0;
 window.__kaDrain=()=>store.splice(0);
 const term=e=>(e?.innerText||e?.textContent||'').replace(/\s+/g,' ').trim().slice(0,115);
 const get=e=>e?.getAttribute('data-testid')||'';
 const strip=f=>typeof f=='function'?Function.prototype.toString.call(f):'';
 const shot=()=>({screen:term(document.querySelector('main h1')),dialog:term([...document.querySelectorAll('[role=dialog]')].at(-1)?.querySelector('h2,h3,[role=heading]')),tabs:[...document.querySelectorAll('[aria-selected=true]')].map(term).slice(0,8),alert:term(document.querySelector('[role=alert],.error')),toast:term(document.querySelector('[data-testid=undo-bar]')),counts:[...document.querySelectorAll('main tbody')].slice(0,4).map(x=>x.rows.length)});
 const find=(el,p)=>el?.[Object.keys(el).find(k=>k.startsWith(p))];
 const observe=event=>{
  const el=event.target.closest?.('button,summary,a[href],[role=button],[role=tab],[role=menuitem],input,select,[tabindex],tr[data-testid]');
  if(!el)return;
  let fiber=find(el,'__reactFiber$');
  const props=find(el,'__reactProps$')||{};
  let component='';for(let f=fiber;f;f=f.return){if(typeof f.type==='function'){component=f.type.name;break;}}
  const signature=strip(event.type==='change'?props.onChange:props.onClick);
  const elState=()=>({pressed:el.getAttribute('aria-pressed'),selected:el.getAttribute('aria-selected'),expanded:el.getAttribute('aria-expanded'),checked:el.checked,open:el.tagName==='SUMMARY'?el.parentElement?.open:undefined});const seq=++sequence; const record={before:elState(),type:event.type,screen:term(document.querySelector('main h1')),tag:el.tagName,id:get(el),aria:el.getAttribute('aria-label'),title:el.title,name:el.name||'',label:term(el),role:el.getAttribute('role'),scope:get(el.parentElement?.closest('[data-testid]')),component,signature:signature.slice(0,1536),trusted:event.isTrusted,from:shot()};
  store.push(record);setTimeout(()=>{if(sequence!==seq)return;record.to=shot();if(el.isConnected)record.after=elState();},80);
 };
 document.addEventListener('click',observe,true);document.addEventListener('change',observe,true);
 window.addEventListener('error',e=>store.push({type:'error',message:e.message}));
 window.addEventListener('unhandledrejection',e=>store.push({type:'rejection',message:String(e.reason)}));
}
async function drain(b,name=test){
 try{const states=await b.execute(()=>window.__kaDrain?.()||[]);if(states.length)appendFileSync(join(output,file+'.jsonl'),JSON.stringify({test:name,states})+'\n');}catch{}
}
export async function connect(b){
 if(!output)return;mkdirSync(output,{recursive:true});
 const url='http://127.0.0.1:4444/session/'+b.sessionId+'/ms/cdp/execute';
 const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmd:'Page.addScriptToEvaluateOnNewDocument',params:{source:'('+hook.toString()+')()'}})});
 if(!r.ok)throw Error('CDP observer '+r.status);
 await b.execute(hook);active.add(b);
}
export async function disconnect(b){if(output&&active.delete(b))await drain(b);}

