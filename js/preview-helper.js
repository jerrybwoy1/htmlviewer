let screenshotHelperSource='';
let screenshotHelperPromise=null;

export function safeInlineScript(source){
  return String(source||'').replace(/<\/script/gi,'<\\/script');
}

export async function getScreenshotHelper(){
  if(screenshotHelperSource)return screenshotHelperSource;
  if(screenshotHelperPromise)return screenshotHelperPromise;
  screenshotHelperPromise=(async()=>{
    try{
      const r=await fetch('https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js',{cache:'force-cache'});
      if(!r.ok)throw new Error(`HTTP ${r.status}`);
      screenshotHelperSource=await r.text();
      return screenshotHelperSource;
    }catch{return''}
    finally{screenshotHelperPromise=null}
  })();
  return screenshotHelperPromise;
}

export function buildPreviewRuntime(base,origin){
  return String.raw`(()=>{
      const base=${JSON.stringify(base)};
      const origin=${JSON.stringify(origin)};
      const sleep=ms=>new Promise(r=>setTimeout(r,ms));
      const runtimeErrors=[];
      function visible(el){
        if(!el)return false;
        const s=getComputedStyle(el),r=el.getBoundingClientRect();
        return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)!==0&&r.width>2&&r.height>2;
      }
      function pageScore(){
        const text=(document.body?.innerText||'').trim().length;
        const visibleCount=[...document.querySelectorAll('body *')].filter(visible).length;
        return{text,visible:visibleCount,width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight};
      }
      function signature(){
        const open=[...document.querySelectorAll('[aria-expanded="true"],dialog[open],details[open],.open,.show,.active')]
          .filter(visible).length;
        const checked=[...document.querySelectorAll('input[type="checkbox"],input[type="radio"]')].filter(x=>x.checked).length;
        const text=(document.body?.innerText||'').replace(/\s+/g,' ').trim().slice(0,1500);
        return JSON.stringify({open,checked,textLen:text.length,visible:pageScore().visible,scrollW:document.documentElement.scrollWidth,scrollH:document.documentElement.scrollHeight});
      }
      async function ensureCapture(){
        for(let i=0;i<100&&!window.html2canvas;i++)await sleep(100);
        return !!window.html2canvas;
      }
      function syncFormState(source,clone){
        const a=[...source.querySelectorAll('input,textarea,select')];
        const b=[...clone.querySelectorAll('input,textarea,select')];
        a.forEach((el,i)=>{
          const copy=b[i];if(!copy)return;
          if(el.matches('input[type="checkbox"],input[type="radio"]')){
            if(el.checked)copy.setAttribute('checked','checked');else copy.removeAttribute('checked');
          }else if(el.tagName==='TEXTAREA')copy.textContent=el.value||'';
          else if(el.tagName==='SELECT'){
            [...copy.options].forEach((o,n)=>{if(el.options[n]?.selected)o.setAttribute('selected','selected');else o.removeAttribute('selected')});
          }else copy.setAttribute('value',el.value||'');
        });
      }
      function domSvgSnapshot(){
        const root=document.documentElement;
        const w=Math.min(Math.max(root.scrollWidth,document.body?.scrollWidth||0,320),1800);
        const h=Math.min(Math.max(root.scrollHeight,document.body?.scrollHeight||0,320),2800);
        const body=document.body?.cloneNode(true);
        if(!body)throw new Error('The page body was not available for a picture');
        syncFormState(document.body,body);
        body.querySelectorAll('script,noscript').forEach(x=>x.remove());
        const styles=[...document.querySelectorAll('style')].map(x=>x.textContent||'').join('\n');
        const xhtml='<div xmlns="http://www.w3.org/1999/xhtml" style="width:'+w+'px;min-height:'+h+'px;background:white;overflow:hidden"><style>'+styles+'</style>'+body.outerHTML+'</div>';
        const svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'" viewBox="0 0 '+w+' '+h+'"><foreignObject width="100%" height="100%">'+xhtml+'</foreignObject></svg>';
        return 'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);
      }
      async function shot(label,phase=''){
        const score=pageScore();
        if(score.text<8&&score.visible<5){
          parent.postMessage({type:'debooger-screenshot-error',message:'The page was almost empty, so there was not enough on screen to save a useful picture.',label,phase},origin);
          return false;
        }
        let firstError='';
        try{
          if(await ensureCapture()){
            const root=document.documentElement;
            const w=Math.min(Math.max(root.scrollWidth,document.body?.scrollWidth||0),1800);
            const h=Math.min(Math.max(root.scrollHeight,document.body?.scrollHeight||0),2800);
            const canvas=await window.html2canvas(document.body,{
              backgroundColor:'#ffffff',useCORS:true,allowTaint:false,logging:false,
              scale:.45,width:w,height:h,windowWidth:w,windowHeight:h,foreignObjectRendering:false
            });
            const data=canvas.toDataURL('image/jpeg',.8);
            if(data.length>=4000){
              parent.postMessage({type:'debooger-screenshot',label,phase,data,score,method:'canvas'},origin);
              return true;
            }
            firstError='The first picture method returned an image that was too small.';
          }else firstError='The normal picture helper did not load.';
        }catch(err){firstError=String(err?.message||err)}
        try{
          const data=domSvgSnapshot();
          if(data.length<300)throw new Error('The backup picture was too small to use.');
          parent.postMessage({type:'debooger-screenshot',label,phase,data,score,method:'page-copy'},origin);
          return true;
        }catch(err){
          const second=String(err?.message||err);
          parent.postMessage({type:'debooger-screenshot-error',message:'I tried two ways to save the picture. First: '+String(firstError||'did not work').replace(/[.]+$/,'')+'. Backup: '+String(second).replace(/[.]+$/,'')+'.',label,phase},origin);
          return false;
        }
      }
      function controlLabel(el){
        const id=el.id||'';
        if(id==='groqEnabled')return 'Groq AI switch';
        if(id==='googleEnabled')return 'Google AI Studio switch';
        if(id==='adaptToggle')return 'Adapt preview switch';
        if(id==='fitWidthBtn')return 'Fit width button';
        if(id==='fitPageBtn')return 'Fit page button';
        if(id==='actualBtn')return '100% size button';
        if(el.classList?.contains('device-btn')){const d=(el.dataset?.device||'preview').replace(/^./,c=>c.toUpperCase());return d+' preview button'}
        const raw=(el.getAttribute('aria-label')||el.innerText||el.title||el.name||id||el.tagName||'Button or control').replace(/\s+/g,' ').trim();
        if(el.tagName==='SUMMARY'){
          if(/^files in this project/i.test(raw))return 'Files in this project section';
          if(/^older audits?/i.test(raw))return 'Older audits section';
          if(/^settings?/i.test(raw))return 'Settings section';
          return raw.replace(/\b\d+\s*files?\b/ig,'').trim()+' section';
        }
        return raw.slice(0,80);
      }
      function safeControl(el){
        if(!visible(el)||el.disabled)return false;
        const label=controlLabel(el);
        const danger=/delete|remove|send|call|dial|pay|purchase|submit|publish|export|save|message|email|sms|whatsapp|logout|sign out|archive|trash|clear all|kill|stop|upload|choose file|open a folder|paste/i;
        const useful=/menu|more|filter|column|setting|option|view|detail|info|help|sort|tab|expand|collapse|toggle|show|hide|sheet|page|next|previous|fit|desktop|ipad|mobile|preview/i;
        const isCheck=el.matches?.('input[type="checkbox"],input[type="radio"]');
        const isSummary=el.tagName==='SUMMARY';
        const isDevice=el.classList?.contains('device-btn');
        if(isDevice&&el.classList?.contains('active'))return false;
        return !danger.test(label)&&(useful.test(label)||isCheck||isSummary||isDevice||el.hasAttribute('aria-haspopup')||el.hasAttribute('aria-expanded'));
      }
      async function restoreControl(el,beforeChecked,beforeExpanded,beforeOpen){
        try{
          if(el.matches?.('input[type="checkbox"],input[type="radio"]')&&el.checked!==beforeChecked){el.click();await sleep(120);return}
          if(el.tagName==='SUMMARY'&&el.parentElement?.tagName==='DETAILS'&&el.parentElement.open!==beforeOpen){el.click();await sleep(120);return}
          if(beforeExpanded==='false'&&el.getAttribute('aria-expanded')==='true'){el.click();await sleep(120)}
        }catch{}
      }
      async function testControls(){
        const controls=[...document.querySelectorAll('button,[role="button"],summary,[aria-haspopup],[aria-expanded],input[type="checkbox"],input[type="radio"]')]
          .filter(safeControl).slice(0,6);
        let tested=0;
        for(const el of controls){
          const label=controlLabel(el);
          const errorsBefore=runtimeErrors.length;
          const sigBefore=signature();
          const checkedBefore=el.checked;
          const expandedBefore=el.getAttribute('aria-expanded');
          const openBefore=el.tagName==='SUMMARY'&&el.parentElement?.tagName==='DETAILS'?el.parentElement.open:null;
          await shot(label+' — before','before');
          let status='PASS',detail='';
          try{
            el.click();
            await sleep(350);
            const sigAfter=signature();
            const newErrors=runtimeErrors.slice(errorsBefore);
            if(newErrors.length){status='FAIL';detail='The page showed this error after I pressed it: '+newErrors[0]}
            else if(sigAfter===sigBefore){status='WARN';detail='I pressed it, but I could not see the screen change.'}
            else detail='I pressed it and the screen changed.';
            await shot(label+' — after','after');
          }catch(err){
            status='FAIL';
            detail=String(err?.message||err);
          }
          parent.postMessage({type:'debooger-control-result',result:{label,status,detail}},origin);
          tested++;
          await restoreControl(el,checkedBefore,expandedBefore,openBefore);
          await sleep(120);
        }
        if(!tested){
          parent.postMessage({type:'debooger-control-result',result:{label:'Safe control discovery',status:'WARN',detail:'I did not find a safe button or switch I could press without risking a real action.'}},origin);
        }
        parent.postMessage({type:'debooger-controls-finished',count:tested},origin);
      }
      document.addEventListener('click',e=>{
        const a=e.target.closest('a[href]');
        if(!a)return;
        const h=a.getAttribute('href')||'';
        if(h&&!/^(https?:|mailto:|tel:|javascript:|#)/i.test(h)&&!h.startsWith('//')){
          e.preventDefault();
          parent.postMessage({type:'debooger-nav',href:h,base},origin);
        }
      });
      window.addEventListener('error',e=>{
        const msg=e.message||'Unknown JavaScript error';
        runtimeErrors.push(msg);
        parent.postMessage({type:'debooger-runtime-error',kind:'javascript-error',message:msg,file:e.filename||'',line:e.lineno||null,col:e.colno||null},origin);
      });
      window.addEventListener('unhandledrejection',e=>{
        const msg='Promise rejection: '+String(e.reason?.message||e.reason||'unknown');
        runtimeErrors.push(msg);
        parent.postMessage({type:'debooger-runtime-error',kind:'unhandled-promise-rejection',message:msg,file:'',line:null,col:null},origin);
      });
      window.addEventListener('load',()=>setTimeout(()=>parent.postMessage({type:'debooger-render-ready',score:pageScore()},origin),900));
      window.addEventListener('message',async e=>{
        if(e.data?.type==='debooger-capture'){
          await shot(e.data.label||document.title||'Page','page');
          parent.postMessage({type:'debooger-capture-finished'},origin);
        }
        if(e.data?.type==='debooger-test-controls')await testControls();
      });
    })();`;
}
