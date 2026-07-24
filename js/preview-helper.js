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
  return `(()=>{
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
        const open=[...document.querySelectorAll('[aria-expanded="true"],dialog[open],details[open],.open,.show,.active')].filter(visible).length;
        const checked=[...document.querySelectorAll('input[type="checkbox"],input[type="radio"]')].filter(x=>x.checked).length;
        const text=(document.body?.innerText||'').replace(/\s+/g,' ').trim().slice(0,1500);
        return JSON.stringify({open,checked,textLen:text.length,visible:pageScore().visible,scrollW:document.documentElement.scrollWidth,scrollH:document.documentElement.scrollHeight});
      }
      async function ensureCapture(){for(let i=0;i<100&&!window.html2canvas;i++)await sleep(100);return !!window.html2canvas}
      async function shot(label,phase=''){
        try{
          if(!await ensureCapture())throw new Error('Screenshot helper did not load');
          const score=pageScore();
          if(score.text<8&&score.visible<5)throw new Error('The rendered page is too empty to count as a real screenshot');
          const root=document.documentElement,w=Math.min(Math.max(root.scrollWidth,document.body?.scrollWidth||0),2200),h=Math.min(Math.max(root.scrollHeight,document.body?.scrollHeight||0),3200);
          const canvas=await window.html2canvas(document.body,{backgroundColor:'#ffffff',useCORS:true,allowTaint:false,logging:false,scale:.5,width:w,height:h,windowWidth:w,windowHeight:h,foreignObjectRendering:false});
          const data=canvas.toDataURL('image/jpeg',.82);
          if(data.length<5000)throw new Error('The screenshot was too small to prove the page rendered correctly');
          parent.postMessage({type:'debooger-screenshot',label,phase,data,score},origin);return true;
        }catch(err){parent.postMessage({type:'debooger-screenshot-error',message:String(err?.message||err),label,phase},origin);return false}
      }
      function controlLabel(el){return (el.getAttribute('aria-label')||el.innerText||el.title||el.name||el.id||el.tagName||'Control').replace(/\s+/g,' ').trim().slice(0,80)}
      function safeControl(el){
        if(!visible(el)||el.disabled)return false;
        const label=controlLabel(el);
        const danger=/delete|remove|send|call|dial|pay|purchase|submit|publish|export|save|message|email|sms|whatsapp|logout|sign out|archive|trash|clear all|kill|stop|upload|choose file|open a folder|paste/i;
        const useful=/menu|more|filter|column|setting|option|view|detail|info|help|sort|tab|expand|collapse|toggle|show|hide|sheet|page|next|previous|fit|desktop|ipad|mobile|preview/i;
        const isCheck=el.matches?.('input[type="checkbox"],input[type="radio"]');
        const isSummary=el.tagName==='SUMMARY';
        const isDevice=el.classList?.contains('device-btn');
        return !danger.test(label)&&(useful.test(label)||isCheck||isSummary||isDevice||el.hasAttribute('aria-haspopup')||el.hasAttribute('aria-expanded'));
      }
      async function restoreControl(el,beforeChecked,beforeExpanded){try{if(el.matches?.('input[type="checkbox"],input[type="radio"]')&&el.checked!==beforeChecked){el.click();await sleep(120);return}if(beforeExpanded==='false'&&el.getAttribute('aria-expanded')==='true'){el.click();await sleep(120)}}catch{}}
      async function testControls(){
        const controls=[...document.querySelectorAll('button,[role="button"],summary,[aria-haspopup],[aria-expanded],input[type="checkbox"],input[type="radio"]')].filter(safeControl).slice(0,6);
        let tested=0;
        for(const el of controls){
          const label=controlLabel(el),errorsBefore=runtimeErrors.length,sigBefore=signature(),checkedBefore=el.checked,expandedBefore=el.getAttribute('aria-expanded');
          await shot(label+' — before','before');
          let status='PASS',detail='';
          try{el.click();await sleep(350);const sigAfter=signature(),newErrors=runtimeErrors.slice(errorsBefore);if(newErrors.length){status='FAIL';detail='JavaScript error: '+newErrors[0]}else if(sigAfter===sigBefore){status='WARN';detail='Click completed but no visible state change was detected'}else detail='Visible state changed after the click';await shot(label+' — after','after')}catch(err){status='FAIL';detail=String(err?.message||err)}
          parent.postMessage({type:'debooger-control-result',result:{label,status,detail}},origin);tested++;await restoreControl(el,checkedBefore,expandedBefore);await sleep(120);
        }
        if(!tested)parent.postMessage({type:'debooger-control-result',result:{label:'Safe control discovery',status:'WARN',detail:'No non-destructive visible controls matched the automatic test rules on this screen'}},origin);
        parent.postMessage({type:'debooger-controls-finished',count:tested},origin);
      }
      document.addEventListener('click',e=>{const a=e.target.closest('a[href]');if(!a)return;const h=a.getAttribute('href')||'';if(h&&!/^(https?:|mailto:|tel:|javascript:|#)/i.test(h)&&!h.startsWith('//')){e.preventDefault();parent.postMessage({type:'debooger-nav',href:h,base},origin)}});
      window.addEventListener('error',e=>{const msg=e.message||'Unknown JavaScript error';runtimeErrors.push(msg);parent.postMessage({type:'debooger-runtime-error',kind:'javascript-error',message:msg,file:e.filename||'',line:e.lineno||null,col:e.colno||null},origin)});
      window.addEventListener('unhandledrejection',e=>{const msg='Promise rejection: '+String(e.reason?.message||e.reason||'unknown');runtimeErrors.push(msg);parent.postMessage({type:'debooger-runtime-error',kind:'unhandled-promise-rejection',message:msg,file:'',line:null,col:null},origin)});
      window.addEventListener('load',()=>setTimeout(()=>parent.postMessage({type:'debooger-render-ready',score:pageScore()},origin),900));
      window.addEventListener('message',async e=>{if(e.data?.type==='debooger-capture'){await shot(e.data.label||document.title||'Page','page');parent.postMessage({type:'debooger-capture-finished'},origin)}if(e.data?.type==='debooger-test-controls')await testControls()});
    })();`;
}
