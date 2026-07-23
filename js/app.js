import {ProjectRuntime,norm,ext,classify,resolve,mime} from './project-engine.js';
import {DEVICES,deviceCss} from './device-engine.js';
import {auditProject,compareAudits} from './audit-engine.js';
import {Storage} from './storage.js';
import {loadProviderSettings,saveProviderSettings,providerSummary} from './provider-settings.js';

const $=id=>document.getElementById(id);
const runtime=new ProjectRuntime();
const state={current:null,mode:'desktop',adapt:false,scale:1,runtimeErrors:[],audit:null,compare:null,fitMode:'width',desktopWidth:1440};
const frame=$('frame'),stage=$('desktopStage'),wrap=$('stageWrap'),shell=$('viewerShell'),main=document.querySelector('.main');

function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
function status(s){$('statusBadge').textContent=s}
function notice(s){$('notice').textContent=s;$('notice').classList.toggle('hidden',!s)}
function clearRuntimeUrls(){for(const [k,u] of [...runtime.urls]){if(k.startsWith('render:')){URL.revokeObjectURL(u);runtime.urls.delete(k)}}}

function refreshFiles(){
  const el=$('fileList');el.innerHTML='';
  const names=[...runtime.files.keys()].sort();
  if(!names.length){el.innerHTML='<div class="small">No files loaded yet.</div>';$('pageTabs').innerHTML='';return}
  for(const n of names){const b=document.createElement('button');b.className='file-item'+(state.current===n?' active':'');b.textContent=n;b.title=n;b.onclick=()=>select(n);el.appendChild(b)}
  const pages=names.filter(n=>/\.html?$/i.test(n));
  $('pageTabs').innerHTML=pages.length>1?pages.map(p=>`<button class="tab ${state.current===p?'active':''}" data-page="${esc(p)}">${esc(p.split('/').pop())}</button>`).join(''):'';
  document.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>select(b.dataset.page));
}

function renderProjectSummary(){
  const meta=classify(runtime.files);
  $('projectSummary').innerHTML=`<div class="finding good"><strong>${esc(meta.type)}</strong><p>${meta.fileCount} files • ${meta.pageCount} page${meta.pageCount===1?'':'s'} • ${esc(meta.runtime)}<br>Starting file: ${esc(runtime.entry()||'not detected')}</p></div>`;
  return meta;
}

async function loadProject(list,{skipConfirm=false}={}){
  if(!list?.length)return;
  if(runtime.files.size&&!skipConfirm&&!confirm('Replace the current temporary project? The previous audit stays in history for comparison.'))return;
  status('Opening project…');notice('');state.runtimeErrors=[];state.audit=null;state.compare=null;state.current=null;
  try{
    await runtime.addFiles(list);refreshFiles();const meta=renderProjectSummary();status(`${meta.fileCount} files loaded`);
    const entry=runtime.entry();if(entry)await select(entry);
    await runAudit();
  }catch(e){status('Could not open');notice('This project could not be opened: '+e.message)}
}

async function select(name){
  const clean=norm(name),f=runtime.files.get(clean);if(!f)return;
  state.current=clean;refreshFiles();status('Rendering…');clearRuntimeUrls();const e=ext(clean);
  try{
    if(/html?/.test(e)){
      const inject=state.adapt?deviceCss(state.mode):'';
      const src=await runtime.htmlRewrite(await f.text(),clean,inject);
      const u=URL.createObjectURL(new Blob([src],{type:'text/html'}));runtime.urls.set('render:'+clean,u);frame.removeAttribute('srcdoc');frame.src=u;
    }else if((f.type||'').startsWith('image/')||['png','jpg','jpeg','gif','webp','svg','ico'].includes(e)){
      const u=await runtime.objectUrl(clean);frame.srcdoc=`<!doctype html><html><body style="margin:0;background:white"><img src="${u}" style="max-width:100%;height:auto;display:block;margin:20px auto"></body></html>`;
    }else if(e==='pdf'){
      frame.removeAttribute('srcdoc');frame.src=await runtime.objectUrl(clean);
    }else{
      const t=await f.text();frame.srcdoc=`<!doctype html><html><body style="margin:0"><pre style="white-space:pre-wrap;word-break:break-word;margin:0;padding:16px;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:#101317;color:#e7edf3;min-height:100vh">${esc(t)}</pre></body></html>`;
    }
    status('Ready');applyDevice();
  }catch(err){status('Render error');frame.srcdoc=`<pre style="white-space:pre-wrap;padding:16px">${esc(String(err))}</pre>`}
}

function deviceSize(){
  if(state.mode==='desktop')return{...DEVICES.desktop,width:state.desktopWidth};
  return DEVICES[state.mode];
}
function applyDevice(){
  const d=deviceSize();stage.style.width=d.width+'px';stage.style.height=d.height+'px';frame.style.width=d.width+'px';frame.style.height=d.height+'px';
  document.querySelectorAll('.device-btn').forEach(b=>b.classList.toggle('active',b.dataset.device===state.mode));
  $('desktopWidth').disabled=state.mode!=='desktop';applyFit();
}
function applyFit(){
  requestAnimationFrame(()=>{
    const d=deviceSize(),availableW=Math.max(280,shell.clientWidth-4),availableH=Math.max(300,shell.clientHeight-4);
    if(state.fitMode==='actual')state.scale=1;
    else if(state.fitMode==='page')state.scale=Math.min(1,availableW/d.width,availableH/d.height);
    else state.scale=Math.min(1,availableW/d.width);
    stage.style.transform=`scale(${state.scale})`;wrap.style.width=(d.width*state.scale)+'px';wrap.style.height=(d.height*state.scale)+'px';
  });
}
async function setDevice(mode){state.mode=mode;state.adapt=$('adaptToggle').checked;applyDevice();if(state.current)await select(state.current)}
function setFit(mode){state.fitMode=mode;applyFit()}

async function runAudit(){
  if(!runtime.files.size)return;
  status('Auditing…');const meta=classify(runtime.files);const audit=await auditProject(runtime.files,meta,state.runtimeErrors);const previous=Storage.history()[0]||null;
  state.audit=audit;state.compare=compareAudits(previous,audit);Storage.pushAudit(audit);renderAudit();renderHistory();status('Audit complete');
}
function renderAudit(){
  const a=state.audit;if(!a)return;const cls=a.score>=90?'good':a.score>=70?'warn':'bad';
  $('scoreBox').innerHTML=`<div class="score ${cls}">${a.score}</div><div class="small">${esc(a.verdict)}</div>`;
  $('metrics').innerHTML=`<div class="metric"><b>${a.meta.fileCount}</b><span>Files</span></div><div class="metric"><b>${a.findings.length}</b><span>Findings</span></div><div class="metric"><b>${a.good.length}</b><span>Good checks</span></div><div class="metric"><b>${a.meta.pageCount}</b><span>Pages</span></div>`;
  const top=a.findings.slice(0,30);
  $('findings').innerHTML=top.length?top.map(f=>`<div class="finding ${f.severity==='critical'||f.severity==='error'?'bad':f.severity==='warning'?'warn':'good'}"><strong>${esc(f.title)}</strong><p>${esc(f.plain)}${f.file?`<br><span class="tag">${esc(f.file)}${f.line?':'+f.line:''}</span>`:''}${f.technical?`<br><span class="small">${esc(f.technical)}</span>`:''}</p></div>`).join(''):'<div class="finding good"><strong>No obvious problems found</strong><p>The automatic source checks did not find a clear issue.</p></div>';
  if(state.compare){$('compareBox').classList.remove('hidden');$('compareBox').innerHTML=`<div class="finding ${state.compare.delta>=0?'good':'warn'}"><strong>${esc(state.compare.recommendation)}</strong><p>Previous score: ${state.compare.previousScore} • Current score: ${state.compare.currentScore} • Fixed: ${state.compare.fixedCount} • New issues: ${state.compare.newIssueCount}</p></div>`}else $('compareBox').classList.add('hidden');
}
function renderHistory(){
  const h=Storage.history();$('history').innerHTML=h.length?h.slice(0,6).map(x=>`<div class="history-item"><strong>${esc(x.meta.type)}</strong><div class="small">${new Date(x.createdAt).toLocaleString()} • Score ${x.score}</div></div>`).join(''):'<div class="small">No previous audits saved on this device.</div>';
}
function buildReport(){
  const a=state.audit;if(!a)return'No audit has been run yet.';
  let s=`DEBOOGER2000 AUDIT\n\nWHAT THIS IS\n${a.meta.type}\n${a.meta.fileCount} files, ${a.meta.pageCount} pages\n\nSCORE\n${a.score}/100 — ${a.verdict}\n\nGOOD\n${a.good.map(x=>'• '+x).join('\n')||'• No positive checks recorded'}\n\nWHAT NEEDS ATTENTION\n`;
  s+=a.findings.map((f,i)=>`${i+1}. ${f.title}\n   ${f.plain}${f.file?`\n   File: ${f.file}${f.line?` line ${f.line}`:''}`:''}${f.technical?`\n   Technical: ${f.technical}`:''}`).join('\n\n')||'No obvious issues found.';
  if(state.compare)s+=`\n\nVERSION COMPARISON\n${state.compare.recommendation}\nPrevious: ${state.compare.previousScore} | Current: ${state.compare.currentScore} | Fixed: ${state.compare.fixedCount} | New: ${state.compare.newIssueCount}`;
  return s;
}
async function copyReport(){try{await navigator.clipboard.writeText(buildReport());status('Copied')}catch{const ta=document.createElement('textarea');ta.value=buildReport();document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();status('Copied')}}
function downloadReport(){const b=new Blob([buildReport()],{type:'text/plain'}),a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='debooger2000-audit.txt';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}

function renderProviders(){const p=loadProviderSettings();$('groqEnabled').checked=!!p.groq?.enabled;$('groqKey').value=p.groq?.key||'';$('googleEnabled').checked=!!p.google?.enabled;$('googleKey').value=p.google?.key||'';$('providerStatus').textContent=providerSummary(p)}
function saveProviders(){const p={groq:{enabled:$('groqEnabled').checked,key:$('groqKey').value.trim()},google:{enabled:$('googleEnabled').checked,key:$('googleKey').value.trim()}};saveProviderSettings(p);$('providerStatus').textContent=providerSummary(p);status('AI settings saved locally')}

function clearProject(){
  if(runtime.files.size&&!confirm('Clear the current temporary project? Saved audit history will stay on this device.'))return;
  runtime.clear();state.current=null;state.runtimeErrors=[];state.audit=null;state.compare=null;refreshFiles();$('projectSummary').innerHTML='<div class="small">Open something and debooger2000 will explain what it is.</div>';$('scoreBox').innerHTML='<div class="score">—</div><div class="small">Run an audit to begin.</div>';$('metrics').innerHTML='';$('findings').innerHTML='<div class="small">Problems are explained here in easy English. Technical details stay attached when useful.</div>';$('compareBox').classList.add('hidden');frame.srcdoc=welcomeHtml();notice('');status('Ready');
}
function welcomeHtml(){return'<!doctype html><html><body style="font-family:Inter,system-ui;padding:42px"><h1 style="font-size:24px">debooger2000</h1><p>Open a project to reconstruct, preview, audit and compare it.</p></body></html>'}

function openPasteModal(){
  $('pasteModal').classList.remove('hidden');
  if(navigator.clipboard?.readText)navigator.clipboard.readText().then(t=>{if(!t)return;if(/^https?:\/\//i.test(t.trim())){$('pasteLink').value=t.trim();switchPaste('link')}else if(!$('pasteText').value)$('pasteText').value=t}).catch(()=>{});
}
function closePasteModal(){$('pasteModal').classList.add('hidden')}
function switchPaste(mode){document.querySelectorAll('.paste-tab').forEach(b=>b.classList.toggle('active',b.dataset.paste===mode));$('pasteTextPanel').classList.toggle('hidden',mode!=='text');$('pasteLinkPanel').classList.toggle('hidden',mode!=='link')}
async function openPastedText(){const text=$('pasteText').value;if(!text.trim())return;const type=$('pasteType').value,name=`pasted.${type}`,file=new File([text],name,{type:mime(name)});closePasteModal();await loadProject([file])}
async function openPastedLink(){
  const url=$('pasteLink').value.trim();if(!/^https?:\/\//i.test(url)){notice('Paste a full http:// or https:// link.');return}
  status('Opening link…');
  try{const res=await fetch(url,{credentials:'omit'});if(!res.ok)throw new Error(`The link returned ${res.status}`);const blob=await res.blob();let name='download';try{name=decodeURIComponent(new URL(url).pathname.split('/').pop()||'download')}catch{}if(!ext(name)){const ct=blob.type;if(ct.includes('zip'))name+='.zip';else if(ct.includes('html'))name+='.html';else name+='.bin'}const file=new File([blob],name,{type:blob.type||mime(name)});closePasteModal();await loadProject([file])}catch(e){status('Link blocked');notice('This link could not be opened directly. It may be private, temporary, expired, or blocked from other websites. Open or share the actual file instead. '+e.message)}
}

async function toggleFullScreen(){
  const entering=!main.classList.contains('viewer-full');
  main.classList.toggle('viewer-full',entering);$('exitFullBtn').classList.toggle('hidden',!entering);
  if(entering&&document.documentElement.requestFullscreen){try{await document.documentElement.requestFullscreen()}catch{}}
  if(!entering&&document.fullscreenElement){try{await document.exitFullscreen()}catch{}}
  setTimeout(applyFit,80);
}

window.addEventListener('message',e=>{if(e.data?.type==='debooger-nav'){const p=norm(resolve(e.data.base,e.data.href));if(runtime.files.has(p))select(p)}if(e.data?.type==='debooger-runtime-error'){state.runtimeErrors.push(e.data);status('Runtime issue captured')}});
['dragenter','dragover'].forEach(v=>$('dropzone').addEventListener(v,e=>{e.preventDefault();$('dropzone').classList.add('drag')}));
['dragleave','drop'].forEach(v=>$('dropzone').addEventListener(v,e=>{e.preventDefault();$('dropzone').classList.remove('drag')}));
$('dropzone').addEventListener('drop',e=>loadProject(e.dataTransfer.files));
$('fileInput').onchange=e=>loadProject(e.target.files);
$('folderInput').onchange=e=>loadProject(e.target.files);
$('openBtn').onclick=()=>$('fileInput').click();
$('clearBtn').onclick=clearProject;
$('auditBtn').onclick=runAudit;
$('copyBtn').onclick=copyReport;
$('downloadBtn').onclick=downloadReport;
$('adaptToggle').onchange=()=>setDevice(state.mode);
$('saveProviders').onclick=saveProviders;
$('pasteBtn').onclick=openPasteModal;$('closePasteBtn').onclick=closePasteModal;
$('pasteModal').addEventListener('click',e=>{if(e.target===$('pasteModal'))closePasteModal()});
document.querySelectorAll('.paste-tab').forEach(b=>b.onclick=()=>switchPaste(b.dataset.paste));
$('openPasteTextBtn').onclick=openPastedText;$('openPasteLinkBtn').onclick=openPastedLink;
$('fullBtn').onclick=toggleFullScreen;$('exitFullBtn').onclick=toggleFullScreen;
$('fitWidthBtn').onclick=()=>setFit('width');$('fitPageBtn').onclick=()=>setFit('page');$('actualBtn').onclick=()=>setFit('actual');
$('desktopWidth').onchange=e=>{state.desktopWidth=Number(e.target.value)||1440;applyDevice()};
document.querySelectorAll('.device-btn').forEach(b=>b.onclick=()=>setDevice(b.dataset.device));
window.addEventListener('resize',applyFit);
document.addEventListener('fullscreenchange',()=>{if(!document.fullscreenElement&&main.classList.contains('viewer-full')){main.classList.remove('viewer-full');$('exitFullBtn').classList.add('hidden');applyFit()}});

renderHistory();renderProviders();refreshFiles();applyDevice();frame.srcdoc=welcomeHtml();
