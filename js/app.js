import {ProjectRuntime,norm,ext,classify,resolve,mime} from './project-engine.js';
import {DEVICES,deviceCss} from './device-engine.js';
import {auditProject,compareAudits} from './audit-engine.js';
import {Storage} from './storage.js';
import {loadProviderSettings,saveProviderSettings,providerSummary} from './provider-settings.js';

const $=id=>document.getElementById(id);
const runtime=new ProjectRuntime();
const state={current:null,mode:'desktop',adapt:false,scale:1,runtimeErrors:[],audit:null,compare:null,fitMode:'width',desktopWidth:1440,shots:[],controlTests:[],captureErrors:[],captureWaiters:new Map(),renderScore:null,captureAttempted:false,captureCompleted:false,controlsAttempted:false,controlsCompleted:false,controlsFound:0};
const frame=$('frame'),stage=$('desktopStage'),wrap=$('stageWrap'),shell=$('viewerShell'),main=document.querySelector('.main'),auditRail=$('auditRail');

function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
function status(s){$('statusBadge').textContent=s}
function notice(s){$('notice').textContent=s;$('notice').classList.toggle('hidden',!s)}
function bytes(n){if(n<1024)return`${n} B`;if(n<1048576)return`${(n/1024).toFixed(1)} KB`;return`${(n/1048576).toFixed(1)} MB`}
function clearRenderUrl(){for(const [k,u] of [...runtime.urls])if(k.startsWith('render:')){URL.revokeObjectURL(u);runtime.urls.delete(k)}}

function fileDescription(name){
  const lower=name.toLowerCase(),e=ext(name);
  if(/(^|\/)index\.html?$/.test(lower))return'The starting page that opens the website.';
  if(/app\.(tsx|jsx|js|ts)$/.test(lower))return'One of the main files that puts the app screens together.';
  if(/main\.(tsx|jsx|js|ts)$/.test(lower))return'Starts the app and connects it to the page.';
  if(lower.endsWith('package.json'))return'A list of the code tools this project needs.';
  if(lower.includes('vite.config'))return'Instructions for how this website is built.';
  if(lower.includes('electron')||/(^|\/)main\.c?js$/.test(lower))return'Helps a desktop app start and talk to the computer.';
  if(/component|components/.test(lower))return'A reusable piece of a screen, like a table, menu, card, or button area.';
  if(e==='css')return'Controls colors, spacing, fonts, and sizes.';
  if(['js','mjs','ts','tsx','jsx'].includes(e))return'Program code that controls what the app does.';
  if(['png','jpg','jpeg','gif','webp','svg','ico'].includes(e))return'An image or icon used by the project.';
  if(['woff','woff2','ttf','otf'].includes(e))return'A font used to draw words on the screen.';
  if(e==='json')return'A small data or settings file the app reads.';
  if(e==='pdf')return'A PDF document included with the project.';
  if(e==='md'||/^readme/i.test(name.split('/').pop()))return'Notes that explain the project.';
  return'A supporting file used by this project.';
}

function simpleProject(meta){
  if(meta.type==='HTML website')return'This is a website that can usually open right away.';
  if(meta.type==='Multi-page website')return`This is a website with ${meta.pageCount} separate page files. I connect them so you can move around without extracting it first.`;
  if(meta.type==='Vite web application'||meta.type==='React/Node application'||meta.type==='React-style source project')return'This is a React app made from many source files. I compile and combine them in the browser so you can see the real running screen — no build step needed.';
  if(meta.type==='Electron application')return'This is a desktop app. I can test its website-style screen here and separate the computer-only parts.';
  if(meta.type==='Python project')return'This is a Python program. Some parts need a computer-side runner before the full app can be shown.';
  return'This project contains several kinds of files. I map them and explain what each part does.';
}

function cleanProjectToken(value){
  return String(value||'')
    .toLowerCase()
    .replace(/\.(zip|html?|json)$/g,'')
    .replace(/\([^)]*\)$/g,'')
    .replace(/\b(build|version|ver|release|rev|v)\s*[-_.]?\s*\d+(?:[._-]\d+)*/g,'')
    .replace(/\b20\d{2}[-_.]?\d{2}[-_.]?\d{2}\b/g,'')
    .replace(/\b\d+(?:[._-]\d+){1,3}\b/g,'')
    .replace(/[^a-z0-9]+/g,'-')
    .replace(/^-+|-+$/g,'');
}
async function projectIdentity(meta){
  const names=[...runtime.files.keys()];
  const pkgName=names.find(n=>/(^|\/)package\.json$/i.test(n));
  if(pkgName){
    try{
      const pkg=JSON.parse(await runtime.files.get(pkgName).text());
      if(pkg?.name)return`package:${cleanProjectToken(pkg.name)}`;
    }catch{}
  }
  const roots=names.map(n=>n.split('/')[0]).filter(Boolean);
  const commonRoot=roots.length&&roots.every(x=>x===roots[0])&&names.some(n=>n.includes('/'))?roots[0]:'';
  const entry=runtime.entry()==='__synthesized_react__'?(runtime.findReactEntry?.()||'react-project'):(runtime.entry()||names[0]||meta.type);
  const label=commonRoot||entry.split('/').pop()||meta.type;
  return`${meta.type}:${cleanProjectToken(label)||cleanProjectToken(meta.type)}`;
}
function projectLabel(meta){
  const names=[...runtime.files.keys()];
  const roots=names.map(n=>n.split('/')[0]).filter(Boolean);
  if(roots.length&&roots.every(x=>x===roots[0])&&names.some(n=>n.includes('/')))return roots[0];
  const entry=runtime.entry();
  return entry&&entry!=='__synthesized_react__'?entry.split('/').pop():meta.type;
}

function refreshFiles(){
  const el=$('fileList');el.innerHTML='';
  const names=[...runtime.files.keys()].sort();
  $('fileCountLabel').textContent=`${names.length} file${names.length===1?'':'s'}`;
  if(!names.length){el.innerHTML='<div class="small">No files loaded yet.</div>';$('pageTabs').innerHTML='';return}
  const reactEntry=runtime.findReactEntry?.();
  for(const n of names){
    const f=runtime.files.get(n),b=document.createElement('button');
    const isActive=state.current===n||(state.current==='__synthesized_react__'&&n===reactEntry);
    b.className='file-item'+(isActive?' active':'');
    b.title=n;
    b.innerHTML=`<span class="file-path">${esc(n)}</span><span class="file-desc">${esc(fileDescription(n))}</span><span class="file-meta">${esc(f.type||mime(n))} • ${bytes(f.size)}</span>`;
    b.onclick=()=>select(n);
    el.appendChild(b);
  }
  const pages=names.filter(n=>/\.html?$/i.test(n));
  $('pageTabs').innerHTML=pages.length>1?pages.map(p=>`<button class="tab ${state.current===p?'active':''}" data-page="${esc(p)}">${esc(p.split('/').pop())}</button>`).join(''):''  ;
  document.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>select(b.dataset.page));
}

function renderProjectSummary(){
  const meta=classify(runtime.files);
  $('projectSummary').innerHTML=`<strong>${esc(simpleProject(meta))}</strong><div class="small provider-note">${meta.fileCount} file${meta.fileCount===1?'':'s'} found${meta.pageCount?` • ${meta.pageCount} page file${meta.pageCount===1?'':'s'}`:''}.</div><details class="mini-details"><summary>Technical details</summary><div class="small">Detected as: ${esc(meta.type)}<br>Needs: ${esc(meta.runtime)}<br>Starting file: ${esc(runtime.entry()||'not found')}</div></details>`;
  return meta;
}

function waitFor(type,timeout=10000){
  return new Promise(resolve=>{
    const timer=setTimeout(()=>{state.captureWaiters.delete(type);resolve(false)},timeout);
    state.captureWaiters.set(type,payload=>{clearTimeout(timer);state.captureWaiters.delete(type);resolve(payload||true)});
  });
}

async function loadProject(list,{skipConfirm=false}={}){
  if(!list?.length)return;
  if(runtime.files.size&&!skipConfirm&&!confirm('Replace the current temporary project? The older audit will stay in history for comparison.'))return;
  status('Opening…');notice('');state.runtimeErrors=[];state.audit=null;state.compare=null;state.current=null;state.shots=[];state.controlTests=[];state.captureErrors=[];state.renderScore=null;state.captureAttempted=false;state.captureCompleted=false;state.controlsAttempted=false;state.controlsCompleted=false;state.controlsFound=0;renderGallery();renderControlTests();
  try{
    await runtime.addFiles(list);
    refreshFiles();
    const meta=renderProjectSummary();
    status(`${meta.fileCount} files`);
    const entry=runtime.entry();
    if(entry){
      if(entry==='__synthesized_react__')notice('This React project has no index.html — building a preview automatically…');
      await select(entry);
    }
    await runAudit();
  }catch(e){status('Could not open');notice('I could not open this project. '+e.message)}
}

async function select(name){
  const isSynthesized=name==='__synthesized_react__';
  if(isSynthesized){
    const synth=runtime.synthesizeReactHtml();
    if(!synth){notice('Could not find a React entry point (src/main.tsx or similar).');return}
    state.current='__synthesized_react__';state.renderScore=null;refreshFiles();
    status('Building React app…');clearRenderUrl();
    try{
      const inject=state.adapt?deviceCss(state.mode):'';
      const html=await runtime.htmlRewrite(synth,'index.html',inject);
      const u=URL.createObjectURL(new Blob([html],{type:'text/html'}));
      runtime.urls.set('render:__synthesized_react__',u);
      frame.removeAttribute('srcdoc');
      const ready=waitFor('debooger-render-ready',20000);
      await new Promise(r=>{const t=setTimeout(r,3000);frame.onload=()=>{clearTimeout(t);r()};frame.src=u});
      const result=await ready;if(result?.score)state.renderScore=result.score;
      if(runtime.compileErrors.length)notice('Compile errors in '+runtime.compileErrors.map(e=>e.file).join(', ')+'. Check the audit findings.');
      status('Ready');applyDevice();
    }catch(err){status('Open problem');notice(err.message||String(err));frame.srcdoc=`<pre style="white-space:pre-wrap;padding:16px">${esc(String(err))}</pre>`}
    return;
  }
  const clean=norm(name),f=runtime.files.get(clean);
  if(!f)return;
  state.current=clean;state.renderScore=null;refreshFiles();status('Building screen…');clearRenderUrl();
  const e=ext(clean);
  try{
    if(/html?/.test(e)){
      const inject=state.adapt?deviceCss(state.mode):'';
      const html=await runtime.htmlRewrite(await f.text(),clean,inject);
      const u=URL.createObjectURL(new Blob([html],{type:'text/html'}));
      runtime.urls.set('render:'+clean,u);
      frame.removeAttribute('srcdoc');
      const ready=waitFor('debooger-render-ready',14000);
      await new Promise(r=>{const t=setTimeout(r,2500);frame.onload=()=>{clearTimeout(t);r()};frame.src=u});
      const result=await ready;if(result?.score)state.renderScore=result.score;
    } else if((f.type||'').startsWith('image/')||['png','jpg','jpeg','gif','webp','svg','ico'].includes(e)){
      const u=runtime.objectUrl(clean);
      frame.srcdoc=`<!doctype html><html><body style="margin:0;background:white"><img src="${u}" style="max-width:100%;height:auto;display:block;margin:20px auto"></body></html>`;
    } else if(e==='pdf'){
      frame.removeAttribute('srcdoc');frame.src=runtime.objectUrl(clean);
    } else {
      const t=await f.text();
      frame.srcdoc=`<!doctype html><html><body style="margin:0"><pre style="white-space:pre-wrap;word-break:break-word;margin:0;padding:16px;font:13px/1.5 ui-monospace;background:#101317;color:#e7edf3;min-height:100vh">${esc(t)}</pre></body></html>`;
    }
    status('Ready');applyDevice();
  }catch(err){status('Open problem');notice(err.message||String(err));frame.srcdoc=`<pre style="white-space:pre-wrap;padding:16px">${esc(String(err))}</pre>`}
}

function deviceSize(){return state.mode==='desktop'?{...DEVICES.desktop,width:state.desktopWidth}:DEVICES[state.mode]}
function applyDevice(){
  const d=deviceSize();
  stage.style.width=d.width+'px';stage.style.height=d.height+'px';
  frame.style.width=d.width+'px';frame.style.height=d.height+'px';
  document.querySelectorAll('.device-btn').forEach(b=>b.classList.toggle('active',b.dataset.device===state.mode));
  $('desktopWidth').disabled=state.mode!=='desktop';
  applyFit();
}
function applyFit(){
  requestAnimationFrame(()=>{
    const d=deviceSize(),availableW=Math.max(280,shell.clientWidth-4),availableH=Math.max(300,shell.clientHeight-4);
    state.scale=state.fitMode==='actual'?1:state.fitMode==='page'?Math.min(1,availableW/d.width,availableH/d.height):Math.min(1,availableW/d.width);
    stage.style.transform=`scale(${state.scale})`;wrap.style.width=(d.width*state.scale)+'px';wrap.style.height=(d.height*state.scale)+'px';
  });
}
async function setDevice(mode){state.mode=mode;state.adapt=$('adaptToggle').checked;applyDevice();if(state.current)await select(state.current)}
function setFit(mode){state.fitMode=mode;applyFit()}

async function captureCurrent(label){
  const isSynth=state.current==='__synthesized_react__';
  if(!state.current||(!/\.html?$/i.test(state.current)&&!isSynth))return false;
  state.captureAttempted=true;
  const waiting=waitFor('debooger-capture-finished',16000);
  frame.contentWindow?.postMessage({type:'debooger-capture',label},'*');
  const result=await waiting;
  if(result)state.captureCompleted=true;
  return result;
}
async function testCurrentControls(){
  const isSynth=state.current==='__synthesized_react__';
  if(!state.current||(!/\.html?$/i.test(state.current)&&!isSynth))return false;
  state.controlsAttempted=true;
  const waiting=waitFor('debooger-controls-finished',45000);
  frame.contentWindow?.postMessage({type:'debooger-test-controls'},'*');
  const result=await waiting;
  if(result){state.controlsCompleted=true;state.controlsFound=Number(result.count||0)}
  return result;
}

async function captureAuditScreens(){
  state.shots=[];state.controlTests=[];state.captureErrors=[];state.captureAttempted=false;state.captureCompleted=false;state.controlsAttempted=false;state.controlsCompleted=false;state.controlsFound=0;renderGallery();renderControlTests();
  let pages=[...runtime.files.keys()].filter(n=>/\.html?$/i.test(n));
  if(!pages.length&&runtime.isReactSourceProject())pages=['__synthesized_react__'];
  if(!pages.length)return 0;
  const start=state.current;
  for(let i=0;i<pages.length;i++){
    await select(pages[i]);
    status(`Photographing ${i+1}/${pages.length}…`);
    await captureCurrent(pages[i]);
    if(i===0){status('Testing safe buttons…');await testCurrentControls()}
  }
  const validStart=start&&(runtime.files.has(start)||start==='__synthesized_react__');
  if(validStart)await select(start);
  return state.shots.length;
}

function renderLooksReal(){const s=state.renderScore;return !!s&&(s.text>=20||s.visible>=8)&&s.width>20&&s.height>20}
function finalizeAuditScore(audit){
  audit.sourceScore=audit.score;
  audit.visualComplete=state.captureCompleted&&state.shots.length>0;
  audit.controlsComplete=!state.controlsAttempted||state.controlsCompleted;
  audit.controlsFound=state.controlsFound;
  if(!audit.visualComplete){audit.score=Math.min(audit.score,89);audit.verdict='Visual test incomplete'}
  if(state.controlsAttempted&&!state.controlsCompleted){audit.score=Math.min(audit.score,84);audit.verdict='Runtime test incomplete'}
  return audit;
}

async function runAudit(){
  if(!runtime.files.size)return;
  status('Checking everything…');
  const meta=classify(runtime.files);
  meta.projectKey=await projectIdentity(meta);meta.projectLabel=projectLabel(meta);
  const previous=Storage.history().find(x=>x.meta?.projectKey===meta.projectKey)||null;
  const audit=await auditProject(runtime.files,meta,state.runtimeErrors,runtime.compileErrors);
  state.audit=audit;state.compare=null;renderAudit();
  let shotCount=0;
  const isReact=['Vite web application','React/Node application','React-style source project'].includes(meta.type);
  if(renderLooksReal()||!isReact||runtime.isReactSourceProject())shotCount=await captureAuditScreens();
  audit.screenshotCount=shotCount;finalizeAuditScore(audit);state.compare=compareAudits(previous,audit);
  status('Saving audit…');
  await Storage.saveSnapshot(audit,runtime.files);
  const history=Storage.pushAudit(audit);await Storage.pruneSnapshots(history.slice(0,6).map(x=>x.snapshotId));renderHistory();
  if(audit.visualComplete&&audit.controlsComplete){status('Audit complete');notice('')}
  else if(!audit.visualComplete){status('Code checked • visual test incomplete');const last=state.captureErrors.at(-1);notice(last?`Screenshot capture failed: ${last.message}`:'The source checks finished, but the preview did not return a screenshot result. The overall score is capped until a real rendered screenshot is captured.')}
  else{status('Visual check complete • control test incomplete');notice('The page rendered and screenshots worked, but the safe-control test did not finish. The overall score is capped until runtime interaction testing completes.')}
  renderAudit();
}

function renderAudit(){
  const a=state.audit;if(!a)return;
  const cls=a.score>=90?'good':a.score>=70?'warn':'bad';
  $('scoreBox').innerHTML=`<div class="score ${cls}">${a.score}</div><div class="small">${esc(a.verdict)}${a.screenshotCount!=null?` • ${a.screenshotCount} screenshot${a.screenshotCount===1?'':'s'}`:''}</div>`;
  $('metrics').innerHTML=`<div class="metric"><b>${a.meta.fileCount}</b><span>Files checked</span></div><div class="metric"><b>${a.findings.length}</b><span>Things to review</span></div><div class="metric"><b>${a.good.length}</b><span>Good checks</span></div><div class="metric"><b>${a.meta.pageCount}</b><span>Page files</span></div>`;
  const LIMIT=30,top=a.findings.slice(0,LIMIT),hidden=a.findings.length-top.length;
  $('findings').innerHTML=(top.length?top.map(f=>`<details class="finding ${f.severity==='critical'||f.severity==='error'?'bad':f.severity==='warning'?'warn':'good'}"><summary><strong>${esc(f.title)}</strong><div class="simple-line">${esc(f.plain)}</div></summary><p>${f.file?`File: ${esc(f.file)}${f.line?` • line ${f.line}`:''}<br>`:''}${f.technical?`Developer detail: ${esc(f.technical)}`:'Tap only when you need the technical reason.'}</p></details>`).join(''):'<div class="finding good"><summary><strong>No obvious source-code problems found</strong><div class="simple-line">The automatic code checks did not find a clear problem.</div></summary></div>')+(hidden>0?`<div class="small" style="padding:8px 10px;color:var(--muted)">…and ${hidden} more item${hidden===1?'':'s'}. Download the report to see all.</div>`:'');
  if(state.compare){$('compareBox').classList.remove('hidden');$('compareBox').innerHTML=`<details class="finding ${state.compare.delta>=0?'good':'warn'}"><summary><strong>${esc(state.compare.recommendation)}</strong><div class="simple-line">Tap to see the numbers behind this recommendation.</div></summary><p>Older score: ${state.compare.previousScore} • This score: ${state.compare.currentScore} • Fixed: ${state.compare.fixedCount} • New problems: ${state.compare.newIssueCount}</p></details>`}
  else $('compareBox').classList.add('hidden');
}
function renderGallery(){
  $('shotCount').textContent=String(state.shots.length);
  $('gallery').innerHTML=state.shots.length?state.shots.map((s,i)=>`<button class="shot" data-shot="${i}"><img src="${s.data}" alt="${esc(s.label)}"><span>${esc(s.label)}</span></button>`).join(''):'<div class="small">Screenshots will appear automatically during the audit.</div>';
  document.querySelectorAll('#gallery [data-shot]').forEach(b=>b.onclick=()=>openShot(Number(b.dataset.shot)));
}
function renderControlTests(){
  const tested=state.controlTests.filter(x=>x.label!=='Safe control discovery').length;
  $('controlCount').textContent=String(tested);
  $('controlList').innerHTML=state.controlTests.length?state.controlTests.map(x=>`<div class="control-test ${x.status==='FAIL'?'bad':x.status==='PASS'?'good':'warn'}"><strong>${esc(x.label||'Control')}</strong><div class="small">${esc(x.status)}${x.detail?` • ${esc(x.detail)}`:''}</div></div>`).join(''):'<div class="small">Safe controls will be tested automatically with before and after screenshots.</div>';
}
function openShot(i){const s=state.shots[i];if(!s)return;$('shotTitle').textContent=s.label;$('shotImage').src=s.data;$('shotModal').classList.remove('hidden')}
function closeShot(){$('shotModal').classList.add('hidden');$('shotImage').removeAttribute('src')}
function renderHistory(){const h=Storage.history();$('history').innerHTML=h.length?h.slice(0,6).map(x=>`<button class="history-item history-open" data-history-id="${esc(x.snapshotId||'')}" ${x.snapshotId?'':'disabled'}><strong>${esc(x.meta?.projectLabel||simpleProject(x.meta))}</strong><div class="small">${new Date(x.createdAt).toLocaleString()} • Score ${x.score}${x.screenshotCount!=null?` • ${x.screenshotCount} screenshots`:''}${x.snapshotId?' • Tap to reopen saved ZIP':' • Older record only'}</div></button>`).join(''):'<div class="small">No older audits saved on this device.</div>'}
async function openHistorySnapshot(id){if(!id)return;status('Opening saved project…');const saved=await Storage.getSnapshot(id);if(!saved?.blob){status('Saved ZIP unavailable');notice('This older audit was saved before project ZIP history was added, so its files cannot be reopened automatically.');return}const file=new File([saved.blob],saved.name||'saved-project.zip',{type:'application/zip'});await loadProject([file],{skipConfirm:true})}

function buildReport(){
  const a=state.audit;if(!a)return'No audit has been run yet.';
  let s=`DEBOOGER2000 AUDIT\n\nWHAT THIS IS\n${simpleProject(a.meta)}\n${a.meta.fileCount} files, ${a.meta.pageCount} page files\n\nSCORE\n${a.score}/100 — ${a.verdict}\nSCREENSHOTS\n${state.shots.length}\n\nCONTROL TESTS\n${state.controlTests.length?state.controlTests.map(x=>'• '+x.status+' — '+x.label+(x.detail?' — '+x.detail:'')).join('\n'):'• No safe controls were available to test'}\n\nGOOD\n${a.good.map(x=>'• '+x).join('\n')||'• No positive checks recorded'}\n\nWHAT NEEDS ATTENTION\n`;
  s+=a.findings.map((f,i)=>`${i+1}. ${f.title}\n   ${f.plain}${f.file?`\n   File: ${f.file}${f.line?` line ${f.line}`:''}`:''}${f.technical?`\n   Developer detail: ${f.technical}`:''}`).join('\n\n')||'No obvious issues found.';
  if(state.compare)s+=`\n\nVERSION COMPARISON\n${state.compare.recommendation}\nOlder: ${state.compare.previousScore} | Current: ${state.compare.currentScore} | Fixed: ${state.compare.fixedCount} | New: ${state.compare.newIssueCount}`;
  return s;
}
async function copyReport(){
  const report=buildReport();
  try{if(!navigator.clipboard?.writeText)throw new Error('Clipboard API unavailable');await navigator.clipboard.writeText(report);status('Copied');return true}catch{}
  const ta=document.createElement('textarea');ta.value=report;ta.setAttribute('readonly','');ta.style.position='fixed';ta.style.left='-9999px';ta.style.top='0';document.body.appendChild(ta);ta.focus();ta.select();ta.setSelectionRange(0,ta.value.length);
  let copied=false;try{copied=document.execCommand('copy')===true}catch{}ta.remove();
  if(copied){status('Copied');return true}status('Copy blocked');notice('Your browser blocked automatic copy. Press and hold the audit text, then choose Copy.');return false;
}
async function downloadReport(){
  const report=buildReport(),file=new File([report],'debooger2000-audit.txt',{type:'text/plain;charset=utf-8'});
  const isiOS=/iPad|iPhone|iPod/.test(navigator.userAgent)||navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1;
  if(isiOS&&navigator.share&&navigator.canShare?.({files:[file]})){try{await navigator.share({files:[file],title:'debooger2000 audit'});status('Report ready to save');return true}catch(e){if(e?.name==='AbortError')return false}}
  const url=URL.createObjectURL(file),a=document.createElement('a');a.href=url;a.download=file.name;a.rel='noopener';a.style.display='none';document.body.appendChild(a);
  try{a.click();status('Download started');return true}catch{window.open(url,'_blank');status('Report opened');return true}finally{a.remove();setTimeout(()=>URL.revokeObjectURL(url),15000)}
}
function renderProviders(){const p=loadProviderSettings();$('groqEnabled').checked=!!p.groq?.enabled;$('groqKey').value=p.groq?.key||'';$('googleEnabled').checked=!!p.google?.enabled;$('googleKey').value=p.google?.key||'';$('providerStatus').textContent=providerSummary(p)}
function saveProviders(){const p={groq:{enabled:$('groqEnabled').checked,key:$('groqKey').value.trim()},google:{enabled:$('googleEnabled').checked,key:$('googleKey').value.trim()}};saveProviderSettings(p);$('providerStatus').textContent=providerSummary(p);status('AI setting ready')}
function clearProject(){
  if(runtime.files.size&&!confirm('Clear this temporary project? Older audit history will stay.'))return;
  runtime.clear();state.current=null;state.runtimeErrors=[];state.audit=null;state.compare=null;state.shots=[];state.controlTests=[];state.captureErrors=[];state.renderScore=null;state.captureAttempted=false;state.captureCompleted=false;state.controlsAttempted=false;state.controlsCompleted=false;state.controlsFound=0;
  refreshFiles();renderGallery();renderControlTests();$('projectSummary').innerHTML='<div class="small">Open something and I will explain it in simple English.</div>';$('scoreBox').innerHTML='<div class="score">—</div><div class="small">Open a project to begin.</div>';$('metrics').innerHTML='';$('findings').innerHTML='<div class="small">Problems will be explained here in simple English. Tap one for the detailed reason.</div>';$('compareBox').classList.add('hidden');frame.srcdoc=welcomeHtml();notice('');status('Ready');
}
function welcomeHtml(){return'<!doctype html><html><body style="font-family:Inter,system-ui;padding:42px"><h1 style="font-size:24px">debooger2000</h1><p>Open a project to see the real pages, check the files, and explain what needs attention.</p></body></html>'}
function openPasteModal(){$('moreModal').classList.add('hidden');$('pasteModal').classList.remove('hidden');if(navigator.clipboard?.readText)navigator.clipboard.readText().then(t=>{if(!t)return;if(/^https?:\/\//i.test(t.trim())){$('pasteLink').value=t.trim();switchPaste('link')}else if(!$('pasteText').value)$('pasteText').value=t}).catch(()=>{})}
function closePasteModal(){$('pasteModal').classList.add('hidden')}
function switchPaste(mode){document.querySelectorAll('.paste-tab').forEach(b=>b.classList.toggle('active',b.dataset.paste===mode));$('pasteTextPanel').classList.toggle('hidden',mode!=='text');$('pasteLinkPanel').classList.toggle('hidden',mode!=='link')}
async function openPastedText(){const text=$('pasteText').value;if(!text.trim())return;const type=$('pasteType').value,name=`pasted.${type}`,file=new File([text],name,{type:mime(name)});closePasteModal();await loadProject([file])}
async function openPastedLink(){const url=$('pasteLink').value.trim();if(!/^https?:\/\//i.test(url)){notice('Paste a full web link.');return}status('Opening link…');try{const res=await fetch(url,{credentials:'omit'});if(!res.ok)throw new Error(`The link returned ${res.status}`);const blob=await res.blob();let name='download';try{name=decodeURIComponent(new URL(url).pathname.split('/').pop()||'download')}catch{}if(!ext(name)){if(blob.type.includes('zip'))name+='.zip';else if(blob.type.includes('html'))name+='.html';else name+='.bin'}closePasteModal();await loadProject([new File([blob],name,{type:blob.type||mime(name)})])}catch{status('Link blocked');notice('I could not open that link directly. Open or share the actual file instead.')}}
async function toggleFullScreen(){const entering=!main.classList.contains('viewer-full');main.classList.toggle('viewer-full',entering);document.body.classList.toggle('full-active',entering);$('exitFullBtn').classList.toggle('hidden',!entering);if(entering&&document.documentElement.requestFullscreen)try{await document.documentElement.requestFullscreen()}catch{}if(!entering&&document.fullscreenElement)try{await document.exitFullscreen()}catch{}setTimeout(applyFit,100)}
function openMore(){$('moreModal').classList.remove('hidden')}
function closeMore(){$('moreModal').classList.add('hidden')}

window.addEventListener('message',e=>{
  if(e.source!==frame.contentWindow)return;
  const d=e.data||{};
  if(d.type==='debooger-nav'){const p=norm(resolve(d.base,d.href));if(runtime.files.has(p))select(p)}
  else if(d.type==='debooger-runtime-error'){state.runtimeErrors.push(d);status('Running problem found')}
  else if(d.type==='debooger-screenshot'&&d.data){state.shots.push({label:d.label||'Screen',data:d.data,score:d.score||null,phase:d.phase||''});renderGallery()}
  else if(d.type==='debooger-screenshot-error'){state.captureErrors.push({label:d.label||'Screen',phase:d.phase||'',message:d.message||'Unknown capture error'});notice('Screenshot failed: '+(d.message||'Unknown capture error'))}
  else if(d.type==='debooger-control-result'){state.controlTests.push(d.result);renderControlTests()}
  if(state.captureWaiters.has(d.type))state.captureWaiters.get(d.type)(d);
});

['dragenter','dragover'].forEach(v=>$('dropzone').addEventListener(v,e=>{e.preventDefault();$('dropzone').classList.add('drag')}));
['dragleave','drop'].forEach(v=>$('dropzone').addEventListener(v,e=>{e.preventDefault();$('dropzone').classList.remove('drag')}));
$('dropzone').addEventListener('drop',e=>loadProject(e.dataTransfer.files));
$('fileInput').onchange=e=>loadProject(e.target.files);$('folderInput').onchange=e=>loadProject(e.target.files);$('folderBtn').onclick=()=>$('folderInput').click();$('pasteInlineBtn').onclick=openPasteModal;$('clearInlineBtn').onclick=()=>{closeMore();clearProject()};$('clearBtn').onclick=clearProject;$('adaptToggle').onchange=()=>setDevice(state.mode);$('saveProviders').onclick=saveProviders;$('pasteBtn').onclick=openPasteModal;$('moreBtn').onclick=openMore;$('closeMoreBtn').onclick=closeMore;$('moreModal').addEventListener('click',e=>{if(e.target===$('moreModal'))closeMore()});$('closePasteBtn').onclick=closePasteModal;$('pasteModal').addEventListener('click',e=>{if(e.target===$('pasteModal'))closePasteModal()});document.querySelectorAll('.paste-tab').forEach(b=>b.onclick=()=>switchPaste(b.dataset.paste));$('openPasteTextBtn').onclick=openPastedText;$('openPasteLinkBtn').onclick=openPastedLink;$('fullBtn').onclick=toggleFullScreen;$('exitFullBtn').onclick=toggleFullScreen;$('fitWidthBtn').onclick=()=>setFit('width');$('fitPageBtn').onclick=()=>setFit('page');$('actualBtn').onclick=()=>setFit('actual');$('desktopWidth').onchange=e=>{state.desktopWidth=Number(e.target.value)||1440;applyDevice()};document.querySelectorAll('.device-btn').forEach(b=>b.onclick=()=>setDevice(b.dataset.device));$('closeShotBtn').onclick=closeShot;$('shotModal').addEventListener('click',e=>{if(e.target===$('shotModal'))closeShot()});document.addEventListener('click',async e=>{const actionButton=e.target.closest?.('[data-audit-action]');if(actionButton){e.preventDefault();const action=actionButton.dataset.auditAction;if(action==='audit')await runAudit();else if(action==='copy')await copyReport();else if(action==='download')await downloadReport();return}const historyButton=e.target.closest?.('[data-history-id]');if(historyButton&&!historyButton.disabled){e.preventDefault();await openHistorySnapshot(historyButton.dataset.historyId)}});window.addEventListener('resize',applyFit);document.addEventListener('fullscreenchange',()=>{if(!document.fullscreenElement&&main.classList.contains('viewer-full')&&document.fullscreenEnabled){main.classList.remove('viewer-full');document.body.classList.remove('full-active');$('exitFullBtn').classList.add('hidden');applyFit()}});
renderHistory();renderProviders();refreshFiles();renderGallery();renderControlTests();applyDevice();frame.srcdoc=welcomeHtml();
