import fs from 'node:fs';import path from 'node:path';import ts from 'typescript';
const db={};
for(const name of fs.readdirSync('e2e').filter(x=>x.endsWith('.test.mjs'))){
 const p=path.join('e2e',name),text=fs.readFileSync(p,'utf8'),ast=ts.createSourceFile(p,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),edits=[];db[name]={};
 function scan(n,inAsync){
  if(ts.isFunctionLike(n))inAsync=!!n.modifiers?.some(x=>x.kind===ts.SyntaxKind.AsyncKeyword);
  if(ts.isBlock(n)&&inAsync){
   for(const stmt of n.statements){
    if(!ts.isExpressionStatement(stmt)&&!ts.isVariableStatement(stmt))continue;
    const content=stmt.getText(ast).replace(/\s+/g,' ').trim();
    const hasAssert=/^(?:await (?:waitText|waitCount|waitContent|.*\.waitFor(?:Exist|Displayed|Enabled)|browser\.waitUntil)|assert\.(?:deepEqual|equal|notEqual|match|ok|throws|rejects|doesNotMatch|notDeepEqual))\(/.test(content);
    const hasAction=/^await (?:click(?:Control)?|choose(?:Like)?|openSection|openSettings|openFilters|openMore|save(?:HomeEditor)?|fill|setDate|onboard)\(|^await .*\.(?:click|doubleClick|selectByAttribute|selectByVisibleText|setValue|keys|refresh)\(/.test(content);
    if(!hasAction&&!hasAssert)continue;
    const loc=ast.getLineAndCharacterOfPosition(stmt.getStart(ast)),id=(loc.line+1)+':'+loc.character;
    db[name][id]={kind:hasAction?'action':'assert',text:content.slice(0,900)};
    edits.push([stmt.getStart(ast),'kaMark('+JSON.stringify(id)+',0); '],[stmt.getEnd(),'; kaMark('+JSON.stringify(id)+',1); ']);
   }
  }
  ts.forEachChild(n,k=>scan(k,inAsync));
 }scan(ast,false);
 let out=text;for(const [i,t] of edits.sort((a,b)=>b[0]-a[0]))out=out.slice(0,i)+t+out.slice(i);
 fs.writeFileSync(p,"import {mark as kaMark} from './audit.mjs';\n"+out);
}
fs.mkdirSync(process.env.KAZNA_CONTROLS_OUT,{recursive:true});
fs.writeFileSync(path.join(process.env.KAZNA_CONTROLS_OUT,'steps.json'),JSON.stringify(db));

