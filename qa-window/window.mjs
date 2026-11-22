import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {dirname, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const testProfiles=new Set();
export async function launch(label,previous=null) {
  const exe = resolve(process.env.PTREASURY_BIN);
  if(previous&&!testProfiles.has(previous))throw Error('Only a test profile created by this process may reopen');
  const data = previous??await mkdtemp(join(tmpdir(), 'kazna-ux039-' + label + '-'));
  testProfiles.add(data);
  const output = resolve('.test-artifacts/ux039-qa', process.env.PTREASURY_QA_EVIDENCE || 'evidence');
  await mkdir(output,{recursive:true});
  const server=createServer();
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const port=server.address().port;
  await new Promise(done=>server.close(done));
  const child=spawn(exe,['--data-dir='+data],{cwd:dirname(exe),stdio:'ignore',env:{
    ...process.env,PTREASURY_CBR_URL:'http://127.0.0.1:9', PTREASURY_UPDATE_URL:'http://127.0.0.1:9',
    WEBVIEW2_USER_DATA_FOLDER:join(data,'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--test-type=webdriver --remote-debugging-port='+port+' --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-features=CalculateNativeWinOcclusion'+(process.env.KAZNA_QA_SOFTWARE_RENDERING?' --disable-gpu --disable-gpu-compositing':'')
  }});
  let ws;
  const close=()=>{ws?.close(); if(child.exitCode===null)child.kill();};
  const until=async (fn,name)=>{
    for(let i=0;i<(name==='test WebView'?900:160);i++){
      if(child.exitCode!==null) throw Error('Kazna exited '+child.exitCode);
      const value=await fn(); if(value)return value; await delay(90);
    }
    throw Error('Timed out: '+name);
  };
  let id=0;
  try{
    const page=await until(async()=>{try{return(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(x=>x.type==='page');}catch{return null;}},'test WebView');
    ws=new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((ok,bad)=>{ws.addEventListener('open',ok,{once:true});ws.addEventListener('error',bad,{once:true});});
    ws.addEventListener('close',event=>console.log('Test WebView connection closed',event.code,event.reason));
    ws.addEventListener('error',event=>console.error('Test WebView connection error',event.message));
    child.once('exit',(code,signal)=>console.log('Test window exit',code,signal));
    const command=(method,params={})=>new Promise((ok,bad)=>{
      if(ws.readyState!==WebSocket.OPEN){bad(Error('WebView connection closed, pid '+child.pid+', temporary profile '+data));return;}
      const current=++id;
      if(process.env.PTREASURY_QA_TRACE)console.log(current,method,(params.expression||JSON.stringify(params)).slice(0,95));
      const trace=new Error('timeout '+method+' '+(params.expression?.slice(0,200)??''));
      const timer=setTimeout(async()=>{ws.removeEventListener('message',receive);const remote=await fetch('http://127.0.0.1:'+port+'/json/list',{signal:AbortSignal.timeout(1000)}).then(r=>r.json()).then(x=>x.map(t=>[t.type,t.id,t.url])).catch(e=>String(e));console.error('WebView state',ws.readyState,'native exit',child.exitCode,'targets',JSON.stringify(remote));bad(trace);},15000);
      function receive(e){const r=JSON.parse(e.data);if(r.id!==current)return;clearTimeout(timer);ws.removeEventListener('message',receive);r.error?bad(Error(JSON.stringify(r.error))):ok(r.result);}
      ws.addEventListener('message',receive);ws.send(JSON.stringify({id:current,method,params}));
    });
    const run=async(fn,...args)=>{
      const r=await command('Runtime.evaluate',{expression:'('+String(fn)+').apply(null,'+JSON.stringify(args)+')',returnByValue:true,awaitPromise:true});
      if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };
    const invoke=(cmd,args={})=>run((cmd,args)=>window.__TAURI_INTERNALS__.invoke(cmd,args),cmd,args);
    const visible=(sel)=>until(()=>run(s=>!!document.querySelector(s)?.getClientRects().length,sel),sel);
    const txt=(sel)=>run(s=>document.querySelector(s)?.innerText||'',sel);
    const contains=(sel,needle)=>until(async()=>(await txt(sel)).includes(needle),sel+' '+needle);
    const press=(text,region='body')=>until(()=>run((t,s)=>{
      const button=[...(document.querySelector(s)?.querySelectorAll('button,[role=menuitem]')??[])].find(b=>b.textContent.trim()===t&&b.getClientRects().length&&!b.disabled);
      if(!button)return false;button.click();return true;
    },text,region),'click '+text+' '+region);
    const choose=(sel,value)=>until(()=>run((s,v)=>{const e=document.querySelector(s);if(!e||e.disabled||![...e.options].some(o=>o.value===v))return false;e.value=v;e.dispatchEvent(new Event('change',{bubbles:true}));return true;},sel,value),'select '+sel);
    const click=(sel)=>until(()=>run(s=>{const el=document.querySelector(s);if(!el||!el.getClientRects().length||el.disabled)return false;el.click();return true;},sel),sel);
    const key=async(key,modifiers=0)=>{const [code,vk]=({Enter:['Enter',13],Tab:['Tab',9],Escape:['Escape',27],Home:['Home',36],End:['End',35],ArrowRight:['ArrowRight',39],ArrowLeft:['ArrowLeft',37],ArrowDown:['ArrowDown',40],ArrowUp:['ArrowUp',38],Space:['Space',32],h:['KeyH',72]})[key];const ev={key:key==='Space'?' ':key,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk,modifiers};const printable=key==='Enter'?'\r':key==='Space'?' ':null;await command('Input.dispatchKeyEvent',printable?{...ev,type:'keyDown',text:printable,unmodifiedText:printable}:{...ev,type:'rawKeyDown'});await command('Input.dispatchKeyEvent',{...ev,type:'keyUp'});};
    const focus=sel=>run(s=>document.querySelector(s)?.focus(),sel);
    const focused=()=>run(()=>document.activeElement?.textContent?.trim().slice(0,100)||document.activeElement?.tagName);
    const shot=async(name)=>{await delay(280);const s=await command('Page.captureScreenshot',{format:'png',fromSurface:true});await writeFile(join(output,label+'-'+name+'.png'),Buffer.from(s.data,'base64'));};
    const evidence=async(result)=>writeFile(join(output,label+'.json'),JSON.stringify({exe,data,sha:process.env.PTREASURY_PR_SHA,softwareRendering:Boolean(process.env.KAZNA_QA_SOFTWARE_RENDERING),...result},null,2));
    const narrow=async()=>{
      if(process.env.KAZNA_QA_DEFAULT_SIZE)return run(()=>({width:innerWidth,height:innerHeight,scale:devicePixelRatio,outerWidth,outerHeight}));
      execFileSync('pwsh.exe',['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./resize-window.ps1',import.meta.url)),'-TargetProcess',String(child.pid)],{windowsHide:true,timeout:20000});
      await delay(300);
      const size=await run(()=>({width:innerWidth,height:innerHeight,scale:devicePixelRatio,outerWidth,outerHeight}));
      assert.ok(size.width>=1000&&size.width<=1040,'native window at minimum width '+JSON.stringify(size));
      return size;
    };
    if(!previous) {
      await contains('body','Основная валюта');
      if (process.env.KAZNA_QA_CLEAN === '1') {
        const date=(await invoke('app_info')).today;
        await invoke('finish_onboarding',{setup:{baseCurrency:'RUB',defaultCategories:true,accounts:[
          {name:'Карта для проверки',type:'debit',currencyCode:'RUB',openingBalance:8000000,openingDate:date,creditLimit:null,includeInTotal:true}
        ]}});
        await invoke('set_setting',{key:'home_layout',value:JSON.stringify({order:[],hidden:[]})});
        await command('Page.reload',{ignoreCache:true});
      } else await press('Посмотреть на примере');
    }
    await contains('main h1','Главная');
    const today=(await invoke('app_info')).today;
    const plus=(n)=>{const d=new Date(today+'T12:00');d.setDate(d.getDate()+n);return d.toLocaleDateString('sv-SE');};
    const cats=await invoke('list_categories',{includeArchived:false});
    const newAcc=(name)=>invoke('create_account',{input:{name,type:'debit',currencyCode:'RUB',openingBalance:500000000,openingDate:plus(-8),creditLimit:null,includeInTotal:true}});
    const txn=(id,amount,payee,categoryId,date=today)=>invoke('create_transaction',{eventId:null,input:{type:'expense',date,accountId:id,amount,categoryId,payee,toAccountId:null,toAmount:null,note:null}});
    const count=async(id)=>(await invoke('list_transactions',{filter:{accountId:id,types:['expense'],limit:5}})).total;
    const bal=async(id)=>(await invoke('list_accounts',{includeArchived:false})).find(a=>a.id===id).balance;
    const nav=async(name)=>{await press(name,'nav');await contains('main h1',name);};
    const refresh=async()=>{await run(()=>{document.documentElement.dataset.beforeFixtureReload='1';});await command('Page.reload',{ignoreCache:true});await until(async()=>{try{return await run(()=>!document.documentElement.dataset.beforeFixtureReload&&document.querySelector('main h1')?.textContent.includes('Главная'));}catch{return false;}},'application loads seeded data');};
    const restart=async()=>{const exited=new Promise(resolve=>child.once('exit',resolve));const ok=execFileSync('pwsh.exe',['-NoProfile','-NonInteractive','-Command','(Get-Process -Id '+child.pid+').CloseMainWindow()'],{windowsHide:true,timeout:8000,encoding:'utf8'});assert.ok(ok.trim().toLowerCase()==='true');const code=await Promise.race([exited,delay(5000,'timeout',{ref:false})]);assert.equal(code,0);return launch(label,data);};
    return {exe,data,output,pid:child.pid,close,until,run,command,invoke,visible,txt,contains,press,choose,click,key,focus,focused,shot,evidence,narrow,today,plus,cats,newAcc,txn,count,bal,nav,refresh,restart};
  }catch(e){close();throw e;}
}

