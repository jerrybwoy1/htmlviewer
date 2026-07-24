export function safeInlineScript(source){
  return String(source||'').replace(/<\/script/gi,'<\\/script');
}

export function buildPreviewRuntime(base,origin){
  return String.raw`(()=>{
      const base=${JSON.stringify(base)};
      const origin=${JSON.stringify(origin)};
      const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      const runtimeErrors=[];
      const sentRuntimeKeys=new Set();
      const nativeConsoleError=console.error.bind(console);
      const nativeFetch=typeof fetch==='function'?fetch.bind(window):null;
      const NativeXHR=window.XMLHttpRequest;

      function textValue(value){
        if(value instanceof Error)return value.stack||value.message||String(value);
        if(typeof value==='string')return value;
        try{return JSON.stringify(value)}catch{return String(value)}
      }
      function isLocalUrl(value){
        const raw=String(value||'');
        if(!raw)return true;
        return !/^(https?:)?\/\//i.test(raw);
      }
      function sendRuntime(kind,message,file='',line=null,col=null,extra={}){
        const item={kind,message:String(message||'Unknown problem'),file:String(file||''),line,col,...extra};
        const key=[item.kind,item.message,item.file,item.line||'',item.col||''].join('|');
        if(sentRuntimeKeys.has(key))return;
        sentRuntimeKeys.add(key);
        runtimeErrors.push(item);
        parent.postMessage({type:'debooger-runtime-error',...item},origin);
      }
      function visible(el){
        if(!el)return false;
        const style=getComputedStyle(el),rect=el.getBoundingClientRect();
        return style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity||1)!==0&&rect.width>2&&rect.height>2;
      }
      function pageScore(){
        const text=(document.body?.innerText||'').trim().length;
        const visibleCount=[...document.querySelectorAll('body *')].filter(visible).length;
        return{text,visible:visibleCount,width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight};
      }
      function hashString(value){
        let hash=2166136261;
        for(let i=0;i<value.length;i++){hash^=value.charCodeAt(i);hash=Math.imul(hash,16777619)}
        return(hash>>>0).toString(36);
      }
      function signature(){
        const body=document.body;
        const open=[...document.querySelectorAll('[aria-expanded="true"],dialog[open],details[open],.open,.show,.active')].filter(visible).length;
        const checked=[...document.querySelectorAll('input[type="checkbox"],input[type="radio"]')].filter(x=>x.checked).length;
        const selected=[...document.querySelectorAll('select')].map(x=>x.selectedIndex).join(',');
        const classes=[...document.querySelectorAll('body *')].slice(0,250).map(x=>x.className&&typeof x.className==='string'?x.className:'').join('|');
        const content=(body?.innerText||'').replace(/\s+/g,' ').trim().slice(0,2500);
        const html=(body?.innerHTML||'').slice(0,12000);
        return JSON.stringify({open,checked,selected,text:hashString(content),dom:hashString(html),classes:hashString(classes),visible:pageScore().visible,scrollW:document.documentElement.scrollWidth,scrollH:document.documentElement.scrollHeight,hash:location.hash});
      }
      async function settlePage(){
        try{if(document.fonts?.ready)await Promise.race([document.fonts.ready,sleep(1600)])}catch{}
        const images=[...document.images].filter(img=>!img.complete);
        if(images.length)await Promise.race([Promise.all(images.map(img=>new Promise(resolve=>{img.addEventListener('load',resolve,{once:true});img.addEventListener('error',resolve,{once:true})}))),sleep(1800)]);
        await sleep(280);
        const first=signature();
        await sleep(260);
        if(signature()!==first)await sleep(360);
      }
      async function captureScreenshot(options={}){
        const label=String(options.label||document.title||base||'Page').slice(0,120);
        const reason=String(options.reason||'Page view').slice(0,180);
        const group=String(options.group||'Page').slice(0,40);
        const device=String(options.device||'Preview').slice(0,30);
        parent.postMessage({type:'debooger-screenshot-started',shot:{label,reason,group,device,page:base}},origin);
        try{
          await settlePage();
          const score=pageScore();
          if(score.text<8&&score.visible<5)throw new Error('The page is almost empty, so a picture would not be useful yet.');
          if(typeof window.html2canvas!=='function')throw new Error('The picture helper did not load in this browser.');
          const width=Math.max(320,Math.min(1920,document.documentElement.clientWidth||window.innerWidth||1280));
          const height=Math.max(320,Math.min(1200,window.innerHeight||document.documentElement.clientHeight||800));
          const scale=width>=1400?.52:width>=1000?.62:width>=700?.72:.9;
          const canvas=await window.html2canvas(document.body,{backgroundColor:'#ffffff',useCORS:true,allowTaint:false,logging:false,scale,width,height,windowWidth:width,windowHeight:height,scrollX:0,scrollY:0,foreignObjectRendering:false,imageTimeout:3500});
          if(!canvas||canvas.width<120||canvas.height<120)throw new Error('The browser returned an empty picture.');
          const data=canvas.toDataURL('image/jpeg',.82);
          if(!/^data:image\/jpeg;base64,/i.test(data)||data.length<3500)throw new Error('The browser did not return a usable picture.');
          parent.postMessage({type:'debooger-screenshot',shot:{label,reason,group,device,data,width,height,page:base}},origin);
          return true;
        }catch(error){
          parent.postMessage({type:'debooger-screenshot-error',error:{label,reason,group,device,page:base,message:String(error?.message||error)}},origin);
          return false;
        }
      }
      function humanize(value){
        return String(value||'').replace(/([a-z])([A-Z])/g,'$1 $2').replace(/[_-]+/g,' ').replace(/\s+/g,' ').trim();
      }
      function controlLabel(el){
        const id=el.id||'';
        const known={groqEnabled:'Groq AI switch',googleEnabled:'Google AI Studio switch',adaptToggle:'Adapt preview switch',fitWidthBtn:'Fit width button',fitPageBtn:'Fit page button',actualBtn:'100% size button'};
        if(known[id])return known[id];
        if(el.classList?.contains('device-btn'))return humanize(el.dataset?.device||'preview')+' preview button';
        let raw=(el.getAttribute('aria-label')||el.getAttribute('title')||el.innerText||el.name||humanize(id)||el.tagName||'control').replace(/\s+/g,' ').trim();
        raw=raw.replace(/\b\d+\s*files?\b/ig,'').trim();
        if(el.tagName==='SUMMARY')return 'Open or close '+(raw||'this section');
        if(el.matches?.('input[type="checkbox"],input[type="radio"]'))return(raw||'This')+' switch';
        if(el.tagName==='BUTTON'||el.getAttribute('role')==='button')return /\bbutton$/i.test(raw)?raw:(raw||'Unnamed')+' button';
        return(raw||'Unnamed control').slice(0,90);
      }
      function safeControl(el){
        if(!visible(el)||el.disabled)return false;
        const label=controlLabel(el);
        const danger=/delete|remove|send|call|dial|pay|purchase|submit|publish|export|save|message|email|sms|whatsapp|logout|sign out|archive|trash|clear|kill|stop|upload|choose|open a folder|paste|download|install|uninstall|connect|disconnect|pair|approve|deny|accept|decline|buy|order|checkout/i;
        const useful=/menu|more|filter|column|setting|option|view|detail|info|help|sort|tab|expand|collapse|toggle|show|hide|sheet|page|next|previous|fit|desktop|ipad|mobile|preview|close|open|theme|mode/i;
        const isCheck=el.matches?.('input[type="checkbox"],input[type="radio"]');
        const isSummary=el.tagName==='SUMMARY';
        const isDevice=el.classList?.contains('device-btn');
        if(isDevice&&el.classList?.contains('active'))return false;
        return !danger.test(label)&&(useful.test(label)||isCheck||isSummary||isDevice||el.hasAttribute('aria-haspopup')||el.hasAttribute('aria-expanded'));
      }
      async function restoreControl(el,before){
        try{
          if(!el.isConnected)return;
          if(el.matches?.('input[type="checkbox"],input[type="radio"]')&&el.checked!==before.checked){el.click();await sleep(120);return}
          if(el.tagName==='SUMMARY'&&el.parentElement?.tagName==='DETAILS'&&el.parentElement.open!==before.open){el.click();await sleep(120);return}
          if(before.expanded==='false'&&el.getAttribute('aria-expanded')==='true'){el.click();await sleep(120)}
        }catch{}
      }
      async function testControls(){
        await settlePage();
        const controls=[...document.querySelectorAll('button,[role="button"],summary,[aria-haspopup],[aria-expanded],input[type="checkbox"],input[type="radio"]')].filter(safeControl).slice(0,12);
        let tested=0;
        for(const el of controls){
          const label=controlLabel(el);
          const errorCount=runtimeErrors.length;
          const sigBefore=signature();
          const before={checked:el.checked,expanded:el.getAttribute('aria-expanded'),open:el.tagName==='SUMMARY'&&el.parentElement?.tagName==='DETAILS'?el.parentElement.open:null};
          let status='PASS',detail='I pressed it. The page changed, and no JavaScript error appeared.';
          try{
            el.click();
            await sleep(450);
            const newErrors=runtimeErrors.slice(errorCount).filter(x=>x.kind==='javascript-error'||x.kind==='unhandled-promise-rejection'||(x.kind==='resource-error'&&x.local));
            if(newErrors.length){status='FAIL';detail='I pressed it and the page reported a real error: '+newErrors[0].message}
            else if(signature()===sigBefore){status='CHECK';detail='I pressed it, but I could not see a safe, measurable change. That does not prove the button is broken, so I am leaving it as a check instead of a failure.'}
            else{
              detail='I pressed it, the screen changed, and no JavaScript crash appeared.';
              await captureScreenshot({label,reason:'This picture shows the useful screen change after I safely pressed this control.',group:'Control',device:'Current preview'});
            }
          }catch(error){status='FAIL';detail='The browser could not finish this safe click test: '+String(error?.message||error);sendRuntime('control-error',detail,base,null,null,{local:true})}
          parent.postMessage({type:'debooger-control-result',result:{label,status,detail}},origin);
          tested++;
          await restoreControl(el,before);
          await sleep(120);
        }
        if(!tested)parent.postMessage({type:'debooger-control-result',result:{label:'Safe button check',status:'SKIP',detail:'I did not find a button I could press without risking a real action such as sending, saving, deleting, or uploading. Nothing is counted as broken.'}},origin);
        parent.postMessage({type:'debooger-controls-finished',count:tested},origin);
      }
      function accessibleName(el){
        return String(el.getAttribute('aria-label')||el.getAttribute('title')||el.innerText||el.textContent||'').replace(/\s+/g,' ').trim();
      }
      const LIVE_CHECK_IDS=[
        'live.empty-screen','live.duplicate-id','live.page-overflow','live.broken-image','live.unnamed-control','live.unlabeled-field','live.label-target','live.aria-reference','live.fragment-target','live.hidden-space','live.fixed-heavy','live.high-z','live.internal-scroll','live.image-dimensions','live.large-dom','live.positive-tabindex'
      ];
      function liveChecks(){
        const results=[];
        const add=(checkId,severity,confidence,title,plain,technical,scoreImpact=false)=>results.push({checkId,severity,confidence,title,plain,technical,file:base,scoreImpact});
        const score=pageScore();
        if(score.text<8&&score.visible<5)add('live.empty-screen','error','high','The running page is almost empty','The page opened, but there is almost nothing visible on it. A startup or rendering problem may have stopped the real screen from appearing.',JSON.stringify(score),true);

        const duplicateIds=new Map();
        document.querySelectorAll('[id]').forEach(el=>duplicateIds.set(el.id,(duplicateIds.get(el.id)||0)+1));
        const dup=[...duplicateIds.entries()].filter(([,count])=>count>1);
        if(dup.length)add('live.duplicate-id','error','high','The running page created duplicate IDs','After the app finished building the screen, more than one element ended up with the same ID. Scripts can grab the wrong element.',dup.slice(0,12).map(x=>x[0]+' ('+x[1]+' times)').join('\n'),true);

        if(document.documentElement.scrollWidth>window.innerWidth+6){
          const offenders=[...document.querySelectorAll('body *')].filter(visible).map(el=>({el,rect:el.getBoundingClientRect()})).filter(x=>x.rect.right>window.innerWidth+6||x.rect.width>window.innerWidth+6).sort((a,b)=>b.rect.right-a.rect.right).slice(0,8);
          add('live.page-overflow','warning','medium','The running page is wider than the preview window','Part of the page sticks past the right edge, which can create unwanted side-to-side scrolling. Wide tables can do this on purpose, so the score penalty is small.',offenders.map(x=>humanize(x.el.id||x.el.className||x.el.tagName)+' right edge '+Math.round(x.rect.right)+'px').join('\n'),true);
        }

        const brokenImages=[...document.images].filter(img=>visible(img)&&img.complete&&img.naturalWidth===0);
        if(brokenImages.length)add('live.broken-image','warning','high','A visible picture did not load','The page has a picture area, but the browser could not load the image file.',brokenImages.slice(0,8).map(img=>img.currentSrc||img.src||'[no src]').join('\n'),true);

        const unnamed=[...document.querySelectorAll('button,[role="button"],a[href]')].filter(el=>visible(el)&&!accessibleName(el)&&!el.getAttribute('aria-labelledby'));
        if(unnamed.length)add('live.unnamed-control','warning','high','Some clickable controls have no readable name',unnamed.length+' visible control'+(unnamed.length===1?' has':'s have')+' no text, title, or accessibility name. A screen reader may only say “button” or “link”.',unnamed.slice(0,10).map(el=>el.outerHTML.slice(0,120)).join('\n'),true);

        const fields=[...document.querySelectorAll('input,select,textarea')].filter(el=>visible(el)&&!['hidden','button','submit','reset','image'].includes((el.getAttribute('type')||'').toLowerCase()));
        const unlabeled=fields.filter(el=>!(el.getAttribute('aria-label')||el.getAttribute('aria-labelledby')||el.closest('label')||(el.labels&&el.labels.length)));
        if(unlabeled.length)add('live.unlabeled-field','warning','high','Some visible form boxes do not say what they are for',unlabeled.length+' visible field'+(unlabeled.length===1?' has':'s have')+' no connected label. A screen reader may not be able to explain what should be entered there.',unlabeled.slice(0,10).map(el=>el.outerHTML.slice(0,140)).join('\n'),true);

        const badLabels=[...document.querySelectorAll('label[for]')].filter(label=>visible(label)&&label.htmlFor&&!document.getElementById(label.htmlFor));
        if(badLabels.length)add('live.label-target','warning','high','A visible label points to a field that does not exist','The page is fully running, but a label still points to an ID that is not on the page. Clicking that label cannot focus the intended field.',badLabels.slice(0,10).map(label=>'for="'+label.htmlFor+'"').join('\n'),true);

        const badAria=[];
        document.querySelectorAll('[aria-labelledby],[aria-describedby],[aria-controls]').forEach(el=>{
          if(!visible(el))return;
          for(const attr of ['aria-labelledby','aria-describedby','aria-controls']){
            const value=el.getAttribute(attr);if(!value)continue;
            for(const id of value.trim().split(/\s+/))if(id&&!document.getElementById(id))badAria.push(attr+' -> #'+id);
          }
        });
        if(badAria.length)add('live.aria-reference','info','low','An accessibility helper points to an ID that is not on the running page','This can be a real accessibility problem, but some apps create the target only after a menu opens. I am showing it for review instead of calling it broken.',[...new Set(badAria)].slice(0,12).join('\n'),false);

        const badFragments=[...document.querySelectorAll('a[href^="#"]')].filter(a=>visible(a)).map(a=>a.getAttribute('href')).filter(h=>h&&h.length>1&&!document.getElementById(h.slice(1)));
        if(badFragments.length)add('live.fragment-target','info','low','A visible same-page link has no matching section yet','The link points to an ID that is not on the current running page. A script may create it later, so this is review-only.',[...new Set(badFragments)].slice(0,12).join('\n'),false);

        const hiddenSpace=[...document.querySelectorAll('body *')].filter(el=>{const style=getComputedStyle(el),rect=el.getBoundingClientRect();return style.visibility==='hidden'&&rect.width>20&&rect.height>20});
        if(hiddenSpace.length>4)add('live.hidden-space','info','low','Several invisible items still take up room on the page','visibility:hidden hides an item but keeps its space. That can be intentional, so I am only pointing it out for review.',hiddenSpace.slice(0,8).map(el=>humanize(el.id||el.className||el.tagName)).join('\n'),false);

        const fixed=[...document.querySelectorAll('body *')].filter(el=>visible(el)&&getComputedStyle(el).position==='fixed');
        if(fixed.length>6)add('live.fixed-heavy','info','low','Many visible items are fixed to the screen',fixed.length+' visible elements use position:fixed. On small screens they can overlap, so this is worth a visual check.',fixed.slice(0,8).map(el=>humanize(el.id||el.className||el.tagName)).join('\n'),false);

        const highZ=[...document.querySelectorAll('body *')].filter(el=>{const z=Number.parseInt(getComputedStyle(el).zIndex,10);return visible(el)&&Number.isFinite(z)&&z>9999});
        if(highZ.length)add('live.high-z','info','low','Some visible layers use very high z-index values','Very large z-index values can be a sign that panels are competing to stay on top. This is review-only.',highZ.slice(0,8).map(el=>humanize(el.id||el.className||el.tagName)+' z-index '+getComputedStyle(el).zIndex).join('\n'),false);

        const internalScroll=[...document.querySelectorAll('body *')].filter(el=>{const style=getComputedStyle(el);return visible(el)&&(style.overflowX==='auto'||style.overflowX==='scroll')&&el.scrollWidth>el.clientWidth+8});
        if(internalScroll.length>5)add('live.internal-scroll','info','low','Several areas have their own side-to-side scrolling','This may be normal for tables or carousels. I found multiple containers whose content is wider than the container.',internalScroll.slice(0,8).map(el=>humanize(el.id||el.className||el.tagName)).join('\n'),false);

        const noDimensions=[...document.images].filter(img=>visible(img)&&img.complete&&img.naturalWidth>0&&!img.hasAttribute('width')&&!img.hasAttribute('height'));
        if(noDimensions.length>6)add('live.image-dimensions','info','low','Several pictures do not reserve their size in the HTML','The browser may need to wait for these pictures before it knows how much room they need. CSS may already handle this, so it is only a performance/layout review.',noDimensions.slice(0,10).map(img=>img.currentSrc||img.src||'[image]').join('\n'),false);

        const domCount=document.querySelectorAll('body *').length;
        if(domCount>2500)add('live.large-dom','info','low','The running page contains a very large number of elements','I counted '+domCount+' elements on this screen. Large pages can become slower to draw and update, but complex apps can legitimately need many elements.',String(domCount)+' DOM elements',false);

        const positiveTab=[...document.querySelectorAll('[tabindex]')].filter(el=>visible(el)&&Number(el.getAttribute('tabindex'))>0);
        if(positiveTab.length)add('live.positive-tabindex','info','low','Some controls force a custom keyboard tab order','Positive tabindex values can make keyboard navigation jump around in an unexpected order. This is review-only.',positiveTab.slice(0,10).map(el=>humanize(el.id||el.className||el.tagName)+' tabindex='+el.getAttribute('tabindex')).join('\n'),false);

        parent.postMessage({type:'debooger-live-findings',findings:results},origin);
        parent.postMessage({type:'debooger-live-checks-finished',count:results.length,tests:LIVE_CHECK_IDS},origin);
      }

      window.addEventListener('error',event=>{
        const target=event.target;
        if(target&&target!==window){
          if(target.dataset?.deboogerHelper)return;
          const url=target.currentSrc||target.src||target.href||'';
          sendRuntime('resource-error','The browser could not load '+(url||target.tagName||'a page resource'),url||base,null,null,{local:isLocalUrl(url)});
          return;
        }
        sendRuntime('javascript-error',event.message||'Unknown JavaScript error',event.filename||base,event.lineno||null,event.colno||null,{local:isLocalUrl(event.filename||'')});
      },true);
      window.addEventListener('unhandledrejection',event=>{
        sendRuntime('unhandled-promise-rejection','Promise rejection: '+textValue(event.reason||'unknown'),base,null,null,{local:true});
      });
      console.error=function(...args){
        nativeConsoleError(...args);
        const message=args.map(textValue).join(' ').slice(0,1200);
        if(message)sendRuntime('console-error',message,base,null,null,{local:true});
      };
      if(nativeFetch){
        window.fetch=async function(input,init){
          const url=typeof input==='string'?input:(input?.url||'');
          try{
            const response=await nativeFetch(input,init);
            if(!response.ok)sendRuntime('network-error','Fetch returned HTTP '+response.status+' for '+String(url||response.url||'request'),String(url||response.url||base),null,null,{local:isLocalUrl(url||response.url)});
            return response;
          }catch(error){
            sendRuntime('network-error','Fetch failed for '+String(url||'request')+': '+textValue(error),String(url||base),null,null,{local:isLocalUrl(url)});
            throw error;
          }
        };
      }
      if(NativeXHR){
        const nativeOpen=NativeXHR.prototype.open,nativeSend=NativeXHR.prototype.send;
        NativeXHR.prototype.open=function(method,url,...rest){this.__deboogerMethod=method;this.__deboogerUrl=url;return nativeOpen.call(this,method,url,...rest)};
        NativeXHR.prototype.send=function(...args){
          this.addEventListener('load',()=>{if(this.status>=400)sendRuntime('network-error','XHR returned HTTP '+this.status+' for '+String(this.__deboogerUrl||''),String(this.__deboogerUrl||base),null,null,{local:isLocalUrl(this.__deboogerUrl)})},{once:true});
          this.addEventListener('error',()=>sendRuntime('network-error','XHR could not reach '+String(this.__deboogerUrl||'request'),String(this.__deboogerUrl||base),null,null,{local:isLocalUrl(this.__deboogerUrl)}),{once:true});
          return nativeSend.apply(this,args);
        };
      }
      document.addEventListener('click',event=>{
        const anchor=event.target.closest('a[href]');
        if(!anchor)return;
        const href=anchor.getAttribute('href')||'';
        if(href&&!/^(https?:|mailto:|tel:|javascript:|#)/i.test(href)&&!href.startsWith('//')){
          event.preventDefault();
          parent.postMessage({type:'debooger-nav',href,base},origin);
        }
      });
      window.addEventListener('load',()=>setTimeout(()=>parent.postMessage({type:'debooger-render-ready',score:pageScore()},origin),900));
      window.addEventListener('message',async event=>{
        if(event.data?.type==='debooger-test-controls')await testControls();
        else if(event.data?.type==='debooger-run-live-checks')liveChecks();
        else if(event.data?.type==='debooger-capture-screenshot'){
          const ok=await captureScreenshot(event.data.options||{});
          parent.postMessage({type:'debooger-screenshot-finished',ok},origin);
        }
      });
    })();`;
}
