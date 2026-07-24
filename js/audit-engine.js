import {ext,resolve,norm} from './project-engine.js';
const textExt=new Set(['html','htm','css','js','mjs','jsx','tsx','ts','json','txt','md','xml','py','php','java','c','cpp','cs','sql']);
const sevWeight={critical:25,error:14,warning:6,info:1};
function finding(severity,title,plain,technical,file='',line=null){return{severity,title,plain,technical,file,line}}
function lineOf(text,index){return text.slice(0,index).split('\n').length}
function addUnique(out,item){const key=`${item.file}|${item.line||''}|${item.title}`;if(!out.some(x=>`${x.file}|${x.line||''}|${x.title}`===key))out.push(item)}

function commentsOnly(text){
  return [...text.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g)].map(m=>({text:m[0],index:m.index}));
}

function stripNestedAtRules(text){const chars=[...text],re=/@(media|supports|container|layer|keyframes|-webkit-keyframes)\b[^{}]*\{/gi;let m;while((m=re.exec(text))){let depth=0,end=m.index;for(let i=m.index;i<text.length;i++){if(text[i]==='{')depth++;else if(text[i]==='}'){depth--;if(depth===0){end=i+1;break}}}for(let i=m.index;i<end;i++)chars[i]=' ';re.lastIndex=end}return chars.join('')}

export async function auditProject(files,meta,runtimeErrors=[],compileErrors=[]){
  const findings=[],good=[];let codeFiles=0,totalBytes=0;const texts=new Map();
  for(const [name,file] of files){
    totalBytes+=file.size;
    if(!textExt.has(ext(name)))continue;
    codeFiles++;let text='';
    try{text=await file.text()}catch{continue}
    texts.set(name,text);
    const e=ext(name);
    if(/html?/.test(e))auditHtml(name,text,findings,good);
    if(e==='css')auditCss(name,text,findings,good);
    if(['js','mjs','jsx','tsx','ts'].includes(e))auditJs(name,text,findings,good);
    auditGeneral(name,text,findings);
  }
  auditProjectLinks(files,texts,findings,good);
  auditCrossFileIds(texts,findings);
  runtimeErrors.forEach(x=>addUnique(findings,finding('error','The page hit a running error','Something on the page failed while it was actually running. That can make a button, screen, or background task stop working.',`${x.message||'Runtime error'} at ${x.line||'?'}:${x.col||'?'}`,'runtime',x.line||null)));
  (compileErrors||[]).forEach(x=>addUnique(findings,finding('error','A file could not be compiled','One of the source files could not be converted to code the browser understands. The preview may be blank or broken.',x.message||'Compile error',x.file||'unknown')));
  if(!runtimeErrors.length)good.push('No browser runtime crashes were captured during this preview.');
  if(meta.pageCount>0)good.push(`Found ${meta.pageCount} page${meta.pageCount===1?'':'s'} that can be reconstructed for preview.`);
  const penalty=findings.reduce((n,f)=>n+(sevWeight[f.severity]||0),0);
  const score=Math.max(0,Math.min(100,100-penalty));
  const verdict=score>=90?'Looks strong':score>=75?'Mostly healthy':score>=55?'Needs attention':'Not ready yet';
  return{id:crypto.randomUUID(),createdAt:new Date().toISOString(),meta:{...meta,codeFiles,totalBytes},score,verdict,findings,good,runtimeErrors};
}

function auditHtml(name,text,out,good){
  const ids={};
  for(const m of text.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)){ids[m[1]]=(ids[m[1]]||[]).concat(lineOf(text,m.index))}
  Object.entries(ids).forEach(([id,lines])=>{if(lines.length>1)addUnique(out,finding('error','The same page ID is used more than once',`More than one part of this page is called "${id}". That can make a button or style target the wrong thing.`,`Duplicate id="${id}" on lines ${lines.join(', ')}`,name,lines[0]))});
  const imgs=[...text.matchAll(/<img\b[^>]*>/gi)],missing=imgs.filter(m=>!/^.*\balt\s*=/.test(m[0]));
  if(missing.length)addUnique(out,finding('warning','Some images are missing descriptions',`${missing.length} image${missing.length===1?' is':'s are'} missing an alt description.`,`Missing alt attributes: ${missing.length}`,name,lineOf(text,missing[0].index)));
  else if(imgs.length)good.push(`${name}: image descriptions are present.`);
  if(/<font\b|<center\b|<marquee\b|<frameset\b/i.test(text))addUnique(out,finding('warning','Old HTML is still being used','This page uses older browser tags. Modern code is easier to maintain and less likely to behave differently between browsers.','Deprecated HTML tags detected.',name));
  const styles=[...text.matchAll(/<style\b/gi)];
  if(styles.length>1)addUnique(out,finding('warning','The page has several separate style blocks',`This page has ${styles.length} separate style sections. That often means old fixes were stacked on top of each other instead of being cleaned up.`,`${styles.length} <style> blocks`,name,lineOf(text,styles[1].index)));
  for(const m of text.matchAll(/<form\b([^>]*)>/gi)){if(!/\baction\s*=|\bonsubmit\s*=|\bdata-action\s*=/i.test(m[1]))addUnique(out,finding('warning','A form has no clear submit destination','This form may look usable but does not clearly say what should happen when it is submitted.','Form has no action, onsubmit, or data-action attribute.',name,lineOf(text,m.index)))}
  const inputs=[...text.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)];let unlabeled=0,firstLine=null;
  for(const m of inputs){const tag=m[0];if(/type\s*=\s*["']?(hidden|button|submit)/i.test(tag))continue;const id=(tag.match(/\bid\s*=\s*["']([^"']+)/i)||[])[1];const hasAria=/\baria-label\s*=|\baria-labelledby\s*=/i.test(tag);const hasLabel=id&&new RegExp(`<label[^>]+for=["']${id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}["']`,'i').test(text);if(!hasAria&&!hasLabel){unlabeled++;firstLine??=lineOf(text,m.index)}}
  if(unlabeled)addUnique(out,finding('warning','Some form fields do not have clear labels',`${unlabeled} field${unlabeled===1?' does':'s do'} not have a connected label. That can make the page harder to understand and use.`,`${unlabeled} unlabeled input/select/textarea controls`,name,firstLine));
}

function auditCss(name,text,out,good){
  const opens=(text.match(/\{/g)||[]).length,closes=(text.match(/\}/g)||[]).length;
  if(opens!==closes)addUnique(out,finding('critical','The stylesheet has an unmatched bracket','Part of the design code may stop working because an opening and closing bracket do not match.',`${opens} opening braces vs ${closes} closing braces`,name));
  const important=(text.match(/!important/g)||[]).length;
  if(important>10)addUnique(out,finding('warning','The design code is forcing too many styles',`There are ${important} "force this style" rules. Too many can make future changes fight each other.`,`${important} !important declarations`,name));
  const selectorText=stripNestedAtRules(text);const selectors={};
  for(const m of selectorText.matchAll(/(^|\})\s*([^@}{][^{]+)\{/gm)){const s=m[2].trim().replace(/\s+/g,' ');if(!s||s.startsWith('from')||s.startsWith('to'))continue;selectors[s]=(selectors[s]||0)+1}
  const dup=Object.entries(selectors).filter(([,n])=>n>1);
  if(dup.length)addUnique(out,finding('warning','Some styles are defined more than once',`${dup.length} design rule${dup.length===1?' is':'s are'} repeated. The last copy may silently override the earlier one.`,dup.slice(0,12).map(([s,n])=>`${s} (${n}x)`).join('\n'),name));
  else good.push(`${name}: no repeated top-level selectors were detected.`);
  const stale=[...text.matchAll(/\/\*[^*]*(patch|hotfix|legacy|old version|temporary fix|remove me|deprecated)[^*]*\*\//gi)];
  if(stale.length)addUnique(out,finding('warning','Old fix markers are still in the design code','The stylesheet contains comments that look like old patches or temporary fixes. Those areas are worth cleaning before more changes are added.',stale.slice(0,8).map(m=>m[0].slice(0,100)).join('\n'),name,lineOf(text,stale[0].index)));
}

function auditJs(name,text,out,good){
  const funcs={};
  for(const m of text.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)){funcs[m[1]]=(funcs[m[1]]||[]).concat(lineOf(text,m.index))}
  const dup=Object.entries(funcs).filter(([,v])=>v.length>1);
  if(dup.length)addUnique(out,finding('error','Some functions are defined more than once','The program has functions with the same name in multiple places. One version can quietly replace another.',dup.map(([n,l])=>`${n}: lines ${l.join(', ')}`).join('\n'),name,dup[0][1][0]));
  else good.push(`${name}: no obvious duplicate named functions were detected.`);
  if(/^\s*debugger;?\s*$/m.test(text))addUnique(out,finding('warning','A debugging stop was left in the code','The program can pause unexpectedly because a developer debugging instruction is still present.','debugger statement detected',name));
  const logs=(text.match(/console\.log\s*\(/g)||[]).length;
  if(logs>8)addUnique(out,finding('info','There are many developer console messages',`${logs} console messages are still in this file. That may be intentional, but production code is usually quieter.`,`${logs} console.log calls`,name));
  const sw=text.match(/navigator\.serviceWorker\.register\s*\(/);
  if(sw)addUnique(out,finding('info','This project installs a browser cache worker','A service worker can be useful, but it can also make an old version keep appearing after code changes. Clear or update its cache rules when testing changes.','navigator.serviceWorker.register detected',name,lineOf(text,sw.index)));
  const stale=commentsOnly(text).filter(m=>/(patch|hotfix|legacy|old version|temporary fix|remove me|deprecated)/i.test(m.text));
  if(stale.length)addUnique(out,finding('warning','Old fix markers are still in the program code','Some comments look like old patches or temporary fixes. Check those areas so dead code does not keep building up.',stale.slice(0,8).map(m=>m.text.slice(0,100)).join('\n'),name,lineOf(text,stale[0].index)));
}

function auditGeneral(name,text,out){
  const comments=commentsOnly(text);
  const marks=[['TODO','A TODO note was left in the source'],['FIXME','A FIXME note was left in the source'],['DO NOT SHIP','A do-not-ship warning was left in the source']];
  for(const [token,title] of marks){const hit=comments.find(c=>c.text.includes(token));if(hit)addUnique(out,finding('warning',title,'A developer note says this area may still need work.',`Found ${token}`,name,lineOf(text,hit.index)))}
  if(/api[_-]?key\s*[:=]\s*["'][A-Za-z0-9_\-]{16,}/i.test(text))addUnique(out,finding('critical','A secret key may be written directly in the source','A private key appears to be saved inside a code file. Anyone who gets the file could potentially see it.','Possible hard-coded API key pattern detected.',name));
}

function auditProjectLinks(files,texts,out,good){
  let missing=0,first=null;const names=new Set(files.keys());
  for(const [name,text] of texts){
    if(!/\.html?$/i.test(name))continue;
    for(const m of text.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)){
      const ref=m[1];
      if(!ref||/^(https?:|data:|blob:|mailto:|tel:|javascript:|#|\/\/)/i.test(ref))continue;
      const resolved=norm(resolve(name,ref));
      if(!names.has(resolved)){missing++;first??={name,line:lineOf(text,m.index),ref,resolved}}
    }
  }
  if(missing&&first)addUnique(out,finding('error','Some local files cannot be found',`${missing} local file reference${missing===1?' points':'s point'} to a file that is not present in the uploaded project. That can cause missing images, styles, scripts, or pages.`,`First missing reference: ${first.ref} -> ${first.resolved}`,first.name,first.line));
  else if(texts.size)good.push('Local HTML file references look connected to files that were included in the project.');
}

function auditCrossFileIds(texts,out){
  const htmlIds=new Set();
  for(const [name,text] of texts){if(!/\.html?$/i.test(name))continue;for(const m of text.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi))htmlIds.add(m[1])}
  let missing=0,first=null;
  for(const [name,text] of texts){
    if(!/\.(js|mjs|jsx|tsx|ts)$/i.test(name))continue;
    for(const m of text.matchAll(/getElementById\(\s*["']([\w-]+)["']\s*\)/g)){
      if(!htmlIds.has(m[1])&&!new RegExp(`id\\s*=\\s*["']${m[1]}["']`).test(text)){missing++;first??={name,line:lineOf(text,m.index),id:m[1]}}
    }
  }
  if(missing&&first)addUnique(out,finding('warning','Some code looks for page parts that were not found',`${missing} JavaScript reference${missing===1?' is':'s are'} looking for an ID that was not found in the uploaded HTML. Some may be created later by the app, so this should be checked rather than blindly changed.`,`First missing getElementById reference: ${first.id}`,first.name,first.line));
}

export function compareAudits(previous,current){
  if(!previous)return null;
  const delta=current.score-previous.score;
  const prevKeys=new Set(previous.findings.map(f=>`${f.file}|${f.title}|${f.line||''}`));
  const curKeys=new Set(current.findings.map(f=>`${f.file}|${f.title}|${f.line||''}`));
  const fixed=[...prevKeys].filter(k=>!curKeys.has(k));
  const added=[...curKeys].filter(k=>!prevKeys.has(k));
  let recommendation='The new version is the better starting point.';
  if(delta<-5||added.length>fixed.length+3)recommendation='The previous version looks safer. Start from the previous version and reapply the new changes more carefully.';
  else if(Math.abs(delta)<=3)recommendation='The versions are close. Keep the one with the features and design you prefer, then fix the remaining issues.';
  return{delta,fixedCount:fixed.length,newIssueCount:added.length,recommendation,previousScore:previous.score,currentScore:current.score};
}