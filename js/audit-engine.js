import {ext,resolve,norm} from './project-engine.js';

const TEXT_EXTENSIONS=new Set(['html','htm','css','js','mjs','cjs','jsx','tsx','ts','json','txt','md','xml','svg','py','php','java','c','cpp','h','hpp','cs','sql']);
const CODE_EXTENSIONS=new Set(['js','mjs','cjs','jsx','tsx','ts']);
const SCORE_WEIGHT={critical:18,error:10,warning:4,info:0};
const CONFIDENCE_FACTOR={high:1,medium:.5,low:0};
const EXTERNAL_REF=/^(?:[a-z]+:|#|\/\/)/i;

function lineOf(text,index){return text.slice(0,Math.max(0,index||0)).split('\n').length}
function escapeRegExp(value){return String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}
function cleanRef(value){return String(value||'').split('#')[0].split('?')[0]}
function makeId(){return globalThis.crypto?.randomUUID?.()||`audit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`}
function commentsOnly(text){return [...String(text||'').matchAll(/<!--[\s\S]*?-->|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g)].map(m=>({text:m[0],index:m.index}))}
function stripJsStringsComments(text){
  const source=String(text||''),chars=[...source];
  let quote='',lineComment=false,blockComment=false;
  for(let i=0;i<source.length;i++){
    const ch=source[i],next=source[i+1];
    if(lineComment){if(ch==='\n')lineComment=false;else chars[i]=' ';continue}
    if(blockComment){chars[i]=ch==='\n'?'\n':' ';if(ch==='*'&&next==='/'){chars[i+1]=' ';blockComment=false;i++}continue}
    if(quote){
      chars[i]=ch==='\n'?'\n':' ';
      if(ch==='\\'){if(i+1<chars.length){chars[i+1]=source[i+1]==='\n'?'\n':' ';i++}continue}
      if(ch===quote)quote='';
      continue;
    }
    if(ch==='/'&&next==='/'){chars[i]=chars[i+1]=' ';lineComment=true;i++;continue}
    if(ch==='/'&&next==='*'){chars[i]=chars[i+1]=' ';blockComment=true;i++;continue}
    if(ch==='"'||ch==="'"||ch==='`'){chars[i]=' ';quote=ch;continue}
  }
  return chars.join('');
}
function finding(checkId,severity,confidence,title,plain,technical,file='',line=null,scoreImpact=true){
  return{checkId,severity,confidence,title,plain,technical,file,line,scoreImpact};
}
function addFinding(ctx,item){
  const key=`${item.checkId}|${item.file}|${item.line||''}|${item.title}`;
  if(ctx.keys.has(key))return;
  ctx.keys.add(key);
  ctx.findings.push(item);
  ctx.failedChecks.add(item.checkId);
  if(item.confidence==='low'||item.scoreImpact===false)ctx.reviewChecks.add(item.checkId);
}
function ran(ctx,id){ctx.ranChecks.add(id)}
function good(ctx,id,message){ran(ctx,id);if(message&&!ctx.failedChecks.has(id))ctx.good.add(message)}
function issue(ctx,id,severity,confidence,title,plain,technical,file='',line=null,scoreImpact=true){
  ran(ctx,id);
  addFinding(ctx,finding(id,severity,confidence,title,plain,technical,file,line,scoreImpact));
}
function localReference(value){return !!value&&!EXTERNAL_REF.test(value)&&!/^\s*$/.test(value)}
function moduleLocalReference(value){return /^\.{1,2}\//.test(String(value||''))||String(value||'').startsWith('/')}

function pathCandidates(path){
  const clean=norm(cleanRef(path));
  if(!clean)return[];
  const e=ext(clean);
  if(e)return[clean];
  return[
    clean,
    `${clean}.js`,`${clean}.mjs`,`${clean}.cjs`,`${clean}.jsx`,`${clean}.ts`,`${clean}.tsx`,`${clean}.json`,`${clean}.css`,
    `${clean}/index.js`,`${clean}/index.mjs`,`${clean}/index.jsx`,`${clean}/index.ts`,`${clean}/index.tsx`,`${clean}/index.json`
  ];
}
function findPath(files,path){
  const names=[...files.keys()];
  const lower=new Map(names.map(n=>[norm(n).toLowerCase(),n]));
  for(const candidate of pathCandidates(path)){
    if(files.has(candidate))return{found:true,name:candidate,caseMismatch:false};
    const actual=lower.get(candidate.toLowerCase());
    if(actual)return{found:true,name:actual,caseMismatch:actual!==candidate};
  }
  return{found:false,name:'',caseMismatch:false};
}

function visibleTextFromHtml(text){
  try{
    const doc=new DOMParser().parseFromString(text,'text/html');
    doc.querySelectorAll('script,style,template,noscript').forEach(x=>x.remove());
    return(doc.body?.textContent||'').replace(/\s+/g,' ').trim();
  }catch{return''}
}

function auditGeneral(name,text,ctx){
  const executable=CODE_EXTENSIONS.has(ext(name))?stripJsStringsComments(text):text;
  ran(ctx,'general.empty-file');
  if(!text.trim())issue(ctx,'general.empty-file','warning','high','This file is empty','There is nothing inside this file. If the app needs it, that part cannot work.','The file contains no non-whitespace text.',name,1);

  ran(ctx,'general.merge-marker');
  const merge=text.match(/^(<<<<<<<|=======|>>>>>>>)(?:\s|$)/m);
  if(merge)issue(ctx,'general.merge-marker','critical','high','A code merge was left unfinished','Two versions of the code were combined, but the conflict was never cleaned up. The app may not even start.','Unresolved source-control conflict marker detected.',name,lineOf(text,merge.index));

  ran(ctx,'general.debugger');
  const dbg=executable.match(/^\s*debugger\s*;?\s*$/m);
  if(dbg)issue(ctx,'general.debugger','warning','high','A developer pause command is still in the code','This command can suddenly stop the app when developer tools are open. It should not be left in finished code.','Standalone debugger statement detected.',name,lineOf(text,dbg.index));

  ran(ctx,'general.console-log');
  const logs=[...executable.matchAll(/(^|[^.\w])console\.log\s*\(/gm)];
  if(logs.length)issue(ctx,'general.console-log','info','medium','Some developer log messages are still in the code',`I found ${logs.length} console.log message${logs.length===1?'':'s'}. These are usually harmless, but finished code is cleaner without leftover test messages.`,`${logs.length} console.log call(s) detected.`,name,lineOf(text,logs[0].index),false);

  ran(ctx,'general.alert');
  const alerts=[...executable.matchAll(/(^|[^.\w])alert\s*\(/gm)];
  if(alerts.length)issue(ctx,'general.alert','info','low','The code uses a browser pop-up message',`I found ${alerts.length} alert pop-up${alerts.length===1?'':'s'}. This may be intentional, so I am only pointing it out for review.`,`${alerts.length} alert() call(s) detected.`,name,lineOf(text,alerts[0].index),false);

  ran(ctx,'general.placeholder');
  const placeholders=[];
  for(const m of commentsOnly(text))if(/\b(TODO|FIXME|XXX|HACK|PLACEHOLDER)\b|lorem\s+ipsum|test123|asdf/i.test(m.text))placeholders.push(m);
  if(placeholders.length)issue(ctx,'general.placeholder','info','low','A note says some work may still be unfinished','I found a developer note such as TODO, FIXME, or placeholder text. It may be intentional, so it does not lower the score.','Developer placeholder marker found in a comment.',name,lineOf(text,placeholders[0].index),false);

  ran(ctx,'general.stale-comment');
  const stale=[];
  for(const m of commentsOnly(text))if(/\b(legacy|deprecated|hotfix|temporary\s+fix|remove\s+me|old\s+version|backup\s+copy)\b/i.test(m.text))stale.push(m);
  if(stale.length)issue(ctx,'general.stale-comment','info','low','A code note may point to leftover cleanup','A comment mentions retired, temporary, or replacement code. That can be a clue that unused code is still nearby, but it is not proof by itself.','Maintenance marker found in a source comment.',name,lineOf(text,stale[0].index),false);

  ran(ctx,'general.known-secret');
  const secretPatterns=[
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bAIza[0-9A-Za-z_-]{30,}\b/,
    /\bgh[pousr]_[0-9A-Za-z]{30,}\b/,
    /\bgithub_pat_[0-9A-Za-z_]{30,}\b/,
    /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/,
    /\bsk-(?:proj-)?[0-9A-Za-z_-]{20,}\b/
  ];
  const secret=secretPatterns.map(re=>text.match(re)).find(Boolean);
  if(secret)issue(ctx,'general.known-secret','critical','high','A private key or secret may be inside the project','This looks like a real secret key. Anyone who receives the project could possibly use it. Move secrets out of the front-end files and replace the exposed key.','Recognized credential pattern detected in source text.',name,lineOf(text,secret.index));

  ran(ctx,'general.generic-secret');
  const generic=text.match(/\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*["'][A-Za-z0-9_\-/.+=]{24,}["']/i);
  if(generic&&!secret)issue(ctx,'general.generic-secret','info','low','A long key-like value is written directly in the code','This might be a real secret, or it might be a harmless sample value. I am not counting it as an error, but it is worth checking.','Generic credential-shaped assignment detected; confidence is intentionally low.',name,lineOf(text,generic.index),false);

  ran(ctx,'general.localhost');
  const local=text.match(/https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?/i);
  if(local)issue(ctx,'general.localhost','info','low','The code points to this computer only','I found a localhost address. That works only on the same computer unless the app replaces it for production. I am not calling it broken automatically.','Local development URL detected.',name,lineOf(text,local.index),false);

  ran(ctx,'general.large-source');
  if(text.length>1_500_000)issue(ctx,'general.large-source','info','medium','One code file is unusually large','This file is very large. The app can still work, but a giant source file is harder to maintain and can slow editing or scanning.','Text source exceeds 1.5 MB.',name,1,false);

  ran(ctx,'general.minified-source');
  const lines=text.split('\n');
  const longest=lines.reduce((m,line)=>Math.max(m,line.length),0);
  if(lines.length<8&&text.length>50_000&&longest>20_000)issue(ctx,'general.minified-source','info','low','This looks like compressed code','The code appears to be packed into very long lines. That is normal for built files, so it does not lower the score.','Likely minified/generated source based on line count and line length.',name,1,false);
}

function parseHtml(text){
  try{return new DOMParser().parseFromString(text,'text/html')}catch{return null}
}

function auditHtml(name,text,ctx){
  const doc=parseHtml(text);
  const lower=text.toLowerCase();

  ran(ctx,'html.doctype');
  if(!/^\s*<!doctype\s+html/i.test(text))issue(ctx,'html.doctype','info','medium','This page does not start with the normal HTML document line','Most modern web pages start with <!doctype html>. Without it, browsers can use an older layout mode.','Missing HTML5 doctype.',name,1,false);

  ran(ctx,'html.lang');
  if(doc&&!doc.documentElement.getAttribute('lang'))issue(ctx,'html.lang','info','medium','The page does not say what language it uses','Screen readers and translation tools work better when the page says its language, such as lang="en".','Missing lang attribute on <html>.',name,lineOf(text,lower.indexOf('<html')),false);

  ran(ctx,'html.charset');
  if(!/<meta\b[^>]*charset\s*=/i.test(text))issue(ctx,'html.charset','warning','medium','The page does not clearly set its text character format','Without a charset setting, unusual letters and symbols can display incorrectly in some situations.','No <meta charset> declaration found.',name,1);

  ran(ctx,'html.viewport');
  if(!/<meta\b[^>]*name\s*=\s*["']viewport["']/i.test(text))issue(ctx,'html.viewport','warning','medium','This page may not size correctly on phones','The page is missing the normal mobile viewport setting, so a phone may show it zoomed out or at the wrong width.','Missing viewport meta tag.',name,1);

  ran(ctx,'html.title');
  const title=doc?.querySelector('title')?.textContent?.trim()||'';
  if(!title)issue(ctx,'html.title','info','medium','The browser tab has no page name','The page does not have a useful <title>. The site can still run, but the browser tab will be unclear.','Missing or empty <title>.',name,1,false);

  ran(ctx,'html.structural-tags');
  const structuralText=text.replace(/<script\b[\s\S]*?<\/script>/gi,'').replace(/<style\b[\s\S]*?<\/style>/gi,'').replace(/<template\b[\s\S]*?<\/template>/gi,'');
  const htmlOpen=(structuralText.match(/<html\b/gi)||[]).length,headOpen=(structuralText.match(/<head\b/gi)||[]).length,bodyOpen=(structuralText.match(/<body\b/gi)||[]).length;
  if(htmlOpen>1||headOpen>1||bodyOpen>1)issue(ctx,'html.structural-tags','error','high','The page has more than one main HTML section','A page should have one html, one head, and one body section. Extra copies can make browsers move code to unexpected places.',`Found html:${htmlOpen}, head:${headOpen}, body:${bodyOpen}.`,name,1);

  ran(ctx,'html.duplicate-id');
  const ids=new Map();
  if(doc)for(const el of doc.querySelectorAll('[id]')){
    const id=el.id;if(!id)continue;
    const pos=text.search(new RegExp(`\\bid\\s*=\\s*["']${escapeRegExp(id)}["']`,'i'));
    ids.set(id,(ids.get(id)||[]).concat(lineOf(text,pos)));
  }
  const duplicateIds=[...ids.entries()].filter(([,lines])=>lines.length>1);
  if(duplicateIds.length){
    const [id,lines]=duplicateIds[0];
    issue(ctx,'html.duplicate-id','error','high','Two parts of the page use the same ID',`The ID “${id}” is used more than once. A button or script can grab the wrong part of the page because IDs are supposed to be unique.`,duplicateIds.slice(0,12).map(([value,list])=>`${value}: ${list.length} times`).join('\n'),name,lines[0]);
  }

  ran(ctx,'html.id-whitespace');
  const badId=[...ids.keys()].find(id=>/\s/.test(id));
  if(badId)issue(ctx,'html.id-whitespace','warning','high','An ID contains a space','IDs should not contain spaces. Code that tries to find this part of the page may fail or behave differently than expected.',`Invalid or troublesome id value: ${badId}`,name,ids.get(badId)[0]);

  ran(ctx,'html.missing-alt');
  const imgs=doc?[...doc.querySelectorAll('img')]:[];
  const missingAlt=imgs.filter(img=>!img.hasAttribute('alt'));
  if(missingAlt.length){
    const src=missingAlt[0].getAttribute('src')||'';
    const idx=src?text.indexOf(src):text.search(/<img\b/i);
    issue(ctx,'html.missing-alt','warning','high','Some pictures have no text description',`${missingAlt.length} picture${missingAlt.length===1?' has':'s have'} no alt description. People using screen readers may not know what the picture is.`,`${missingAlt.length} <img> element(s) without an alt attribute.`,name,lineOf(text,idx));
  }

  ran(ctx,'html.empty-src');
  const emptySrc=doc?[...doc.querySelectorAll('[src]')].filter(el=>!String(el.getAttribute('src')||'').trim()):[];
  if(emptySrc.length)issue(ctx,'html.empty-src','warning','high','Something on the page has an empty file address','A picture, script, frame, or other item says src="". The browser may request the current page again instead of the file you expected.','Element with an empty src attribute detected.',name,lineOf(text,text.search(/\bsrc\s*=\s*["']\s*["']/i)));

  ran(ctx,'html.empty-href');
  const emptyHref=doc?[...doc.querySelectorAll('a[href]')].filter(el=>!String(el.getAttribute('href')||'').trim()):[];
  if(emptyHref.length)issue(ctx,'html.empty-href','info','medium','A link does not point anywhere','One or more links use href="". Clicking one usually reloads or jumps to the current page.','Anchor with empty href detected.',name,lineOf(text,text.search(/\bhref\s*=\s*["']\s*["']/i)),false);

  ran(ctx,'html.deprecated-tag');
  const deprecated=text.match(/<(font|center|marquee|frameset|frame)\b/i);
  if(deprecated)issue(ctx,'html.deprecated-tag','warning','high','This page uses very old HTML code','Some browser code on this page has been retired for years. Modern HTML and CSS are more reliable and easier to maintain.',`Deprecated <${deprecated[1]}> element detected.`,name,lineOf(text,deprecated.index));

  ran(ctx,'html.multiple-style');
  const styleBlocks=(text.match(/<style\b/gi)||[]).length;
  if(styleBlocks>1)issue(ctx,'html.multiple-style','info','low','The page has design rules split into several built-in style sections',`I found ${styleBlocks} <style> sections. That may be intentional, but it can also happen when design fixes get added in layers. It does not lower the score.`,`${styleBlocks} inline style blocks found.`,name,lineOf(text,text.toLowerCase().indexOf('<style',text.toLowerCase().indexOf('<style')+1)),false);

  ran(ctx,'html.empty-onclick');
  const emptyClick=text.match(/\bonclick\s*=\s*["']\s*["']/i);
  if(emptyClick)issue(ctx,'html.empty-onclick','warning','high','A click action is empty','This part of the page says it has a click action, but there is no code inside it. Clicking it cannot run the intended inline action.','Empty onclick attribute detected.',name,lineOf(text,emptyClick.index));

  ran(ctx,'html.form-submit');
  if(doc){
    const uncertain=[...doc.querySelectorAll('form')].filter(form=>{
      const hasAction=String(form.getAttribute('action')||'').trim();
      const hasInline=form.hasAttribute('onsubmit');
      const hasId=form.id||form.className;
      return !hasAction&&!hasInline&&!hasId;
    });
    if(uncertain.length)issue(ctx,'html.form-submit','info','low','A form does not clearly show how it is handled','I found a form with no action, no inline submit code, and no easy ID or class for JavaScript to attach to. Modern apps can still handle it another way, so this does not lower the score.','Heuristic form-handler check; manual review only.',name,lineOf(text,text.search(/<form\b/i)),false);
  }

  ran(ctx,'html.missing-label');
  if(doc){
    const controls=[...doc.querySelectorAll('input,select,textarea')].filter(el=>!['hidden','button','submit','reset','image'].includes((el.getAttribute('type')||'').toLowerCase()));
    const unlabeled=controls.filter(el=>{
      if(el.getAttribute('aria-label')||el.getAttribute('aria-labelledby')||el.closest('label'))return false;
      const id=el.id;
      return !id||![...doc.querySelectorAll('label[for]')].some(label=>label.htmlFor===id);
    });
    if(unlabeled.length)issue(ctx,'html.missing-label','warning','high','Some boxes do not tell the user what they are for',`${unlabeled.length} form field${unlabeled.length===1?' has':'s have'} no connected label. A person using a screen reader may hear “edit box” without knowing what belongs there.`,`${unlabeled.length} input/select/textarea control(s) without an accessible label.`,name,lineOf(text,text.search(/<(input|select|textarea)\b/i)));
  }

  ran(ctx,'html.label-target');
  if(doc){
    const brokenLabels=[...doc.querySelectorAll('label[for]')].filter(label=>label.htmlFor&&!doc.getElementById(label.htmlFor));
    if(brokenLabels.length)issue(ctx,'html.label-target','info','low','A label points to a field that is not in the static page','A label uses a “for” name, but I cannot find a matching field ID in this HTML file. JavaScript may add the field later, so this is only a manual check.',brokenLabels.slice(0,12).map(label=>`for="${label.htmlFor}"`).join('\n'),name,lineOf(text,text.search(/<label\b[^>]*\bfor\s*=/i)),false);
  }

  ran(ctx,'html.aria-reference');
  if(doc){
    const broken=[];
    for(const el of doc.querySelectorAll('[aria-labelledby],[aria-describedby],[aria-controls]')){
      for(const attr of ['aria-labelledby','aria-describedby','aria-controls']){
        const value=el.getAttribute(attr);if(!value)continue;
        for(const id of value.trim().split(/\s+/))if(id&&!doc.getElementById(id))broken.push(`${attr} -> #${id}`);
      }
    }
    if(broken.length)issue(ctx,'html.aria-reference','info','low','An accessibility helper points to an ID that is not in the static page','The page names another element for a screen reader or expandable control, but that target ID is not in this HTML file. Dynamic apps can create it later, so this does not lower the score.',[...new Set(broken)].slice(0,15).join('\n'),name,1,false);
  }

  ran(ctx,'html.fragment-target');
  if(doc){
    const broken=[...doc.querySelectorAll('a[href^="#"]')].map(a=>a.getAttribute('href')).filter(h=>h&&h.length>1&&!doc.getElementById(h.slice(1)));
    if(broken.length)issue(ctx,'html.fragment-target','info','low','A same-page link points to a section that is not in the static HTML','A link such as #section does not have a matching ID in this file. A script may create it later, so this is review-only.',[...new Set(broken)].slice(0,15).join('\n'),name,1,false);
  }

  ran(ctx,'html.nested-interactive');
  if(doc){
    const nested=[...doc.querySelectorAll('a,button')].find(el=>el.querySelector('a,button,input,select,textarea'));
    if(nested){
      const token=nested.outerHTML.slice(0,80);
      issue(ctx,'html.nested-interactive','warning','high','A clickable control is placed inside another clickable control','Putting a button or link inside another button or link can make clicks and keyboard use confusing or broken.','Nested interactive controls detected.',name,lineOf(text,text.indexOf(token.slice(0,25))));
    }
  }

  ran(ctx,'html.button-type');
  if(doc){
    const buttons=[...doc.querySelectorAll('form button:not([type])')];
    if(buttons.length)issue(ctx,'html.button-type','warning','high','A button inside a form may submit the form by accident','A <button> inside a form has no type. Browsers treat it like a submit button, so a normal click can send the form unexpectedly.','Form button missing type="button" or type="submit".',name,lineOf(text,text.search(/<button\b/i)));
  }

  ran(ctx,'html.iframe-title');
  if(doc){
    const frames=[...doc.querySelectorAll('iframe')].filter(el=>!String(el.getAttribute('title')||'').trim());
    if(frames.length)issue(ctx,'html.iframe-title','warning','high','An embedded page has no name for screen readers','An iframe needs a short title that explains what the embedded area contains.','iframe element missing title attribute.',name,lineOf(text,text.search(/<iframe\b/i)));
  }

  ran(ctx,'html.target-blank-rel');
  if(doc){
    const blank=[...doc.querySelectorAll('a[target="_blank"]')].filter(el=>!/(^|\s)(noopener|noreferrer)(\s|$)/i.test(el.getAttribute('rel')||''));
    if(blank.length)issue(ctx,'html.target-blank-rel','warning','medium','A link opens a new tab without the usual safety setting','This link uses target="_blank" but not rel="noopener" or rel="noreferrer". Modern browsers protect many cases, but adding the setting is still safer.','target="_blank" link without noopener/noreferrer.',name,lineOf(text,text.search(/target\s*=\s*["']_blank["']/i)));
  }

  ran(ctx,'html.inline-handler');
  const handlers=[...text.matchAll(/\son(?:click|change|input|submit|load|error|keydown|keyup)\s*=/gi)];
  if(handlers.length>8)issue(ctx,'html.inline-handler','info','low','Many click or change actions are written directly inside the HTML',`I found ${handlers.length} inline event actions. They can work, but separating behavior into JavaScript is usually easier to maintain. This does not lower the score.`,`${handlers.length} inline event handler attributes detected.`,name,lineOf(text,handlers[0].index),false);

  ran(ctx,'html.meta-refresh');
  const refresh=text.match(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i);
  if(refresh)issue(ctx,'html.meta-refresh','info','low','This page can automatically reload or send the user somewhere else','I found a meta refresh. That may be intentional, so I am only showing it for review.','Meta refresh directive detected.',name,lineOf(text,refresh.index),false);

  ran(ctx,'html.visible-placeholder');
  const visible=visibleTextFromHtml(text);
  if(/lorem\s+ipsum|\btest123\b|\bplaceholder\s+text\b/i.test(visible))issue(ctx,'html.visible-placeholder','warning','medium','Test text may still be visible on the page','The page contains text that looks like a temporary placeholder. Check that a user is supposed to see it.','Placeholder-like text detected in rendered HTML text.',name,1);
}

function extractCssBlocks(text){
  const blocks=[];
  let i=0;
  while(i<text.length){
    const open=text.indexOf('{',i);if(open<0)break;
    let start=open-1;while(start>=0&&text[start]!=='}'&&text[start]!==';'&&text[start]!=='{')start--;
    const selector=text.slice(start+1,open).trim();
    let depth=1,j=open+1,quote='',comment=false;
    for(;j<text.length&&depth>0;j++){
      const ch=text[j],next=text[j+1];
      if(comment){if(ch==='*'&&next==='/'){comment=false;j++}continue}
      if(!quote&&ch==='/'&&next==='*'){comment=true;j++;continue}
      if(quote){if(ch==='\\'){j++;continue}if(ch===quote)quote='';continue}
      if(ch==='"'||ch==="'"){quote=ch;continue}
      if(ch==='{')depth++;else if(ch==='}')depth--;
    }
    if(depth===0&&selector&&!selector.startsWith('@'))blocks.push({selector,body:text.slice(open+1,j-1),index:start+1});
    i=Math.max(j,open+1);
  }
  return blocks;
}
function declarations(body){
  const out=[];
  for(const part of String(body).split(';')){
    const colon=part.indexOf(':');if(colon<1)continue;
    const prop=part.slice(0,colon).trim().toLowerCase();
    const value=part.slice(colon+1).trim();
    if(prop&&value)out.push({prop,value});
  }
  return out;
}

function auditCss(name,text,ctx){
  ran(ctx,'css.brace-balance');
  const clean=text.replace(/\/\*[\s\S]*?\*\//g,' '),opens=(clean.match(/\{/g)||[]).length,closes=(clean.match(/\}/g)||[]).length;
  if(opens!==closes)issue(ctx,'css.brace-balance','critical','high','The design code has a missing or extra bracket','A { or } bracket does not have its partner. Styles after that point can stop working or land in the wrong rule.',`${opens} opening brace(s) and ${closes} closing brace(s).`,name,1);

  ran(ctx,'css.comment-balance');
  const openComments=(text.match(/\/\*/g)||[]).length,closeComments=(text.match(/\*\//g)||[]).length;
  if(openComments!==closeComments)issue(ctx,'css.comment-balance','critical','high','A design-code comment was not closed','A /* comment starts but does not have the matching */ ending, or there is an extra ending. The browser can ignore a large part of the CSS after it.',`${openComments} comment start(s), ${closeComments} comment end(s).`,name,1);

  ran(ctx,'css.important-overuse');
  const important=(text.match(/!important\b/gi)||[]).length;
  if(important>10)issue(ctx,'css.important-overuse','warning','medium','Too many design rules are being forced to win',`I found ${important} !important rules. A few can be useful, but many of them often mean styles are fighting each other.`,`${important} !important declaration(s).`,name,lineOf(text,text.search(/!important/i)));

  const blocks=extractCssBlocks(text).map(block=>({...block,declarations:declarations(block.body)}));
  const bySelector=new Map();
  for(const block of blocks){
    const selector=block.selector.replace(/\s+/g,' ');
    if(!bySelector.has(selector))bySelector.set(selector,[]);
    bySelector.get(selector).push(block);
  }

  ran(ctx,'css.duplicate-selector');
  const duplicates=[...bySelector.entries()].filter(([,items])=>items.length>1);
  if(duplicates.length)issue(ctx,'css.duplicate-selector','info','low','Some design selectors are written more than once',`${duplicates.length} selector${duplicates.length===1?' appears':'s appear'} in more than one place. That can be intentional for media rules or layering, so it does not lower the score by itself.`,duplicates.slice(0,12).map(([selector,items])=>`${selector} (${items.length} times)`).join('\n'),name,lineOf(text,duplicates[0][1][1].index),false);

  ran(ctx,'css.selector-conflict');
  const conflicts=[];
  for(const [selector,items] of duplicates){
    const seen=new Map();
    for(const item of items)for(const d of item.declarations){
      const previous=seen.get(d.prop);
      if(previous&&previous!==d.value)conflicts.push(`${selector}: ${d.prop} changes from “${previous}” to “${d.value}”`);
      seen.set(d.prop,d.value);
    }
  }
  if(conflicts.length)issue(ctx,'css.selector-conflict','warning','medium','The same design rule gives different answers in different places','A selector is repeated and changes the same property later. The last rule wins, which can make earlier styling look like it is being ignored.',conflicts.slice(0,15).join('\n'),name,1);

  ran(ctx,'css.duplicate-property');
  const duplicateProps=[];
  for(const block of blocks){
    const seen=new Map();
    for(const d of block.declarations){if(seen.has(d.prop)&&seen.get(d.prop)===d.value)duplicateProps.push(`${block.selector}: ${d.prop}: ${d.value}`);seen.set(d.prop,d.value)}
  }
  if(duplicateProps.length)issue(ctx,'css.duplicate-property','info','low','A design property is repeated inside the same rule','The same property and value are written twice in one CSS rule. It is usually harmless, but it is unnecessary code.',duplicateProps.slice(0,12).join('\n'),name,1,false);

  ran(ctx,'css.property-conflict');
  const propertyConflicts=[];
  for(const block of blocks){
    const seen=new Map();
    for(const d of block.declarations){if(seen.has(d.prop)&&seen.get(d.prop)!==d.value)propertyConflicts.push(`${block.selector}: ${d.prop} is “${seen.get(d.prop)}” then “${d.value}”`);seen.set(d.prop,d.value)}
  }
  if(propertyConflicts.length)issue(ctx,'css.property-conflict','info','low','One design rule gives the same property more than one value','The same CSS property is written twice with different values inside one rule. Browsers often use this on purpose for fallbacks, so I only list it for review.',propertyConflicts.slice(0,12).join('\n'),name,1,false);

  ran(ctx,'css.display-conflict');
  const displayConflicts=conflicts.filter(x=>/: display changes from/i.test(x));
  if(displayConflicts.length)issue(ctx,'css.display-conflict','info','low','A repeated style changes how an element is laid out','The same selector changes its display type in another rule. Responsive code can do this on purpose, so this is review-only.',displayConflicts.slice(0,10).join('\n'),name,1,false);

  ran(ctx,'css.flex-conflict');
  const flexConflicts=conflicts.filter(x=>/: (?:display|flex|flex-direction|align-items|justify-content) changes from/i.test(x));
  if(flexConflicts.length)issue(ctx,'css.flex-conflict','info','low','Some flex layout settings are changed later','The same selector gets different flex or display settings in separate places. Responsive CSS can do this on purpose, so this is review-only.',flexConflicts.slice(0,10).join('\n'),name,1,false);

  ran(ctx,'css.vendor-fallback');
  const vendor=[];
  const propLines=text.split('\n');
  const prefixes=[['-webkit-',''],['-moz-',''],['-ms-',''],['-o-','']];
  propLines.forEach((line,i)=>{
    const match=line.match(/^\s*(-(?:webkit|moz|ms|o)-[\w-]+)\s*:/);if(!match)return;
    const prop=match[1];const standard=prefixes.reduce((p,[prefix])=>p.startsWith(prefix)?p.slice(prefix.length):p,prop);
    if(!new RegExp(`(^|[;{\\n]\\s*)${escapeRegExp(standard)}\\s*:`,`m`).test(text))vendor.push(`line ${i+1}: ${prop} has no ${standard} rule`);
  });
  if(vendor.length)issue(ctx,'css.vendor-fallback','info','low','A browser-specific style has no normal version beside it','A prefixed CSS property is present without the standard property. That can be intentional for a special browser, so it does not lower the score.',vendor.slice(0,10).join('\n'),name,1,false);

  ran(ctx,'css.empty-rule');
  const empty=blocks.filter(block=>!block.body.trim());
  if(empty.length)issue(ctx,'css.empty-rule','info','medium','Some design rules are empty',`${empty.length} CSS rule${empty.length===1?' has':'s have'} no properties inside. Empty rules do nothing and are usually safe to remove.`,empty.slice(0,10).map(x=>x.selector).join('\n'),name,lineOf(text,empty[0].index),false);

  ran(ctx,'css.high-z');
  const highZ=[...text.matchAll(/z-index\s*:\s*(-?\d+)/gi)].filter(m=>Number(m[1])>9999);
  if(highZ.length)issue(ctx,'css.high-z','info','low','Some layers use extremely large z-index numbers','Very large layer numbers can be a sign that pop-ups and panels are fighting for the top. It may still be intentional, so this is review-only.',highZ.slice(0,10).map(m=>`line ${lineOf(text,m.index)}: z-index ${m[1]}`).join('\n'),name,lineOf(text,highZ[0].index),false);

  ran(ctx,'css.fixed-heavy');
  const fixed=(text.match(/position\s*:\s*fixed\b/gi)||[]).length;
  if(fixed>6)issue(ctx,'css.fixed-heavy','info','low','The design uses many fixed-position items',`I found ${fixed} fixed-position rules. On smaller screens, fixed items can cover each other or cover the page. This is only a reminder to test them.`,`${fixed} position:fixed declarations.`,name,1,false);

  ran(ctx,'css.absolute-heavy');
  const absolute=(text.match(/position\s*:\s*absolute\b/gi)||[]).length;
  if(absolute>30)issue(ctx,'css.absolute-heavy','info','low','The design uses a lot of absolute positioning',`I found ${absolute} absolute-position rules. That can be fine for icons and overlays, but large numbers are harder to keep responsive.`,`${absolute} position:absolute declarations.`,name,1,false);

  ran(ctx,'css.box-sizing');
  const hasGlobalBox=/\*\s*(?:,\s*\*::before\s*,\s*\*::after)?\s*\{[^}]*box-sizing\s*:\s*border-box/i.test(text)||/:where\([^)]*\*[^)]*\)\s*\{[^}]*box-sizing\s*:\s*border-box/i.test(text);
  const widthCount=(text.match(/\bwidth\s*:/gi)||[]).length,paddingCount=(text.match(/\bpadding(?:-[\w-]+)?\s*:/gi)||[]).length;
  if(!hasGlobalBox&&widthCount>5&&paddingCount>5)issue(ctx,'css.box-sizing','info','low','The page may be using the older box-size math','I did not find a clear global border-box rule. Without it, width plus padding can make boxes wider than expected. Your CSS may set this another way, so it does not lower the score.','No obvious global box-sizing:border-box reset found in a size-heavy stylesheet.',name,1,false);

  ran(ctx,'css.keyframe-duplicate');
  const keyframes=new Map();
  for(const m of text.matchAll(/@(?:-webkit-)?keyframes\s+([\w-]+)/gi))keyframes.set(m[1],(keyframes.get(m[1])||0)+1);
  const duplicateKeyframes=[...keyframes.entries()].filter(([,count])=>count>1);
  if(duplicateKeyframes.length)issue(ctx,'css.keyframe-duplicate','warning','medium','An animation name is defined more than once','Two animation blocks use the same name. The later definition can replace the earlier one and make the animation behave differently than expected.',duplicateKeyframes.map(([key,count])=>`${key}: ${count} definitions`).join('\n'),name,1);
}

function babelAst(name,text){
  if(typeof globalThis.Babel==='undefined')return{ast:null,error:null,unavailable:true};
  const e=ext(name),presets=[];
  if(e==='ts'||e==='tsx')presets.push(['typescript',{allExtensions:true,isTSX:e==='tsx'}]);
  if(e==='jsx'||e==='tsx')presets.push(['react',{runtime:'automatic'}]);
  try{
    const result=globalThis.Babel.transform(text,{filename:name,ast:true,code:false,sourceType:'unambiguous',presets,parserOpts:{allowReturnOutsideFunction:true,plugins:e==='js'||e==='mjs'||e==='cjs'?['jsx']:[]}});
    return{ast:result.ast,error:null,unavailable:false};
  }catch(error){return{ast:null,error,unavailable:false}}
}
function topLevelNames(ast){
  const names=[];
  const body=ast?.program?.body||[];
  const add=(name,node,type)=>{if(name)names.push({name,line:node?.loc?.start?.line||null,type})};
  const inspect=node=>{
    if(!node)return;
    if(node.type==='FunctionDeclaration'||node.type==='ClassDeclaration')add(node.id?.name,node,node.type);
    if(node.type==='VariableDeclaration')for(const decl of node.declarations||[])if(decl.id?.type==='Identifier')add(decl.id.name,decl,node.type);
  };
  for(const node of body){if(node.type==='ExportNamedDeclaration'||node.type==='ExportDefaultDeclaration')inspect(node.declaration);else inspect(node)}
  return names;
}

function auditJs(name,text,ctx){
  const executable=stripJsStringsComments(text);
  const parsed=babelAst(name,text);
  ran(ctx,'js.syntax');
  if(parsed.error){
    const message=String(parsed.error?.message||parsed.error).replace(/^.*?:\s*/,'');
    const line=parsed.error?.loc?.line||null;
    issue(ctx,'js.syntax','critical','high','The browser cannot read one of the code files','This file has a real JavaScript or TypeScript syntax error. Code in this file cannot run until the syntax is fixed.',message,name,line);
  }

  ran(ctx,'js.duplicate-top-level');
  if(parsed.ast){
    const map=new Map();
    for(const item of topLevelNames(parsed.ast)){if(!map.has(item.name))map.set(item.name,[]);map.get(item.name).push(item)}
    const duplicates=[...map.entries()].filter(([,items])=>items.length>1);
    const isTs=['ts','tsx'].includes(ext(name));
    if(duplicates.length){
      const [dupName,items]=duplicates[0];
      issue(ctx,'js.duplicate-top-level',isTs?'info':'error',isTs?'low':'high',isTs?'A top-level name appears more than once':'Two top-level pieces of code use the same name',isTs?`The name “${dupName}” appears more than once. TypeScript can do this on purpose for overloads or declarations, so I am only asking for a review.`:`The name “${dupName}” is declared more than once at the top level. The later declaration can replace or conflict with the earlier one.`,duplicates.slice(0,12).map(([key,list])=>`${key}: lines ${list.map(x=>x.line||'?').join(', ')}`).join('\n'),name,items[0].line,isTs?false:true);
    }
  }

  ran(ctx,'js.eval');
  const evalCall=executable.match(/\beval\s*\(|\bnew\s+Function\s*\(/);
  if(evalCall)issue(ctx,'js.eval','warning','high','The app builds code from text while it is running','eval() or new Function() can create security problems and makes code much harder to inspect safely.','Dynamic code execution detected.',name,lineOf(text,evalCall.index));

  ran(ctx,'js.document-write');
  const write=executable.match(/\bdocument\.write(?:ln)?\s*\(/);
  if(write)issue(ctx,'js.document-write','warning','high','The app writes directly into the page with document.write','document.write can replace the whole page or block loading. Modern code usually adds elements without using this command.','document.write/document.writeln detected.',name,lineOf(text,write.index));

  ran(ctx,'js.innerhtml');
  const riskyInner=[...text.matchAll(/\.innerHTML\s*=\s*[^;\n]*(?:\.value\b|location\b|searchParams\b|responseText\b|event\.data\b|message\b)/gi)];
  if(riskyInner.length)issue(ctx,'js.innerhtml','info','low','Some outside or user-controlled text may be placed into innerHTML','I found an innerHTML assignment whose value appears to come from input, a URL, a response, or a message. It may already be cleaned first, so this is review-only.','Potentially dynamic innerHTML assignment detected.',name,lineOf(text,riskyInner[0].index),false);

  ran(ctx,'js.empty-catch');
  const emptyCatch=[...executable.matchAll(/catch\s*(?:\([^)]*\))?\s*\{\s*\}/g)];
  if(emptyCatch.length>2)issue(ctx,'js.empty-catch','info','low','This file silently ignores several errors',`I found ${emptyCatch.length} completely empty catch blocks in one file. A few can be intentional, but many can hide failures that are hard to diagnose.`,`${emptyCatch.length} empty catch blocks detected.`,name,lineOf(text,emptyCatch[0].index),false);

  ran(ctx,'js.setinterval');
  const intervals=(executable.match(/\bsetInterval\s*\(/g)||[]).length,clears=(executable.match(/\bclearInterval\s*\(/g)||[]).length;
  if(intervals>0&&clears===0)issue(ctx,'js.setinterval','info','low','A repeating timer has no obvious stop command','The code starts a repeating timer, but this file never calls clearInterval. It may be stopped somewhere else, so this is only a review note.','setInterval found without clearInterval in the same file.',name,lineOf(text,text.indexOf('setInterval')),false);

  ran(ctx,'js.duplicate-listener');
  const listenerMap=new Map();
  for(const m of text.matchAll(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.addEventListener\s*\(\s*["']([^"']+)["']\s*,\s*([A-Za-z_$][\w$]*)/g)){
    const key=`${m[1]}|${m[2]}|${m[3]}`;listenerMap.set(key,(listenerMap.get(key)||[]).concat(lineOf(text,m.index)));
  }
  const listeners=[...listenerMap.entries()].filter(([,lines])=>lines.length>1);
  if(listeners.length)issue(ctx,'js.duplicate-listener','info','low','The same named click or event handler may be attached more than once','I found the same target, event, and named handler repeated. This can be intentional after re-rendering, so it does not lower the score.',listeners.slice(0,10).map(([key,lines])=>`${key}: lines ${lines.join(', ')}`).join('\n'),name,listeners[0][1][0],false);

  ran(ctx,'js.service-worker-count');
  const sw=[...text.matchAll(/navigator\.serviceWorker\.register\s*\(\s*["'`]([^"'`]+)["'`]/g)];
  const swNames=[...new Set(sw.map(m=>m[1]))];
  if(swNames.length>1)issue(ctx,'js.service-worker-count','info','low','The app registers more than one service worker file','More than one worker path is registered. That may be intentional, but it can also leave different caching systems competing with each other.','Service worker registrations: '+swNames.join(', '),name,lineOf(text,sw[0].index),false);

  ran(ctx,'js.direct-null-risk');
  const direct=[...executable.matchAll(/document\.(?:getElementById|querySelector)\s*\([^)]*\)\s*\.\s*(?:addEventListener|classList|style|value|textContent|innerHTML)\b/g)];
  if(direct.length)issue(ctx,'js.direct-null-risk','info','low','Some page lookups are used immediately without checking that they exist','Code like getElementById(...).addEventListener(...) throws an error if the element is missing on that screen. It may be safe if the element always exists, so this is review-only.','Direct DOM lookup dereference detected without an obvious null check.',name,lineOf(text,direct[0].index),false);

  ran(ctx,'js.detached-dom-risk');
  const cached=[...text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*document\.(?:getElementById|querySelector)\s*\(/g)];
  const replaces=[...text.matchAll(/\.innerHTML\s*=/g)];
  if(cached.length&&replaces.length){
    const neverReassigned=cached.filter(m=>{
      const variable=m[1],rest=text.slice(m.index+m[0].length);
      return !new RegExp(`\\b${escapeRegExp(variable)}\\s*=(?!=)`).test(rest);
    });
    if(neverReassigned.length)issue(ctx,'js.detached-dom-risk','info','low','Some saved page-element references may become old after HTML is replaced','This file saves page elements in variables and also replaces HTML elsewhere. If the replaced HTML contains one of those elements, the saved variable can keep pointing to the removed copy. This is only a pattern warning, not proof of a bug.',neverReassigned.slice(0,10).map(m=>`${m[1]} near line ${lineOf(text,m.index)}`).join('\n'),name,lineOf(text,neverReassigned[0].index),false);
  }
}

function auditJson(name,text,ctx){
  ran(ctx,'json.syntax');
  try{JSON.parse(text)}catch(error){issue(ctx,'json.syntax','critical','high','A JSON file is not valid','The app cannot reliably read this settings/data file because its commas, quotes, brackets, or other JSON syntax are broken.',String(error?.message||error),name,1)}
}

function auditCrossProject(files,texts,ctx){
  const htmlEntries=[...texts].filter(([name])=>/\.html?$/i.test(name));
  const codeEntries=[...texts].filter(([name])=>CODE_EXTENSIONS.has(ext(name)));
  const cssEntries=[...texts].filter(([name])=>ext(name)==='css');

  ran(ctx,'project.case-collision');
  const byLower=new Map();
  for(const name of files.keys()){
    const key=norm(name).toLowerCase();if(!byLower.has(key))byLower.set(key,[]);byLower.get(key).push(name);
  }
  const collisions=[...byLower.values()].filter(group=>new Set(group).size>1);
  if(collisions.length)issue(ctx,'project.case-collision','warning','high','Two files have names that differ only by capital letters','Some computers treat these as different files and others do not. That can make a build work on one computer and fail on another.',collisions.slice(0,12).map(group=>group.join(' <> ')).join('\n'),collisions[0][0],1);

  ran(ctx,'project.zero-byte-file');
  const emptyBinary=[...files].filter(([name,file])=>(file.size||0)===0&&!TEXT_EXTENSIONS.has(ext(name))).map(([name])=>name);
  if(emptyBinary.length)issue(ctx,'project.zero-byte-file','warning','high','A non-text project file is completely empty','An image, font, PDF, ZIP, or other binary file has zero bytes. If the app uses it, there is nothing inside for the browser to load.',emptyBinary.slice(0,15).join('\n'),emptyBinary[0],1);

  ran(ctx,'project.large-asset');
  const largeAssets=[...files].filter(([name,file])=>!TEXT_EXTENSIONS.has(ext(name))&&(file.size||0)>8*1024*1024).map(([name,file])=>`${name} — ${(file.size/1048576).toFixed(1)} MB`);
  if(largeAssets.length)issue(ctx,'project.large-asset','info','low','Some individual files are very large','Large images, videos, PDFs, fonts, or archives can slow loading, especially on a phone. They may be intentionally large, so this is review-only.',largeAssets.slice(0,15).join('\n'),largeAssets[0].split(' — ')[0],1,false);

  ran(ctx,'project.lockfile-conflict');
  const lockNames=[...files.keys()].filter(name=>/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/i.test(name));
  const lockKinds=new Set(lockNames.map(name=>name.split('/').pop().toLowerCase().replace(/\.lockb?$/,'lock')));
  if(lockKinds.size>1)issue(ctx,'project.lockfile-conflict','info','low','More than one package-manager lock file is present','The project contains lock files from different package managers. A monorepo can do this on purpose, but in a single app it can make dependency versions drift.',lockNames.slice(0,12).join('\n'),lockNames[0],1,false);

  ran(ctx,'project.html-reference');
  ran(ctx,'project.case-mismatch-reference');
  for(const [name,text] of htmlEntries){
    for(const m of text.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)){
      const ref=cleanRef(m[1]);if(!localReference(ref)||ref===''||ref.startsWith('#'))continue;
      const target=resolve(name,ref);const found=findPath(files,target);
      if(!found.found){
        issue(ctx,'project.html-reference','error','high','A page points to a local file that is missing',`The page asks for “${ref}”, but that file is not in the project. A picture, stylesheet, script, or page link can fail because of this.`,`Missing local reference: ${name} -> ${ref} (resolved as ${target})`,name,lineOf(text,m.index));
      }else if(found.caseMismatch){
        issue(ctx,'project.case-mismatch-reference','warning','high','A file name uses different capital letters than the link that opens it',`The page asks for “${target}”, but the actual file is “${found.name}”. Windows may allow this while a web server can fail.`,`Case mismatch: requested ${target}; actual ${found.name}.`,name,lineOf(text,m.index));
      }
    }
  }

  ran(ctx,'project.css-reference');
  for(const [name,text] of cssEntries){
    for(const m of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)){
      const ref=cleanRef(m[1]);if(!localReference(ref)||ref.startsWith('#'))continue;
      const target=resolve(name,ref);const found=findPath(files,target);
      if(!found.found)issue(ctx,'project.css-reference','warning','high','A design file points to an image or font that is missing',`The CSS asks for “${ref}”, but that local file is not in the project. The page may lose an image, icon, or font.`,`Missing CSS url(): ${name} -> ${ref} (resolved as ${target})`,name,lineOf(text,m.index));
    }
  }

  ran(ctx,'project.module-import');
  ran(ctx,'project.case-mismatch-import');
  const bareImports=new Set();
  for(const [name,text] of codeEntries){
    const patterns=[
      /\b(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["'`]([^"'`]+)["'`]/g,
      /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
      /\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g
    ];
    for(const re of patterns)for(const m of text.matchAll(re)){
      const ref=m[1];
      if(moduleLocalReference(ref)){
        const target=resolve(name,ref);const found=findPath(files,target);
        if(!found.found)issue(ctx,'project.module-import','error','high','A code file imports another local file that is missing',`“${name}” tries to load “${ref}”, but I cannot find that file. The app can fail to build or stop when this module is needed.`,`Unresolved local module: ${name} -> ${ref} (resolved as ${target})`,name,lineOf(text,m.index));
        else if(found.caseMismatch)issue(ctx,'project.case-mismatch-import','warning','high','A code import uses the wrong capitalization for a file name',`The import asks for “${target}”, but the real file is “${found.name}”. This often works on Windows and then breaks on Linux or a web server.`,`Import case mismatch: requested ${target}; actual ${found.name}.`,name,lineOf(text,m.index));
      }else if(!EXTERNAL_REF.test(ref))bareImports.add(ref.split('/')[0].startsWith('@')?ref.split('/').slice(0,2).join('/'):ref.split('/')[0]);
    }
  }

  ran(ctx,'project.service-worker-file');
  for(const [name,text] of codeEntries){
    for(const m of text.matchAll(/navigator\.serviceWorker\.register\s*\(\s*["'`]([^"'`]+)["'`]/g)){
      const ref=m[1];if(!localReference(ref))continue;
      const target=resolve(name,ref);const found=findPath(files,target);
      if(!found.found)issue(ctx,'project.service-worker-file','warning','high','The app registers a service worker file that is missing',`The code tries to start “${ref}”, but that file is not in the project. Offline caching or app-install behavior cannot work correctly.`,`Missing service worker target: ${target}`,name,lineOf(text,m.index));
    }
  }

  ran(ctx,'project.worker-file');
  for(const [name,text] of codeEntries){
    for(const m of text.matchAll(/\bnew\s+(?:Shared)?Worker\s*\(\s*["'`]([^"'`]+)["'`]/g)){
      const ref=m[1];if(!localReference(ref))continue;
      const target=resolve(name,ref);const found=findPath(files,target);
      if(!found.found)issue(ctx,'project.worker-file','warning','high','The app starts a background worker file that is missing',`The code tries to start “${ref}”, but that local worker file is not in the project. The feature that depends on it cannot run.`,`Missing Worker target: ${target}`,name,lineOf(text,m.index));
    }
  }

  ran(ctx,'project.package-main');
  ran(ctx,'project.package-script');
  ran(ctx,'project.package-import-list');
  const packageName=[...texts.keys()].find(name=>/(^|\/)package\.json$/i.test(name));
  if(packageName){
    try{
      const pkg=JSON.parse(texts.get(packageName));
      if(pkg.main&&typeof pkg.main==='string'){
        const target=resolve(packageName,pkg.main);if(!findPath(files,target).found)issue(ctx,'project.package-main','error','high','package.json points to a main file that is missing',`The package says its main file is “${pkg.main}”, but that file is not in the project. Desktop or Node startup can fail.`,`Missing package main target: ${target}`,packageName,1);
      }
      const scripts=Object.values(pkg.scripts||{}).filter(x=>typeof x==='string');
      for(const script of scripts){
        const matches=[...script.matchAll(/(?:^|\s)(?:node|electron|tsx|ts-node)\s+([^\s;&|]+)/g)];
        for(const m of matches){
          const ref=m[1].replace(/["']/g,'');if(!moduleLocalReference('./'+ref)&&ref.startsWith('-'))continue;
          const target=resolve(packageName,ref);if(!findPath(files,target).found)issue(ctx,'project.package-script','warning','medium','A package command points to a file that is missing',`One package.json command tries to run “${ref}”, but that file is not in the project. That command will fail when someone runs it.`,`Script target not found: ${ref}`,packageName,1);
        }
      }
      const listed=new Set([...Object.keys(pkg.dependencies||{}),...Object.keys(pkg.devDependencies||{}),...Object.keys(pkg.peerDependencies||{})]);
      const missing=[...bareImports].filter(x=>!listed.has(x)&&!['fs','path','url','http','https','crypto','os','util','events','stream','buffer','child_process','electron'].includes(x));
      if(missing.length)issue(ctx,'project.package-import-list','info','low','Some imported packages are not listed in package.json','The code imports packages that I do not see in dependencies. Build tools or import maps can supply them another way, so this is review-only.',missing.slice(0,15).join('\n'),packageName,1,false);
    }catch{}
  }

  ran(ctx,'project.html-handler-function');
  const allCode=codeEntries.map(([,text])=>text).join('\n');
  for(const [name,text] of htmlEntries){
    for(const m of text.matchAll(/\bon(?:click|change|submit|input)\s*=\s*["']\s*([A-Za-z_$][\w$]*)\s*\(/gi)){
      const fn=m[1];
      if(!new RegExp(`\\b(?:function\\s+${escapeRegExp(fn)}\\s*\\(|(?:const|let|var)\\s+${escapeRegExp(fn)}\\s*=|window\\.${escapeRegExp(fn)}\\s*=)`).test(allCode+text)){
        issue(ctx,'project.html-handler-function','error','high','A page calls a function that I cannot find',`A click or form action tries to run “${fn}()”, but I cannot find that function in the project. The action is likely broken.`,`Inline handler references missing function ${fn}().`,name,lineOf(text,m.index));
      }
    }
  }

  ran(ctx,'project.dom-id-reference');
  const htmlIds=new Set();
  for(const [,text] of htmlEntries)for(const m of text.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi))htmlIds.add(m[1]);
  const missingIds=[];
  for(const [name,text] of codeEntries){
    for(const m of text.matchAll(/document\.getElementById\s*\(\s*["']([^"']+)["']\s*\)/g)){
      const id=m[1];
      const builtDynamically=new RegExp(`(?:id\\s*=\\s*["']${escapeRegExp(id)}["']|setAttribute\\(\\s*["']id["']\\s*,\\s*["']${escapeRegExp(id)}["'])`).test(allCode);
      if(!htmlIds.has(id)&&!builtDynamically)missingIds.push({name,id,line:lineOf(text,m.index)});
    }
  }
  if(missingIds.length)issue(ctx,'project.dom-id-reference','info','low','Some JavaScript looks for page IDs that are not in the static HTML','The app may create these elements later, so this is not counted as a broken feature. Check them only if a button or panel is not working.',missingIds.slice(0,15).map(x=>`${x.name}:${x.line} -> #${x.id}`).join('\n'),missingIds[0].name,missingIds[0].line,false);

  ran(ctx,'project.orphan-css-class');
  const nonCss=[...texts].filter(([name])=>ext(name)!=='css').map(([,text])=>text).join('\n');
  const orphanClasses=[];
  for(const [name,text] of cssEntries){
    const selectorText=extractCssBlocks(text).map(block=>block.selector).join('\n');
    const classes=new Set([...selectorText.matchAll(/\.([A-Za-z_][\w-]*)/g)].map(m=>m[1]).filter(c=>!/^\d/.test(c)));
    for(const cls of classes){
      if(cls.length<3)continue;
      const used=new RegExp(`(?:class(?:Name)?\\s*=|classList\\.(?:add|remove|toggle|contains)\\s*\\(|["'\\s])[^\\n]{0,120}\\b${escapeRegExp(cls)}\\b`).test(nonCss);
      if(!used)orphanClasses.push(`${name}: .${cls}`);
    }
  }
  if(orphanClasses.length>8)issue(ctx,'project.orphan-css-class','info','low','Some CSS class names do not appear to be used anywhere else',`I found ${orphanClasses.length} class names that I could not match to the HTML or JavaScript. Dynamic class names can fool this test, so it does not lower the score.`,orphanClasses.slice(0,20).join('\n'),cssEntries[0]?.[0]||'',1,false);

  ran(ctx,'project.inline-style-conflict');
  if(htmlEntries.length&&cssEntries.length){
    const cssText=cssEntries.map(([,text])=>text).join('\n');
    let first=null,count=0;
    for(const [name,text] of htmlEntries){
      for(const m of text.matchAll(/<[^>]+class\s*=\s*["']([^"']+)["'][^>]+style\s*=\s*["']([^"']+)["'][^>]*>/gi)){
        const classes=m[1].split(/\s+/).filter(Boolean),props=declarations(m[2]).map(x=>x.prop);
        const hit=props.some(prop=>classes.some(cls=>new RegExp(`\\.${escapeRegExp(cls)}[^{}]*\\{[^}]*\\b${escapeRegExp(prop)}\\s*:`,`i`).test(cssText)));
        if(hit){count++;first??={name,line:lineOf(text,m.index)}}
      }
    }
    if(count)issue(ctx,'project.inline-style-conflict','info','low','An inline style may be overriding a class style',`${count} element${count===1?' has':'s have'} an inline style for a property that also appears in one of its classes. Inline styles always win, but this can be intentional, so it is review-only.`,`${count} possible inline-vs-class property conflict(s).`,first.name,first.line,false);
  }

  ran(ctx,'project.suspicious-copy-name');
  const suspicious=[...files.keys()].filter(name=>/(?:^|[._\-\s])(backup|copy|old|legacy|temp|tmp|bak|final-final|v\d+)(?:[._\-\s]|$)/i.test(name));
  if(suspicious.length)issue(ctx,'project.suspicious-copy-name','info','low','Some file names look like extra copies or retired versions','These names can be perfectly intentional, but they are worth checking when you want one clean source of truth. Nothing is marked broken just because of the name.',suspicious.slice(0,20).join('\n'),suspicious[0],1,false);

  ran(ctx,'project.duplicate-content');
  const signatures=new Map();
  for(const [name,text] of texts){
    const normalized=text.trim();if(normalized.length<200)continue;
    const signature=`${normalized.length}|${normalized.slice(0,180)}|${normalized.slice(-180)}`;
    if(!signatures.has(signature))signatures.set(signature,[]);signatures.get(signature).push(name);
  }
  const duplicateContent=[...signatures.values()].filter(group=>group.length>1);
  if(duplicateContent.length)issue(ctx,'project.duplicate-content','info','medium','Two source files appear to contain the same code','I found files with matching size, beginning, and ending text. They may be intentional copies, but duplicate source can create confusion about which one should be edited.',duplicateContent.slice(0,10).map(group=>group.join(' = ')).join('\n'),duplicateContent[0][0],1,false);

  ran(ctx,'project.source-map-reference');
  for(const [name,text] of codeEntries){
    const map=text.match(/\/\/#\s*sourceMappingURL\s*=\s*([^\s]+)/);if(!map)continue;
    const ref=map[1];if(!localReference(ref))continue;
    const target=resolve(name,ref);if(!findPath(files,target).found)issue(ctx,'project.source-map-reference','info','low','A built file points to a source map that is not included','This only affects debugging, not normal app use. I found a sourceMappingURL comment whose .map file is missing.','Missing source map: '+target,name,lineOf(text,map.index),false);
  }

  ran(ctx,'project.start-page');
  const pageNames=[...files.keys()].filter(name=>/\.html?$/i.test(name));
  if(pageNames.length>1&&!pageNames.some(name=>/(^|\/)index\.html?$/i.test(name)))issue(ctx,'project.start-page','info','low','This website has pages but no normal index.html start page','The viewer can still open one of the pages, but many web hosts expect index.html as the default page. This does not automatically mean the project is broken.','Multiple HTML pages found without index.html.',pageNames[0],1,false);
}

function mergeRuntime(ctx,runtimeErrors,compileErrors,liveFindings,liveCheckIds=[]){
  for(const id of liveCheckIds||[])if(id)ran(ctx,id);
  ran(ctx,'runtime.javascript-error');
  for(const x of runtimeErrors||[]){
    const kind=x.kind||'javascript-error';
    const message=String(x.message||'Unknown JavaScript error');
    const source=x.file||x.filename||'running page';
    const line=x.line||null;
    if(kind==='resource-error'){
      issue(ctx,'runtime.resource-error',x.local?'error':'info',x.local?'high':'low',x.local?'The running page could not load one of its own files':'An outside file did not load in the preview',x.local?'The page tried to load a local script, stylesheet, image, or other project file and the browser reported that it failed.':'The preview could not load a file from an outside website. Network rules, CORS, or the sandbox can cause this, so it does not lower the score.',message,source,line,x.local!==false);
      continue;
    }
    if(kind==='console-error'){
      issue(ctx,'runtime.console-error','info','low','The running page wrote an error message to the browser console','The app itself called console.error while it was running. Some projects use this for diagnostics, so I show it for review but do not lower the score unless the browser also reports a real runtime failure.',message,source,line,false);
      continue;
    }
    if(kind==='network-error'){
      issue(ctx,'runtime.network-error',x.local?'error':'info',x.local?'high':'low',x.local?'A local request failed while the page was running':'An outside internet request failed in the preview',x.local?'The app tried to reach one of its own local files or routes and the request failed.':'The page could not reach an outside service in this preview. Sandboxes, missing login, CORS, or no internet can cause this, so it does not lower the score automatically.',message,source,line,x.local);
      continue;
    }
    issue(ctx,'runtime.javascript-error','error','high',kind==='unhandled-promise-rejection'?'A background JavaScript task failed without being handled':'JavaScript crashed while the page was running',`The page opened, but the browser reported a real error: “${message}”. A feature that depends on this code may stop working.`,message,source,line);
  }
  if(!(runtimeErrors||[]).length)good(ctx,'runtime.javascript-error','The running page did not report a JavaScript crash during this audit.');

  ran(ctx,'compile.error');
  for(const x of compileErrors||[])issue(ctx,'compile.error','critical','high','A source file could not be compiled','The viewer could not turn one of the source files into browser code. The preview may be incomplete until this compile error is fixed.',String(x.message||'Compile error'),x.file||'unknown',x.line||null);
  if(!(compileErrors||[]).length)good(ctx,'compile.error','The files that needed browser compilation did not report a compile error.');

  for(const x of liveFindings||[]){
    if(!x?.checkId)continue;
    issue(ctx,x.checkId,x.severity||'info',x.confidence||'low',x.title||'Live page check',x.plain||'',x.technical||'',x.file||'',x.line||null,x.scoreImpact!==false);
  }
}

function calculateScore(ctx){
  const byCheck=new Map();
  for(const item of ctx.findings){
    if(item.scoreImpact===false)continue;
    const factor=CONFIDENCE_FACTOR[item.confidence]??0;
    if(!factor)continue;
    const points=Math.ceil((SCORE_WEIGHT[item.severity]||0)*factor);
    byCheck.set(item.checkId,Math.max(byCheck.get(item.checkId)||0,points));
  }
  const penalty=[...byCheck.values()].reduce((sum,n)=>sum+n,0);
  return Math.max(0,Math.min(100,100-penalty));
}

export async function auditProject(files,meta,runtimeErrors=[],compileErrors=[],liveFindings=[],liveCheckIds=[]){
  const ctx={findings:[],keys:new Set(),good:new Set(),ranChecks:new Set(),failedChecks:new Set(),reviewChecks:new Set()};
  const texts=new Map();let codeFiles=0,totalBytes=0;

  for(const [name,file] of files){
    totalBytes+=file.size||0;
    const e=ext(name);if(!TEXT_EXTENSIONS.has(e))continue;
    codeFiles++;
    let text='';try{text=await file.text()}catch{continue}
    texts.set(name,text);
    auditGeneral(name,text,ctx);
    if(e==='html'||e==='htm')auditHtml(name,text,ctx);
    if(e==='css')auditCss(name,text,ctx);
    if(CODE_EXTENSIONS.has(e))auditJs(name,text,ctx);
    if(e==='json')auditJson(name,text,ctx);
  }

  auditCrossProject(files,texts,ctx);
  mergeRuntime(ctx,runtimeErrors,compileErrors,liveFindings,liveCheckIds);

  const score=calculateScore(ctx);
  const hardProblems=ctx.findings.filter(x=>x.scoreImpact!==false&&(CONFIDENCE_FACTOR[x.confidence]||0)>0);
  const reviewItems=ctx.findings.filter(x=>x.scoreImpact===false||x.confidence==='low');
  const verdict=hardProblems.some(x=>x.severity==='critical')?'I found an important problem that needs fixing':score>=95?'Good news — I did not find clear breakage':score>=85?'Mostly healthy — I found a few real problems':score>=70?'I found several problems worth fixing':'I found important problems that need attention';
  const passedChecks=[...ctx.ranChecks].filter(id=>!ctx.failedChecks.has(id));

  return{
    id:makeId(),createdAt:new Date().toISOString(),
    meta:{...meta,codeFiles,totalBytes},score,verdict,
    findings:ctx.findings,
    good:[...ctx.good],
    runtimeErrors,
    checkStats:{run:ctx.ranChecks.size,passed:passedChecks.length,issues:new Set(hardProblems.map(x=>x.checkId)).size,review:new Set(reviewItems.map(x=>x.checkId)).size},
    hardProblemCount:hardProblems.length,
    reviewCount:reviewItems.length
  };
}

export function compareAudits(previous,current){
  if(!previous||!current)return null;
  const key=f=>`${f.checkId||f.title}|${f.file}|${f.line||''}|${f.title}`;
  const prevKeys=new Set((previous.findings||[]).map(key));
  const curKeys=new Set((current.findings||[]).map(key));
  const fixed=[...prevKeys].filter(k=>!curKeys.has(k));
  const added=[...curKeys].filter(k=>!prevKeys.has(k));
  const delta=(current.score||0)-(previous.score||0);
  let recommendation='These two audits are very close. The problem list matters more than the small score difference.';
  if(fixed.length&&!added.length)recommendation=`This version removed ${fixed.length} item${fixed.length===1?'':'s'} from the earlier audit.`;
  else if(added.length&&!fixed.length)recommendation=`This version has ${added.length} new item${added.length===1?'':'s'} to review.`;
  else if(delta>0)recommendation=`This version scored ${delta} point${delta===1?'':'s'} higher and removed ${fixed.length} earlier item${fixed.length===1?'':'s'}.`;
  else if(delta<0)recommendation=`This version scored ${Math.abs(delta)} point${Math.abs(delta)===1?'':'s'} lower. Check the ${added.length} new item${added.length===1?'':'s'} before deciding whether it is worse.`;
  return{delta,fixedCount:fixed.length,newIssueCount:added.length,recommendation,previousScore:previous.score,currentScore:current.score};
}
