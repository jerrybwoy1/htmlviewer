import { chromium } from 'playwright';
import JSZip from 'jszip';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const result={stage:'start',ok:false,error:null,pageErrors:[],details:{}};
const save=()=>fs.writeFileSync('build002-test-result.json',JSON.stringify(result,null,2));
let browser;
try{
  const zip = new JSZip();
  zip.file('index.html', '<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fixture</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>');
  zip.file('package.json', JSON.stringify({dependencies:{react:'^19.0.1','react-dom':'^19.0.1',tailwindcss:'^4.1.14','@tailwindcss/vite':'^4.1.14'},devDependencies:{'@vitejs/plugin-react':'^5.0.4'},scripts:{build:'vite build'}}));
  zip.file('vite.config.ts', 'export default {}');
  zip.file('src/main.tsx', `import React from 'react'; import {createRoot} from 'react-dom/client'; import './index.css'; import App from './App'; createRoot(document.getElementById('root')!).render(<App/>);`);
  zip.file('src/App.tsx', `import React,{useState} from 'react'; export default function App(){const [open,setOpen]=useState(false);return <main className="bg-slate-900 text-white p-4"><h1>REAL REACT SCREEN</h1><button aria-haspopup="true" onClick={()=>setOpen(v=>!v)}>Settings</button>{open&&<div role="dialog">OPENED SETTINGS</div>}</main>}`);
  zip.file('src/index.css', '@import "tailwindcss"; body{margin:0}');
  const buffer = await zip.generateAsync({type:'nodebuffer'});

  result.stage='launch'; save();
  browser = await chromium.launch({headless:true});
  const page = await browser.newPage({viewport:{width:390,height:844}});
  page.on('pageerror',e=>result.pageErrors.push(String(e)));
  page.on('console',m=>{if(m.type()==='error')result.pageErrors.push('console: '+m.text())});

  result.stage='open-debooger'; save();
  await page.goto('http://127.0.0.1:4173/index.html',{waitUntil:'domcontentloaded'});
  await page.setInputFiles('#fileInput',{name:'fixture.zip',mimeType:'application/zip',buffer});
  await page.waitForTimeout(12000);

  result.stage='mobile-shell'; save();
  assert.equal(await page.locator('#pasteBtn').isVisible(),false,'Paste must be hidden from mobile top bar');
  assert.equal(await page.locator('#clearBtn').isVisible(),false,'Clear must be hidden from mobile top bar');
  assert.equal(await page.locator('#moreBtn').isVisible(),true,'More button must be visible on mobile');

  result.stage='react-render'; save();
  const frame=page.frames().find(f=>f!==page.mainFrame());
  assert(frame,'preview iframe must exist');
  await frame.waitForSelector('text=REAL REACT SCREEN',{timeout:15000});
  const bg=await frame.locator('main').evaluate(el=>getComputedStyle(el).backgroundColor);
  result.details.background=bg;
  assert.notEqual(bg,'rgba(0, 0, 0, 0)','Tailwind styles should render');

  result.stage='fullscreen'; save();
  await page.locator('#fullBtn').click();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('main.main').evaluate(el=>el.classList.contains('viewer-full')),true,'full screen fallback class must activate');
  await page.locator('#exitFullBtn').click();
  await page.waitForTimeout(300);

  result.stage='screenshots'; save();
  await page.waitForFunction(()=>document.getElementById('shotCount')?.textContent!=='0',{timeout:25000});
  result.details.shotCount=Number(await page.locator('#shotCount').textContent());
  assert(result.details.shotCount>0,'audit must capture real screenshots');

  result.stage='mobile-results'; save();
  await page.locator('#openResultsBtn').click();
  assert.equal(await page.locator('#resultsModal').isVisible(),true,'mobile results must open');

  result.stage='file-list'; save();
  await page.locator('.files-card summary').click();
  const fileText=await page.locator('#fileList').innerText();
  result.details.fileText=fileText.slice(0,1500);
  assert(fileText.includes('src/App.tsx'),'full file path must be visible');
  assert(fileText.includes('Program code'),'simple file explanation must be visible');

  if(result.pageErrors.length) throw new Error('Page errors: '+result.pageErrors.join(' | '));
  result.stage='complete'; result.ok=true; save();
  console.log('BUILD002_RUNTIME_PASS');
}catch(err){
  result.error=String(err?.stack||err?.message||err); save();
  console.error('BUILD002_RUNTIME_FAIL',result.stage,result.error);
  throw err;
}finally{
  if(browser) await browser.close();
  save();
}
