import {ProjectRuntime,norm,ext,classify,resolve,mime} from './project-engine.js';
import {DEVICES,deviceCss} from './device-engine.js';
import {auditProject,compareAudits} from './audit-engine.js';
import {Storage} from './storage.js';
import {loadProviderSettings,saveProviderSettings,providerSummary} from './provider-settings.js';

const $=id=>document.getElementById(id);
const runtime=new ProjectRuntime();
const state={current:null,mode:'desktop',adapt:false,scale:1,runtimeErrors:[],liveFindings:[],liveTests:new Set(),audit:null,compare:null,fitMode:'width',desktopWidth:1440,controlTests:[],screenshots:[],screenshotKeys:new Set(),screenshotAttempts:0,screenshotFailures:0,shotIndex:0,messageWaiters:new Map(),renderScore:null,liveChecksAttempted:false,liveChecksCompleted:false,controlsAttempted:false,controlsCompleted:false,controlsFound:0,auditInProgress:false};
const frame=$('frame'),stage=$('desktopStage'),wrap=$('stageWrap'),shell=$('viewerShell'),main=document.querySelector('.main');

function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
function status(s){$('statusBadge').textContent=s}
function notice(s){$('notice').textContent=s;$('notice').classList.toggle('hidden',!s)}
function bytes(n){if(n<1024)return`${n} B`;if(n<1048576)return`${(n/1024).toFixed(1)} KB`;return`${(n/1048576).toFixed(1)} MB`}
function clearRenderUrl(){for(const [k,u] of [...runtime.urls])if(k.startsWith('render:')){URL.revokeObjectURL(u);runtime.urls.delete(k)}}

function setProjectUi(hasProject){
  document.body.classList.toggle('empty-mode',!hasProject);
  $('emptyState').classList.toggle('hidden',hasProject);
  $('workspace').classList.toggle('hidden',!hasProject);
  $('mobileBar').classList.toggle('hidden',!hasProject);
  if(!hasProject){
    document.body.classList.remove('sheet-left','sheet-right','left-collapsed','right-collapsed');
    $('leftRestoreBtn').classList.add('hidden');
    $('rightRestoreBtn').classList.add('hidden');
  }
}
function setPanelCollapsed(side,collapsed){
  const cls=side==='left'?'left-collapsed':'right-collapsed';
  document.body.classList.toggle(cls,collapsed);
  $(side==='left'?'leftRestoreBtn':'rightRestoreBtn').classList.toggle('hidden',!collapsed);
  requestAnimationFrame(applyFit);
}
function showMobileSheet(which){
  document.body.classList.toggle('sheet-left',which==='left');
  document.body.classList.toggle('sheet-right',which==='right');
  document.querySelectorAll('.mbtn').forEach(button=>button.classList.toggle('active',button.dataset.sheet===which));
  if(which==='preview')requestAnimationFrame(applyFit);
}

function fileDescription(name){
  const lower=name.toLowerCase(),base=lower.split('/').pop()||lower,e=ext(name);
  if(/(^|\/)index\.html?$/.test(lower))return'This is the project’s front door. It is usually the first page the browser opens.';
  if(/audit[-_.]?engine\.(js|ts)$/.test(base))return'This is the part that reads the code and looks for problems. It tries hard not to scare you with guesses: clear problems and 'please check this' notes stay separate.';
  if(/preview[-_.]?helper\.(js|ts)$/.test(base))return'This watches the live page while it runs. It notices crashes, checks the visible layout, safely tries harmless controls, and helps save useful page pictures.';
  if(/project[-_.]?engine\.(js|ts)$/.test(base))return'This is the project opener. It unpacks ZIPs, finds the starting file, connects the project pieces, and prepares React or Vite code so you can see the real screen.';
  if(/device[-_.]?engine\.(js|ts)$/.test(base))return'This changes the preview size so you can quickly see how the project looks on a desktop, iPad, or phone.';
  if(/storage\.(js|ts)$/.test(base))return'This keeps your recent audit history and saved project copies in this browser so you can come back to an earlier test.';
  if(/provider[-_.]?settings\.(js|ts)$/.test(base))return'This keeps the optional AI helper settings. The normal viewer and audit do not need them.';
  if(/app\.(tsx|jsx|js|ts)$/.test(base))return'This is one of the main app files. Think of it as a coordinator that connects screens, buttons, data, and other pieces.';
  if(/main\.(tsx|jsx|js|ts|cjs|mjs)$/.test(base))return'This is a startup file. It is one of the first pieces the app uses to get everything running.';
  if(base==='package.json')return'This is the project’s instruction list. It tells the tools which packages the app needs and how the project normally starts or builds.';
  if(/vite\.config\./.test(base))return'This gives Vite its setup instructions for building and running the web app.';
  if(/next\.config\./.test(base))return'This tells Next.js how this web app should build and run.';
  if(/electron|(^|[-_.])main\.(c?js|mjs|ts)$/.test(base)&&lower.includes('electron'))return'This starts the desktop version of the app and can connect the screen to computer-only features.';
  if(/(?:^|\/)(pages?|routes?)\//.test(lower)||/\.page\.(tsx|jsx|ts|js)$/.test(base))return'This is one screen or page in the app. Opening its route should bring you to this part of the website.';
  if(/components?\//.test(lower)||/component/i.test(base))return'This is a reusable piece of the screen, such as a menu, panel, table, form, or button group.';
  if(/hooks?\//.test(lower)||/^use[A-Z]/.test(name.split('/').pop()||''))return'This is reusable behavior for a React app. Other screens can call it instead of repeating the same logic.';
  if(/api|service|client/.test(base)&&CODE_EXTS_FOR_DESCRIPTION.has(e))return'This file talks to another part of the app or to an outside service, such as an API or server.';
  if(/store|state|reducer|context/.test(base)&&CODE_EXTS_FOR_DESCRIPTION.has(e))return'This keeps shared app information so more than one screen can read or change the same data.';
  if(/util|helper|lib/.test(lower)&&CODE_EXTS_FOR_DESCRIPTION.has(e))return'This contains small reusable tools that other files call when they need the same job done.';
  if(/test|spec/.test(base)&&CODE_EXTS_FOR_DESCRIPTION.has(e))return'This is test code. It is used to check whether another part of the project behaves correctly.';
  if(e==='css')return'This controls how the page looks: colors, fonts, spacing, sizes, layout, and how the screen adjusts on different devices.';
  if(['js','mjs','cjs','ts','tsx','jsx'].includes(e))return'This is working program code. It helps control what the app does when people click, type, load data, or move between screens.';
  if(['png','jpg','jpeg','gif','webp','svg','ico'].includes(e))return'This is an image or icon used by the project.';
  if(['woff','woff2','ttf','otf'].includes(e))return'This is a font file. The project uses it to draw text in a particular typeface.';
  if(e==='json')return'This is structured information or settings that the app reads.';
  if(e==='pdf')return'This is a PDF document included in the project.';
  if(e==='md'||/^readme/i.test(base))return'This is an instruction or notes file for people working with the project.';
  if(e==='html'||e==='htm')return'This is a web page. You can open it to see that screen in the browser.';
  return'This belongs to the project. Its name alone does not tell me enough to confidently say exactly what job it does, so I’m not going to guess.';
}
const CODE_EXTS_FOR_DESCRIPTION=new Set(['js','mjs','cjs','ts','tsx','jsx']);

function simpleProject(meta){
  if(meta.type==='HTML website')return'This is a regular website. I can open the real page here, check its files, try safe controls, and show you what needs attention.';
  if(meta.type==='Multi-page website')return`This website has ${meta.pageCount} page files. I connect them so you can move around the site and see how the pages work together.`;
  if(meta.type==='Vite web application'||meta.type==='React/Node application'||meta.type==='React-style source project')return'This is a React-style app. I put the source pieces together inside the browser so you can see and test the running screen without doing a normal local build first.';
  if(meta.type==='Electron application')return'This is a desktop app. I can inspect and test the browser-style screen here, while computer-only features may still need the real desktop app.';
  if(meta.type==='Python project')return'This is a Python program. I can inspect its files, but some parts need Python running on a computer before I can show the full app.';
  return'This project has several kinds of files. I sort them out and explain what each one is for.';
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
  const entry=runtime.entry()==='__synthesized_react__'?(runtime.findReactEntry?.()||'Generated React preview'):(runtime.entry()||'Not found');
  $('projectSummary').innerHTML=`<div class="headline">${esc(simpleProject(meta))}</div><dl class="facts"><dt>Type</dt><dd>${esc(meta.type)}</dd><dt>Starts here</dt><dd>${esc(entry)}</dd><dt>Files</dt><dd>${meta.fileCount}</dd>${meta.pageCount?`<dt>Page files</dt><dd>${meta.pageCount}</dd>`:''}</dl><details class="mini-details"><summary>Technical details</summary><div class="muted">Runs with: ${esc(meta.runtime)}</div></details>`;
  return meta;
}

function waitFor(type,timeout=10000){
  return new Promise(resolve=>{
    const timer=setTimeout(()=>{state.messageWaiters.delete(type);resolve(false)},timeout);
    state.messageWaiters.set(type,payload=>{clearTimeout(timer);state.messageWaiters.delete(type);resolve(payload||true)});
  });
}

function resetVisualEvidence(){
  state.screenshots=[];state.screenshotKeys=new Set();state.screenshotAttempts=0;state.screenshotFailures=0;state.shotIndex=0;renderScreenshots();
}
function screenshotKey(shot){
  const data=String(shot?.data||'');
  return [shot?.page||'',shot?.device||'',data.length,data.slice(-180)].join('|');
}
function addScreenshot(shot){
  if(!shot?.data||!/^data:image\/(jpeg|png|webp);base64,/i.test(shot.data))return false;
  const key=screenshotKey(shot);if(state.screenshotKeys.has(key))return false;
  state.screenshotKeys.add(key);state.screenshots.push(shot);renderScreenshots();return true;
}
function renderScreenshots(){
  const count=state.screenshots.length;
  $('shotCount').textContent=String(count);
  if(!count){
    $('shotGrid').innerHTML='';
    $('shotStatus').textContent=state.screenshotFailures?'I tried to save page pictures, but this browser could not create a usable image. Your code score was not lowered because of that.':'I’ll save a few useful pictures after the page settles. I won’t spam you with before-and-after pictures for every button.';
  }else{
    $('shotGrid').innerHTML=state.screenshots.map((shot,index)=>`<button class="shot" data-shot-index="${index}" aria-label="Open picture: ${esc(shot.label)}"><img src="${shot.data}" alt="${esc(shot.label)}"><span class="shot-meta"><span class="shot-name">${esc(shot.label)}</span><span class="shot-reason">${esc(shot.device||'Preview')} • ${esc(shot.reason||'Page view')}</span></span></button>`).join('');
    $('shotStatus').textContent=state.screenshotFailures?`${count} useful picture${count===1?'':'s'} saved. ${state.screenshotFailures} picture attempt${state.screenshotFailures===1?'':'s'} could not be saved, so the visual evidence is incomplete.`:`${count} useful picture${count===1?'':'s'} saved. These are evidence from the real preview, not a separate score.`;
  }
  if($('visualEvidenceStatus')){
    if(count&&state.screenshotFailures===0){$('visualEvidenceStatus').className='visual-status good';$('visualEvidenceStatus').textContent=`Visual evidence ready • ${count} useful picture${count===1?'':'s'} saved.`}
    else if(state.screenshotAttempts){$('visualEvidenceStatus').className='visual-status warn';$('visualEvidenceStatus').textContent=count?`Visual evidence partly complete • ${count} saved, ${state.screenshotFailures} unavailable.`:'Visual evidence incomplete • the browser could not save a usable page picture.'}
    else{$('visualEvidenceStatus').className='visual-status neutral';$('visualEvidenceStatus').textContent='Pictures will be checked during the audit.'}
  }
}
function showScreenshot(index){
  if(!state.screenshots.length)return;
  state.shotIndex=(index+state.screenshots.length)%state.screenshots.length;
  const shot=state.screenshots[state.shotIndex];
  $('shotImage').src=shot.data;$('shotImage').alt=shot.label||'Captured project preview';
  $('shotTitle').textContent=shot.label||'Page picture';
  $('shotMeta').textContent=[shot.device,shot.reason].filter(Boolean).join(' • ');
  $('shotModal').classList.remove('hidden');
}
function closeScreenshot(){$('shotModal').classList.add('hidden');$('shotImage').removeAttribute('src')}
async function captureCurrentScreenshot(options={}){
  const isSynth=state.current==='__synthesized_react__';
  if(!state.current||(!/\.html?$/i.test(state.current)&&!isSynth))return false;
  const waiting=waitFor('debooger-screenshot-finished',9000);
  frame.contentWindow?.postMessage({type:'debooger-capture-screenshot',options},'*');
  const result=await waiting;
  if(!result){state.screenshotFailures++;renderScreenshots();return false}
  if(!result.ok){return false}
  return true;
}

async function loadProject(list,{skipConfirm=false}={}){
  if(!list?.length)return;
  if(runtime.files.size&&!skipConfirm&&!confirm('Open this new project? Your older audits will stay saved so you can go back to them later.'))return;
  status('Opening…');notice('');state.runtimeErrors=[];state.liveFindings=[];state.liveTests=new Set();state.audit=null;state.compare=null;state.current=null;state.controlTests=[];resetVisualEvidence();state.renderScore=null;state.liveChecksAttempted=false;state.liveChecksCompleted=false;state.controlsAttempted=false;state.controlsCompleted=false;state.controlsFound=0;state.auditInProgress=false;renderControlTests();
  $('scoreBox').innerHTML='<div class="score">—</div><div class="small">I’m getting the project ready. I’ll show the score only after the available checks finish.</div>';
  $('metrics').innerHTML='';
  $('findings').innerHTML='<div class="small">I’m opening the real page first. Clear problems will show here after the checks finish; uncertain notes stay separate.</div>';
  $('compareBox').classList.add('hidden');
  try{
    await runtime.addFiles(list);
    setProjectUi(true);
    refreshFiles();
    const meta=renderProjectSummary();
    status(`${meta.fileCount} files ready`);
    const entry=runtime.entry();
    if(entry){
      if(entry==='__synthesized_react__')notice('This React project does not have a normal starting page, so I am making one temporarily so you can see the app.');
      await select(entry);
    }
    await runAudit();
  }catch(e){status('I could not open that project');notice('Something stopped me from opening this project: '+e.message+' Your original files were not changed.')}
}

async function select(name){
  const isSynthesized=name==='__synthesized_react__';
  if(isSynthesized){
    const synth=runtime.synthesizeReactHtml();
    if(!synth){notice('I could not find the file that normally starts this React app, so I could not open the screen.');return}
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
      if(runtime.compileErrors.length)notice('I found code that the browser could not understand. Open the audit result to see which file needs fixing.');
      status('Ready when you are');applyDevice();
    }catch(err){status('Could not open screen');notice('I tried to open this screen, but something stopped it: '+(err.message||String(err)));frame.srcdoc=`<pre style="white-space:pre-wrap;padding:16px">${esc(String(err))}</pre>`}
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
    status('Ready when you are');applyDevice();
  }catch(err){status('Could not open screen');notice('I tried to open this screen, but something stopped it: '+(err.message||String(err)));frame.srcdoc=`<pre style="white-space:pre-wrap;padding:16px">${esc(String(err))}</pre>`}
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

async function runCurrentLiveChecks(){
  const isSynth=state.current==='__synthesized_react__';
  if(!state.current||(!/\.html?$/i.test(state.current)&&!isSynth))return false;
  state.liveChecksAttempted=true;
  const waiting=waitFor('debooger-live-checks-finished',7000);
  frame.contentWindow?.postMessage({type:'debooger-run-live-checks'},'*');
  const result=await waiting;
  if(result){
    state.liveChecksCompleted=true;
    if(Array.isArray(result.tests))result.tests.forEach(id=>state.liveTests.add(id));
  }
  return result;
}
async function testCurrentControls(){
  const isSynth=state.current==='__synthesized_react__';
  if(!state.current||(!/\.html?$/i.test(state.current)&&!isSynth))return false;
  state.controlsAttempted=true;
  const waiting=waitFor('debooger-controls-finished',45000);
  frame.contentWindow?.postMessage({type:'debooger-test-controls'},'*');
  const result=await waiting;
  if(result){
    state.controlsCompleted=true;
    state.controlsFound=Number(result.count||0);
  }
  return result;
}

async function runPageAuditChecks(){
  state.controlTests=[];state.liveFindings=[];state.liveTests=new Set();state.liveChecksAttempted=false;state.liveChecksCompleted=false;state.controlsAttempted=false;state.controlsCompleted=false;state.controlsFound=0;resetVisualEvidence();renderControlTests();
  let pages=[...runtime.files.keys()].filter(name=>/\.html?$/i.test(name));
  if(!pages.length&&runtime.isReactSourceProject())pages=['__synthesized_react__'];
  if(!pages.length)return 0;
  const startPage=state.current;
  const startMode=state.mode;
  let checked=0;
  const pageCap=Math.min(pages.length,8);
  for(let i=0;i<pageCap;i++){
    await select(pages[i]);
    status(`Checking live page ${i+1} of ${pageCap}…`);
    if(await runCurrentLiveChecks())checked++;
    await captureCurrentScreenshot({label:pages[i]==='__synthesized_react__'?'Main React screen':pages[i].split('/').pop(),reason:'A clean picture of this page after it finished loading.',group:'Page',device:state.mode==='desktop'?'Desktop':state.mode==='tablet'?'iPad':'Mobile'});
    if(i===0){
      status('Trying a few safe controls…');
      setAuditStep(3);
      await testCurrentControls();
    }
  }
  const firstPage=pages[0];
  for(const mode of ['desktop','tablet','mobile']){
    if(state.screenshots.length>=12)break;
    if(startMode===mode)continue;
    state.mode=mode;applyDevice();await select(firstPage);
    await captureCurrentScreenshot({label:(firstPage==='__synthesized_react__'?'Main React screen':firstPage.split('/').pop())+' — '+(mode==='desktop'?'Desktop':mode==='tablet'?'iPad':'Mobile'),reason:'The same main screen at another useful device size.',group:'Device',device:mode==='desktop'?'Desktop':mode==='tablet'?'iPad':'Mobile'});
  }
  state.mode=startMode;applyDevice();
  const validStart=startPage&&(runtime.files.has(startPage)||startPage==='__synthesized_react__');
  if(validStart)await select(startPage);else await select(firstPage);
  return checked;
}

function renderAuditPending(meta){
  $('scoreBox').innerHTML='<div class="score-line"><div class="score">—</div><div class="muted">I’m checking the project now. I’ll keep the score blank until the available checks are finished so you don’t see a fake early 100.</div></div><ul class="progress" id="auditProgress"><li>Reading files</li><li>Building preview</li><li>Opening pages</li><li>Testing safe controls</li><li>Checking code and layout</li><li>Saving useful pictures</li><li>Preparing a simple result</li></ul>';
  $('metrics').innerHTML=`<div class="metric"><b>${meta.fileCount}</b><span>Files to check</span></div><div class="metric"><b>—</b><span>Tests finished</span></div><div class="metric"><b>—</b><span>Real problems</span></div><div class="metric"><b>—</b><span>Check manually</span></div>`;
  $('findings').innerHTML='<div class="muted">I’m checking the real page and the source files. Clear problems will appear here; guesses stay out of the score.</div>';
  $('compareBox').classList.add('hidden');
  setAuditStep(0);
}
function setAuditStep(index){
  const progress=$('auditProgress');
  if(!progress)return;
  [...progress.children].forEach((item,i)=>{
    item.classList.toggle('done',i<index);
    item.classList.toggle('active',i===index);
  });
}

function finalizeAuditScore(audit,meta){
  audit.sourceScore=audit.score;
  const needsPageTest=meta.pageCount>0||runtime.isReactSourceProject();
  audit.livePageChecksComplete=!needsPageTest||state.liveChecksCompleted;
  audit.controlsComplete=!state.controlsAttempted||state.controlsCompleted;
  audit.controlsFound=state.controlsFound;
  audit.controlFailures=state.controlTests.filter(item=>item.status==='FAIL').length;
  audit.controlUnclear=state.controlTests.filter(item=>item.status==='CHECK'||item.status==='SKIP').length;
  audit.screenshotsSaved=state.screenshots.length;
  audit.screenshotAttempts=state.screenshotAttempts;
  audit.screenshotFailures=state.screenshotFailures;
  const notes=[];
  if(needsPageTest&&!audit.livePageChecksComplete)notes.push('The code checks finished, but the live-page check did not finish. I did not lower the score for an unfinished viewer check.');
  if(state.controlsAttempted&&!state.controlsCompleted)notes.push('The safe-button check did not finish. I did not call those buttons broken or lower the score because of that.');
  if(state.screenshotAttempts&&state.screenshotFailures){notes.push(state.screenshots.length?`${state.screenshots.length} useful picture${state.screenshots.length===1?' was':'s were'} saved, but ${state.screenshotFailures} picture attempt${state.screenshotFailures===1?' was':'s were'} unavailable. Pictures do not change the code score.`:'This browser could not save a usable page picture. That does not lower the code score, and I am marking the visual evidence as incomplete.');}
  else if(state.screenshots.length)notes.push(`${state.screenshots.length} useful page picture${state.screenshots.length===1?' was':'s were'} saved as visual evidence.`);
  if(!notes.length)notes.push('The available checks finished cleanly.');
  audit.testNote=notes.join(' ');
  return audit;
}


async function runAudit(){
  if(!runtime.files.size||state.auditInProgress)return;
  state.auditInProgress=true;
  status('Checking your project…');
  const meta=classify(runtime.files);
  meta.projectKey=await projectIdentity(meta);
  meta.projectLabel=projectLabel(meta);
  const previous=Storage.history().find(item=>item.meta?.projectKey===meta.projectKey)||null;
  renderAuditPending(meta);
  setAuditStep(1);
  state.runtimeErrors=[];
  state.liveFindings=[];
  runtime.compileErrors=[];
  try{
    setAuditStep(2);
    const livePagesChecked=await runPageAuditChecks();
    setAuditStep(4);
    status('Reading the code carefully…');
    const audit=await auditProject(runtime.files,meta,state.runtimeErrors,runtime.compileErrors,state.liveFindings,[...state.liveTests]);
    audit.livePagesChecked=livePagesChecked;
    finalizeAuditScore(audit,meta);
    state.audit=audit;
    state.compare=compareAudits(previous,audit);
    setAuditStep(5);
    status('Checking the visual evidence…');
    setAuditStep(6);
    status('Putting the result together…');
    await Storage.saveSnapshot(audit,runtime.files);
    const history=Storage.pushAudit(audit);
    await Storage.pruneSnapshots(history.slice(0,6).map(item=>item.snapshotId));
    renderHistory();
    if(audit.livePageChecksComplete&&audit.controlsComplete){status('Audit complete');notice('')}
    else if(!audit.livePageChecksComplete){status('Audit complete • live page check incomplete');notice('The code audit finished, but I could not finish the live-page check. I did not lower the score for a viewer check that did not finish.')}
    else{status('Audit complete • button test incomplete');notice('The audit finished, but I could not finish the safe-button check. I did not call those buttons broken or lower the score because of that.')}
    renderAudit();
  }catch(error){
    state.audit=null;
    status('Audit could not finish');
    notice('The audit stopped because debooger2000 itself hit a problem: '+String(error?.message||error)+' I did not blame your project for this.');
    $('scoreBox').innerHTML='<div class="score">—</div><div class="small">I did not create a final score because the audit itself did not finish.</div>';
  }finally{
    state.auditInProgress=false;
  }
}

function findingClass(item){
  if(item.scoreImpact===false||item.confidence==='low')return'review';
  if(item.severity==='critical'||item.severity==='error')return'bad';
  if(item.severity==='warning')return'warn';
  return'review';
}
function findingSeverity(item){
  if(item.scoreImpact===false||item.confidence==='low')return{label:'Check manually',cls:'review'};
  if(item.severity==='critical'||item.severity==='error')return{label:item.severity==='critical'?'Critical':'Error',cls:'error'};
  if(item.severity==='warning')return{label:'Warning',cls:'warning'};
  return{label:'Review',cls:'review'};
}
function renderAudit(){
  const audit=state.audit;if(!audit)return;
  const cls=audit.score>=95?'good':audit.score>=80?'warn':'bad';
  const testText=audit.testNote||'';
  $('scoreBox').innerHTML=`<div class="score-line"><div class="score ${cls}">${audit.score}<span class="score-denom">/100</span></div><div><div class="score-message">${esc(audit.verdict)}</div><div class="muted">${esc(testText)}</div></div></div>`;
  renderScreenshots();
  const stats=audit.checkStats||{run:0,issues:0,review:0};
  $('metrics').innerHTML=`<div class="metric"><b>${audit.meta.fileCount}</b><span>Files checked</span></div><div class="metric"><b>${stats.run}</b><span>Checks run</span></div><div class="metric"><b>${stats.issues}</b><span>Confirmed problem types</span></div><div class="metric"><b>${state.screenshots.length}</b><span>Useful pictures</span></div>`;
  const ordered=[...audit.findings].sort((a,b)=>{
    const ar=a.scoreImpact===false||a.confidence==='low'?1:0,br=b.scoreImpact===false||b.confidence==='low'?1:0;
    if(ar!==br)return ar-br;
    const rank={critical:0,error:1,warning:2,info:3};return(rank[a.severity]??4)-(rank[b.severity]??4);
  });
  const LIMIT=60,top=ordered.slice(0,LIMIT),hidden=ordered.length-top.length;
  $('findings').innerHTML=(top.length
    ?top.map(item=>{
      const review=item.scoreImpact===false||item.confidence==='low';
      const severity=findingSeverity(item);
      const note=review?'I’m not certain enough to call this broken, so it did not lower the score. Please give it a quick human look.':'I found enough clear evidence to count this as a real problem, so it affected the score.';
      return `<details class="finding ${findingClass(item)}"><summary><span class="severity ${severity.cls}">${esc(severity.label)}</span><strong>${esc(item.title)}</strong><div class="simple-line">${esc(item.plain)}</div>${item.file?`<div class="finding-where">${esc(item.file)}${item.line?` • line ${item.line}`:''}</div>`:''}</summary><p>${esc(note)}${item.technical?`<br><br><strong>More technical detail</strong><br>${esc(item.technical)}`:''}</p></details>`;
    }).join('')
    :'<div class="finding good"><div class="finding-success"><span class="severity pass">Passed</span><strong>Good news — I did not find a clear code problem</strong><div class="simple-line">The checks that can prove a problem came back clean. Anything uncertain stays separate so it does not pretend to be an error.</div></div></div>')
    +(hidden>0?`<div class="more-findings">…and ${hidden} more item${hidden===1?'':'s'}. Download the report to see every item.</div>`:'');
  if(state.compare){
    $('compareBox').classList.remove('hidden');
    $('compareBox').innerHTML=`<details class="finding ${state.compare.delta>=0?'good':'warn'}"><summary><strong>${esc(state.compare.recommendation)}</strong><div class="simple-line">Open this only when you want to compare this audit with the last saved audit of the same project.</div></summary><p>Older score: ${state.compare.previousScore} • New score: ${state.compare.currentScore} • Earlier items gone: ${state.compare.fixedCount} • New items: ${state.compare.newIssueCount}</p></details>`;
  }else $('compareBox').classList.add('hidden');
}

function controlResultText(item){
  if(item.detail)return item.detail;
  if(item.status==='PASS')return'I pressed it, the screen changed, and no JavaScript crash appeared.';
  if(item.status==='FAIL')return'I pressed it and the page reported a real error, so this one needs attention.';
  if(item.status==='SKIP')return'I left this one alone because pressing it could cause a real action. Skipping it does not count as a failure.';
  return'I pressed it, but I could not safely measure a visible change. That is not enough proof to call it broken, so it did not lower the score.';
}
function renderControlTests(){
  const tested=state.controlTests.filter(item=>item.status!=='SKIP').length;
  $('controlCount').textContent=String(tested);
  $('controlList').innerHTML=state.controlTests.length
    ?state.controlTests.map(item=>`<div class="control-test ${item.status==='FAIL'?'bad':item.status==='PASS'?'good':'neutral'}"><div class="control-status">${esc(item.status==='CHECK'?'Check':item.status)}</div><strong>${esc(item.label||'Button or switch')}</strong><div class="muted">${esc(controlResultText(item))}</div></div>`).join('')
    :'<div class="muted">I only press controls that look harmless. I will not send, call, delete, upload, save, pay, submit, download, or make another real-world change.</div>';
}


function renderHistory(){
  const h=Storage.history();
  $('history').innerHTML=h.length
    ?h.slice(0,6).map(x=>`<button class="history-item history-open" data-history-id="${esc(x.snapshotId||'')}" ${x.snapshotId?'':'disabled'}><strong>${esc(x.meta?.projectLabel||simpleProject(x.meta))}</strong><div class="small">${new Date(x.createdAt).toLocaleString()} • Score ${x.score}${x.snapshotId?' • Tap to reopen saved ZIP':' • Older record only'}</div></button>`).join('')
    :'<div class="small">No older audits saved on this device.</div>';
}
async function openHistorySnapshot(id){
  if(!id)return;
  status('Opening saved project…');
  const saved=await Storage.getSnapshot(id);
  if(!saved?.blob){status('Saved ZIP unavailable');notice('This older audit was saved before project ZIP history was added, so its files cannot be reopened automatically.');return}
  const file=new File([saved.blob],saved.name||'saved-project.zip',{type:'application/zip'});
  await loadProject([file],{skipConfirm:true});
}

function buildReport(){
  const audit=state.audit;if(!audit)return'No finished audit is available yet.';
  const stats=audit.checkStats||{run:0,passed:0,issues:0,review:0};
  let report=`DEBOOGER2000 AUDIT\n\nWHAT THIS PROJECT IS\n${simpleProject(audit.meta)}\n${audit.meta.fileCount} files • ${audit.meta.pageCount} page files\n\nFINAL SCORE\n${audit.score}/100 — ${audit.verdict}\n${audit.testNote||''}\n\nTESTS\n${stats.run} different test types run\n${stats.issues} real problem types\n${stats.review} manual-review types\n\nSAFE BUTTON TESTS\n${state.controlTests.length?state.controlTests.map(item=>'• '+item.label+' — '+controlResultText(item)).join('\n'):'• No safe controls were available to press'}\n\nVISUAL EVIDENCE\n• ${state.screenshots.length} useful picture${state.screenshots.length===1?'':'s'} saved\n• ${state.screenshotFailures} picture attempt${state.screenshotFailures===1?'':'s'} unavailable\n• Picture problems never lower the code score by themselves\n\nWHAT NEEDS ATTENTION\n`;
  report+=audit.findings.map((item,index)=>{
    const review=item.scoreImpact===false||item.confidence==='low';
    return`${index+1}. ${review?'CHECK MANUALLY — ':'PROBLEM — '}${item.title}\n   ${item.plain}${review?'\n   This did not lower the score.':''}${item.file?`\n   File: ${item.file}${item.line?` • line ${item.line}`:''}`:''}${item.technical?`\n   Fixing detail: ${item.technical}`:''}`;
  }).join('\n\n')||'No clear code problems were found.';
  if(state.compare)report+=`\n\nVERSION COMPARISON\n${state.compare.recommendation}\nOlder: ${state.compare.previousScore} | Current: ${state.compare.currentScore} | Earlier items gone: ${state.compare.fixedCount} | New items: ${state.compare.newIssueCount}`;
  return report;
}

async function copyReport(){
  const report=buildReport();
  try{
    if(!navigator.clipboard?.writeText)throw new Error('Clipboard API unavailable');
    await navigator.clipboard.writeText(report);
    status('Copied');
    return true;
  }catch{}
  const ta=document.createElement('textarea');
  ta.value=report;ta.setAttribute('readonly','');
  ta.style.position='fixed';ta.style.left='-9999px';ta.style.top='0';
  document.body.appendChild(ta);ta.focus();ta.select();ta.setSelectionRange(0,ta.value.length);
  let copied=false;
  try{copied=document.execCommand('copy')===true}catch{}
  ta.remove();
  if(copied){status('Copied');return true}
  status('Copy blocked');notice('Your browser blocked automatic copy. Press and hold the audit text, then choose Copy.');
  return false;
}
async function downloadReport(){
  const report=buildReport();
  let file;
  if(state.screenshots.length&&typeof JSZip!=='undefined'){
    const zip=new JSZip();
    zip.file('audit.txt',report);
    state.screenshots.forEach((shot,index)=>{
      const match=String(shot.data||'').match(/^data:image\/(jpeg|png|webp);base64,(.+)$/i);
      if(!match)return;
      const extName=match[1].toLowerCase()==='jpeg'?'jpg':match[1].toLowerCase();
      const safe=String(shot.label||`picture-${index+1}`).replace(/[^a-z0-9_-]+/gi,'-').replace(/^-+|-+$/g,'').slice(0,70)||`picture-${index+1}`;
      zip.file(`pictures/${String(index+1).padStart(2,'0')}-${safe}.${extName}`,match[2],{base64:true});
    });
    const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:6}});
    file=new File([blob],'debooger2000-audit-report.zip',{type:'application/zip'});
  }else file=new File([report],'debooger2000-audit.txt',{type:'text/plain;charset=utf-8'});
  const isiOS=/iPad|iPhone|iPod/.test(navigator.userAgent)||navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1;
  if(isiOS&&navigator.share&&navigator.canShare?.({files:[file]})){
    try{await navigator.share({files:[file],title:'debooger2000 audit'});status('Report is ready to save');return true}catch(e){if(e?.name==='AbortError')return false}
  }
  const url=URL.createObjectURL(file),a=document.createElement('a');
  a.href=url;a.download=file.name;a.rel='noopener';a.style.display='none';document.body.appendChild(a);
  try{a.click();status('Report download started');return true}
  catch{window.open(url,'_blank');status('Report opened in a new tab');return true}
  finally{a.remove();setTimeout(()=>URL.revokeObjectURL(url),15000)}
}
function renderProviders(){
  const p=loadProviderSettings();
  $('groqEnabled').checked=!!p.groq?.enabled;$('groqKey').value=p.groq?.key||'';
  $('googleEnabled').checked=!!p.google?.enabled;$('googleKey').value=p.google?.key||'';
  $('providerStatus').textContent=providerSummary(p);
}
function saveProviders(){
  const p={groq:{enabled:$('groqEnabled').checked,key:$('groqKey').value.trim()},google:{enabled:$('googleEnabled').checked,key:$('googleKey').value.trim()}};
  saveProviderSettings(p);$('providerStatus').textContent=providerSummary(p);status('AI setting ready');
}
function clearProject(){
  if(runtime.files.size&&!confirm('Clear this project? Your earlier audit history will stay.'))return;
  runtime.clear();state.current=null;state.runtimeErrors=[];state.liveFindings=[];state.liveTests=new Set();state.audit=null;state.compare=null;state.controlTests=[];resetVisualEvidence();state.renderScore=null;state.liveChecksAttempted=false;state.liveChecksCompleted=false;state.controlsAttempted=false;state.controlsCompleted=false;state.controlsFound=0;state.auditInProgress=false;
  refreshFiles();renderControlTests();setProjectUi(false);
  $('projectSummary').innerHTML='<div class="muted">Open a project and I’ll explain what kind of project it is, which file starts it, and what I can test here.</div>';
  $('scoreBox').innerHTML='<div class="score">—</div><div class="muted">I’ll keep the score blank until the available checks are finished.</div>';
  $('metrics').innerHTML='';
  $('findings').innerHTML='<div class="muted">Real problems show first. Anything uncertain stays clearly marked as a manual check and does not lower the score.</div>';
  $('compareBox').classList.add('hidden');frame.srcdoc=welcomeHtml();notice('');status('Ready when you are');
}
function welcomeHtml(){return'<!doctype html><html><body style="font-family:Inter,system-ui;padding:42px"><h1 style="font-size:24px">debooger2000</h1><p>Open a project and I’ll show you the real page, check what I can safely check, and explain anything that needs attention in simple words.</p></body></html>'}
function openPasteModal(){
  $('moreModal').classList.add('hidden');$('pasteModal').classList.remove('hidden');
  if(navigator.clipboard?.readText)navigator.clipboard.readText().then(t=>{
    if(!t)return;
    if(/^https?:\/\//i.test(t.trim())){$('pasteLink').value=t.trim();switchPaste('link')}
    else if(!$('pasteText').value)$('pasteText').value=t;
  }).catch(()=>{});
}
function closePasteModal(){$('pasteModal').classList.add('hidden')}
function switchPaste(mode){
  document.querySelectorAll('.paste-tab').forEach(b=>b.classList.toggle('active',b.dataset.paste===mode));
  $('pasteTextPanel').classList.toggle('hidden',mode!=='text');
  $('pasteLinkPanel').classList.toggle('hidden',mode!=='link');
}
async function openPastedText(){
  const text=$('pasteText').value;if(!text.trim())return;
  const type=$('pasteType').value,name=`pasted.${type}`,file=new File([text],name,{type:mime(name)});
  closePasteModal();await loadProject([file]);
}
async function openPastedLink(){
  const url=$('pasteLink').value.trim();
  if(!/^https?:\/\//i.test(url)){notice('Paste a full web link.');return}
  status('Opening link…');
  try{
    const res=await fetch(url,{credentials:'omit'});
    if(!res.ok)throw new Error(`The link returned ${res.status}`);
    const blob=await res.blob();
    let name='download';
    try{name=decodeURIComponent(new URL(url).pathname.split('/').pop()||'download')}catch{}
    if(!ext(name)){if(blob.type.includes('zip'))name+='.zip';else if(blob.type.includes('html'))name+='.html';else name+='.bin'}
    closePasteModal();await loadProject([new File([blob],name,{type:blob.type||mime(name)})]);
  }catch{status('Link blocked');notice('I could not open that link directly. Open or share the actual file instead.')}
}
async function toggleFullScreen(){
  const entering=!main.classList.contains('viewer-full');
  main.classList.toggle('viewer-full',entering);document.body.classList.toggle('full-active',entering);
  $('exitFullBtn').classList.toggle('hidden',!entering);
  if(entering&&document.documentElement.requestFullscreen)try{await document.documentElement.requestFullscreen()}catch{}
  if(!entering&&document.fullscreenElement)try{await document.exitFullscreen()}catch{}
  setTimeout(applyFit,100);
}
function openMore(){$('moreModal').classList.remove('hidden')}
function closeMore(){$('moreModal').classList.add('hidden')}

function openNativePicker(kind='file'){
  const input=kind==='folder'?$('folderInput'):$('fileInput');
  if(!input){status('File picker is unavailable');notice('I could not find the browser file picker. Reload the page and try again.');return false}
  input.value='';
  status(kind==='folder'?'Choose a project folder…':'Choose a file or ZIP…');
  try{
    if(typeof input.showPicker==='function'){input.showPicker();return true}
    input.click();
    return true;
  }catch{
    try{input.click();return true}catch{
      status('File picker did not open');
      notice('The browser did not open its file picker. On iPhone, try the Choose file / ZIP button again or use Paste code.');
      return false;
    }
  }
}

function handlePickedFiles(input){
  const files=input?.files;
  if(!files?.length){status('No file chosen');return}
  loadProject(files).finally(()=>{try{input.value=''}catch{}});
}

window.addEventListener('message',e=>{
  if(e.source!==frame.contentWindow)return;
  const d=e.data||{};
  if(d.type==='debooger-nav'){const p=norm(resolve(d.base,d.href));if(runtime.files.has(p))select(p)}
  else if(d.type==='debooger-runtime-error'){state.runtimeErrors.push(d);status('Running problem found')}
  else if(d.type==='debooger-control-result'){state.controlTests.push(d.result);renderControlTests()}
  else if(d.type==='debooger-live-findings'&&Array.isArray(d.findings)){state.liveFindings.push(...d.findings)}
  else if(d.type==='debooger-screenshot-started'){state.screenshotAttempts++;renderScreenshots()}
  else if(d.type==='debooger-screenshot'){addScreenshot(d.shot)}
  else if(d.type==='debooger-screenshot-error'){state.screenshotFailures++;renderScreenshots()}
  if(state.messageWaiters.has(d.type))state.messageWaiters.get(d.type)(d);
});

['dragenter','dragover'].forEach(v=>$('dropzone').addEventListener(v,e=>{e.preventDefault();$('dropzone').classList.add('drag')}));
['dragleave','drop'].forEach(v=>$('dropzone').addEventListener(v,e=>{e.preventDefault();$('dropzone').classList.remove('drag')}));
$('dropzone').addEventListener('drop',e=>{const files=e.dataTransfer?.files;if(files?.length)loadProject(files)});
$('fileInput').addEventListener('change',e=>handlePickedFiles(e.currentTarget));
$('folderInput').addEventListener('change',e=>handlePickedFiles(e.currentTarget));
$('fileInput').addEventListener('cancel',()=>status('No file chosen'));
$('folderInput').addEventListener('cancel',()=>status('No folder chosen'));
$('pasteInlineBtn').onclick=openPasteModal;
$('emptyPasteBtn').onclick=openPasteModal;
$('clearInlineBtn').onclick=()=>{closeMore();clearProject()};
$('clearBtn').onclick=clearProject;
$('adaptToggle').onchange=()=>setDevice(state.mode);
$('saveProviders').onclick=saveProviders;
$('pasteBtn').onclick=openPasteModal;
$('moreBtn').onclick=openMore;
$('leftCollapseBtn').onclick=()=>setPanelCollapsed('left',true);
$('rightCollapseBtn').onclick=()=>setPanelCollapsed('right',true);
$('leftRestoreBtn').onclick=()=>setPanelCollapsed('left',false);
$('rightRestoreBtn').onclick=()=>setPanelCollapsed('right',false);
document.querySelectorAll('.mbtn').forEach(button=>button.onclick=()=>showMobileSheet(button.dataset.sheet));
$('closeMoreBtn').onclick=closeMore;
$('moreModal').addEventListener('click',e=>{if(e.target===$('moreModal'))closeMore()});
$('closePasteBtn').onclick=closePasteModal;
$('pasteModal').addEventListener('click',e=>{if(e.target===$('pasteModal'))closePasteModal()});
document.querySelectorAll('.paste-tab').forEach(b=>b.onclick=()=>switchPaste(b.dataset.paste));
$('openPasteTextBtn').onclick=openPastedText;
$('openPasteLinkBtn').onclick=openPastedLink;
$('fullBtn').onclick=toggleFullScreen;
$('exitFullBtn').onclick=toggleFullScreen;
$('fitWidthBtn').onclick=()=>setFit('width');
$('fitPageBtn').onclick=()=>setFit('page');
$('actualBtn').onclick=()=>setFit('actual');
$('desktopWidth').onchange=e=>{state.desktopWidth=Number(e.target.value)||1440;applyDevice()};
document.querySelectorAll('.device-btn').forEach(b=>b.onclick=()=>setDevice(b.dataset.device));
document.addEventListener('click',async e=>{
  const picker=e.target.closest?.('[data-file-picker]');
  if(picker){e.preventDefault();openNativePicker(picker.dataset.filePicker);return}
  const shotButton=e.target.closest?.('[data-shot-index]');
  if(shotButton){e.preventDefault();showScreenshot(Number(shotButton.dataset.shotIndex)||0);return}
  const actionButton=e.target.closest?.('[data-audit-action]');
  if(actionButton){
    e.preventDefault();
    const action=actionButton.dataset.auditAction;
    if(action==='audit')await runAudit();
    else if(action==='copy')await copyReport();
    else if(action==='download')await downloadReport();
    return;
  }
  const historyButton=e.target.closest?.('[data-history-id]');
  if(historyButton&&!historyButton.disabled){
    e.preventDefault();
    await openHistorySnapshot(historyButton.dataset.historyId);
  }
});
$('closeShotBtn').onclick=closeScreenshot;
$('prevShotBtn').onclick=()=>showScreenshot(state.shotIndex-1);
$('nextShotBtn').onclick=()=>showScreenshot(state.shotIndex+1);
$('shotModal').addEventListener('click',e=>{if(e.target===$('shotModal'))closeScreenshot()});
window.addEventListener('resize',applyFit);
document.addEventListener('fullscreenchange',()=>{
  if(!document.fullscreenElement&&main.classList.contains('viewer-full')&&document.fullscreenEnabled){
    main.classList.remove('viewer-full');document.body.classList.remove('full-active');$('exitFullBtn').classList.add('hidden');applyFit();
  }
});
renderHistory();renderProviders();refreshFiles();renderControlTests();renderScreenshots();setProjectUi(false);applyDevice();frame.srcdoc=welcomeHtml();
