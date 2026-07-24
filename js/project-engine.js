import {safeInlineScript,getScreenshotHelper,buildPreviewRuntime} from './preview-helper.js';
const MIME={html:'text/html',htm:'text/html',css:'text/css',js:'text/javascript',mjs:'text/javascript',jsx:'text/jsx',tsx:'text/tsx',ts:'text/typescript',json:'application/json',txt:'text/plain',md:'text/markdown',csv:'text/csv',xml:'application/xml',svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',bmp:'image/bmp',ico:'image/x-icon',pdf:'application/pdf',zip:'application/zip',woff:'font/woff',woff2:'font/woff2',ttf:'font/ttf',otf:'font/otf'};
const CODE_EXTS=['ts','tsx','js','jsx','mjs'];
export const norm=p=>String(p||'').replaceAll('\\','/').replace(/^\.\//,'').replace(/^\//,'');
export const ext=n=>{const clean=String(n||'').split(/[?#]/)[0];const i=clean.lastIndexOf('.');return i<0?'':clean.slice(i+1).toLowerCase()};
export const mime=n=>MIME[ext(n)]||'application/octet-stream';

export function classify(files){
  const names=[...files.keys()].map(n=>n.toLowerCase());
  const has=n=>names.some(x=>x===n||x.endsWith('/'+n));
  let type='Mixed project',runtime='Browser';
  if(has('package.json')){
    if(names.some(x=>x.includes('electron'))||has('electron.js')||has('main.cjs'))type='Electron application';
    else if(names.some(x=>x.includes('vite.config')))type='Vite web application';
    else if(names.some(x=>x.includes('next.config')))type='Next.js application';
    else if(names.some(x=>x.endsWith('.jsx')||x.endsWith('.tsx')))type='React/Node application';
    else type='Node/JavaScript application';
  } else if(names.some(n=>n.endsWith('.html')||n.endsWith('.htm'))){
    type=names.filter(n=>/\.html?$/.test(n)).length>1?'Multi-page website':'HTML website';
  } else if(names.some(n=>/\.(jsx|tsx)$/.test(n))){
    type='React-style source project';
  } else if(names.some(n=>n.endsWith('.py'))){
    type='Python project';
  }
  if(type.includes('Electron'))runtime='Desktop runtime + browser-style interface';
  else if(type.includes('Next')||type.includes('Node')||type.includes('React/Node')||type.includes('Vite'))runtime='Build/server runtime';
  else if(type.includes('Python'))runtime='Python runtime';
  const pages=names.filter(n=>/\.html?$/.test(n));
  return{type,runtime,fileCount:names.length,pageCount:pages.length,pages};
}

function dirname(p){const i=p.lastIndexOf('/');return i>=0?p.slice(0,i+1):''}
function cleanRef(ref){return String(ref||'').split('#')[0].split('?')[0]}

export function resolve(base,ref){
  if(!ref||/^(data:|blob:|https?:|mailto:|tel:|javascript:|#|\/\/)/i.test(ref))return ref;
  const clean=cleanRef(ref);
  if(clean.startsWith('/'))return norm(clean);
  const a=dirname(base).split('/').filter(Boolean);
  for(const x of clean.split('/')){
    if(!x||x==='.')continue;
    if(x==='..')a.pop();
    else a.push(x);
  }
  return a.join('/');
}

function splitSrcset(value){
  return String(value||'').split(',').map(x=>x.trim()).filter(Boolean).map(part=>{
    const bits=part.split(/\s+/);
    return{url:bits.shift(),descriptor:bits.join(' ')};
  });
}

function isLocalRef(ref){
  return !!ref&&!/^(data:|blob:|https?:|mailto:|tel:|javascript:|#|\/\/)/i.test(ref);
}

function isModuleLocalRef(ref){
  return !!ref&&!/^(data:|blob:|https?:|mailto:|tel:|javascript:|#|\/\/)/i.test(ref)&&/^(\.?\.?\/|\/)/.test(ref);
}

function isBareRef(ref){
  return !!ref&&!isModuleLocalRef(ref)&&!/^(data:|blob:|https?:|mailto:|tel:|javascript:|#|\/\/)/i.test(ref);
}

function packageRoot(spec){if(spec.startsWith('@'))return spec.split('/').slice(0,2).join('/');return spec.split('/')[0]}
function packageSubpath(spec){const root=packageRoot(spec);return spec.slice(root.length)}

function bufToBase64(buf){
  const bytes=new Uint8Array(buf);
  let binary='';
  const chunk=8192;
  for(let i=0;i<bytes.length;i+=chunk){
    binary+=String.fromCharCode(...bytes.subarray(i,i+chunk));
  }
  return btoa(binary);
}

export class ProjectRuntime{
  constructor(){
    this.files=new Map();
    this.urls=new Map();
    this.bundleCache=new Map();
    this.packageVersions={};
    this.compileErrors=[];
  }

  clear(){
    for(const u of this.urls.values())if(u.startsWith('blob:'))URL.revokeObjectURL(u);
    this.urls.clear();
    this.bundleCache.clear();
    this.files.clear();
    this.packageVersions={};
    this.compileErrors=[];
  }

  async addFiles(list){
    this.clear();
    const out=[];
    for(const f of [...list]){
      if(ext(f.name)==='zip'){
        if(typeof JSZip==='undefined')throw new Error('ZIP support did not load. Check the internet connection and try again.');
        const z=await JSZip.loadAsync(f);
        for(const zf of Object.values(z.files).filter(x=>!x.dir&&!/^__MACOSX\//i.test(x.name))){
          const b=await zf.async('blob');
          out.push(new File([b],norm(zf.name),{type:mime(zf.name)}));
        }
      } else {
        const n=f.webkitRelativePath||f.name;
        out.push(new File([f],norm(n),{type:f.type||mime(n)}));
      }
    }
    for(const f of out)this.files.set(norm(f.name),f);
    await this.readPackageInfo();
    return out;
  }

  async readPackageInfo(){
    const p=[...this.files.keys()].find(n=>/(^|\/)package\.json$/i.test(n));
    if(!p)return;
    try{const j=JSON.parse(await this.files.get(p).text());this.packageVersions={...(j.dependencies||{}),...(j.devDependencies||{})}}
    catch{this.packageVersions={}}
  }

  isReactSourceProject(){
    const names=[...this.files.keys()];
    if(names.some(n=>/\.html?$/i.test(n)))return false;
    return names.some(n=>/\.(jsx|tsx)$/i.test(n))||names.some(n=>/(^|\/)package\.json$/i.test(n));
  }

  findReactEntry(){
    const names=[...this.files.keys()];
    const candidates=['src/main.tsx','src/main.jsx','src/main.ts','src/main.js','src/index.tsx','src/index.jsx','src/index.ts','src/index.js','src/App.tsx','src/App.jsx','main.tsx','main.jsx','index.tsx','index.jsx'];
    return candidates.find(c=>names.includes(c))||names.find(n=>/\.(tsx|jsx)$/i.test(n))||null;
  }

  synthesizeReactHtml(){
    const entry=this.findReactEntry();
    if(!entry)return null;
    const usesTailwind=Object.keys(this.packageVersions).some(k=>k==='tailwindcss'||k.startsWith('@tailwindcss/'));
    const tw=usesTailwind?`<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.1.14" data-debooger-helper="tailwind"></script>`:'';
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Preview</title>
${tw}
</head>
<body>
<div id="root"></div>
<script type="module" src="/${entry}"></script>
</body>
</html>`;
  }

  entry(){
    const n=[...this.files.keys()];
    const htmlEntry=['index.html','index.htm','dist/index.html','build/index.html','public/index.html','src/index.html']
      .find(p=>n.includes(p))||n.find(x=>/(^|\/)index\.html?$/i.test(x))||n.find(x=>/\.html?$/i.test(x));
    if(htmlEntry)return htmlEntry;
    if(this.isReactSourceProject())return '__synthesized_react__';
    return n[0];
  }

  findLocal(base,spec){
    const resolved=norm(resolve(base,spec));
    if(this.files.has(resolved))return resolved;
    const e=ext(resolved);
    const candidates=e?[resolved]:[...CODE_EXTS.map(x=>`${resolved}.${x}`),`${resolved}.json`,...CODE_EXTS.map(x=>`${resolved}/index.${x}`),`${resolved}/index.json`];
    return candidates.find(x=>this.files.has(x))||resolved;
  }

  async dataUrl(path){
    path=norm(cleanRef(path));
    if(this.urls.has(path))return this.urls.get(path);
    const f=this.files.get(path);
    if(!f)return null;
    const buf=await f.arrayBuffer();
    const b64=bufToBase64(buf);
    const mt=f.type||mime(path)||'application/octet-stream';
    const u=`data:${mt};base64,${b64}`;
    this.urls.set(path,u);
    return u;
  }

  objectUrl(path){
    path=norm(cleanRef(path));
    if(this.urls.has(path))return this.urls.get(path);
    const f=this.files.get(path);
    if(!f)return null;
    const u=URL.createObjectURL(f);
    this.urls.set(path,u);
    return u;
  }

  externalUrl(spec){
    const root=packageRoot(spec),sub=packageSubpath(spec);
    const version=String(this.packageVersions[root]||'').replace(/^[~^<>= ]+/,'');
    const pinned=version?`${root}@${version}${sub}`:spec;
    const qs=(root==='react'||root==='react-dom')?'?dev':'?dev&external=react,react-dom';
    return `https://esm.sh/${pinned}${qs}`;
  }

  transpile(source,path){
    if(!['ts','tsx','jsx'].includes(ext(path)))return source;
    if(typeof Babel==='undefined')throw new Error('The built-in React/TypeScript compiler did not load.');
    const e=ext(path),presets=[];
    if(e==='ts'||e==='tsx')presets.push(['typescript',{allExtensions:true,isTSX:e==='tsx'}]);
    if(e==='jsx'||e==='tsx')presets.push(['react',{runtime:'automatic'}]);
    try{return Babel.transform(source,{filename:path,sourceType:'module',presets,retainLines:false}).code}
    catch(err){this.compileErrors.push({file:path,message:String(err?.message||err)});throw new Error(`Could not compile ${path}: ${err?.message||err}`)}
  }

  modulePresets(path){
    const e=ext(path),presets=[];
    if(e==='ts'||e==='tsx')presets.push(['typescript',{allExtensions:true,isTSX:e==='tsx'}]);
    if(e==='jsx'||e==='tsx')presets.push(['react',{runtime:'automatic'}]);
    return presets;
  }

  collectSpecs(source,path='module.js'){
    if(typeof Babel==='undefined')throw new Error('The built-in JavaScript/TypeScript parser did not load.');
    const specs=[];
    const seen=new Set();
    const collector=()=>({visitor:{
      ImportDeclaration(p){const v=p.node.source?.value;if(v&&!seen.has(v)){seen.add(v);specs.push(v)}},
      ExportNamedDeclaration(p){const v=p.node.source?.value;if(v&&!seen.has(v)){seen.add(v);specs.push(v)}},
      ExportAllDeclaration(p){const v=p.node.source?.value;if(v&&!seen.has(v)){seen.add(v);specs.push(v)}},
      CallExpression(p){
        if(p.node.callee?.type!=='Import'||p.node.arguments?.length!==1)return;
        const a=p.node.arguments[0];
        if(a?.type==='StringLiteral'&&a.value&&!seen.has(a.value)){seen.add(a.value);specs.push(a.value)}
      }
    }});
    try{Babel.transform(source,{filename:path,sourceType:'module',presets:this.modulePresets(path),plugins:[collector],ast:false,code:false})}
    catch(err){this.compileErrors.push({file:path,message:String(err?.message||err)});throw new Error(`Could not parse ${path}: ${err?.message||err}`)}
    return specs;
  }

  removeCssImports(source){
    return source
      .replace(/\bimport\s*['"][^'"]+\.css(?:[?#][^'"]*)?['"]\s*;?/g,'')
      .replace(/\bimport\s+[^;]+\s+from\s*['"][^'"]+\.css(?:[?#][^'"]*)?['"]\s*;?/g,'');
  }

  isAssetModule(path){
    return !CODE_EXTS.includes(ext(path))&&ext(path)!=='json'&&ext(path)!=='css';
  }

  async buildModuleBundle(entry){
    entry=norm(cleanRef(entry));
    if(this.bundleCache.has(entry))return this.bundleCache.get(entry);
    if(typeof Babel==='undefined')throw new Error('The built-in React/TypeScript compiler did not load.');

    const modules=new Map();
    const assets=new Map();
    const externals=new Map();
    const visiting=new Set();

    const walk=async path=>{
      path=norm(cleanRef(path));
      if(modules.has(path)||assets.has(path)||visiting.has(path))return;
      const f=this.files.get(path);
      if(!f)throw new Error(`Local module not found: ${path}`);
      if(this.isAssetModule(path)){
        const uri=await this.dataUrl(path);
        assets.set(path,uri);
        return;
      }
      if(ext(path)==='json'){
        const text=await f.text();
        let value;
        try{value=JSON.parse(text)}catch(err){throw new Error(`Invalid JSON module ${path}: ${err?.message||err}`)}
        modules.set(path,{source:`module.exports=${JSON.stringify(value)};`,map:new Map()});
        return;
      }
      if(ext(path)==='css')return;

      visiting.add(path);
      let source=await f.text();
      const specs=this.collectSpecs(source,path);
      const map=new Map();
      for(const spec of specs){
        if(/\.css(?:[?#].*)?$/i.test(spec)){map.set(spec,'css:');continue}
        if(isModuleLocalRef(spec)){
          const local=this.findLocal(path,spec);
          if(!this.files.has(local))throw new Error(`Could not resolve ${spec} from ${path}`);
          if(this.isAssetModule(local)){
            await walk(local);
            map.set(spec,`asset:${local}`);
          }else if(ext(local)==='css'){
            map.set(spec,'css:');
          }else{
            await walk(local);
            map.set(spec,`local:${local}`);
          }
        }else if(isBareRef(spec)){
          if(!externals.has(spec))externals.set(spec,this.externalUrl(spec));
          map.set(spec,`ext:${spec}`);
        }
      }
      visiting.delete(path);
      modules.set(path,{source,map});
    };

    await walk(entry);

    const compile=(source,path,map)=>{
      const rewrite=()=>({visitor:{
        ImportDeclaration(p){const v=p.node.source?.value;if(map.has(v)){if(map.get(v)==='css:'){p.remove()}else p.node.source.value=map.get(v)}},
        ExportNamedDeclaration(p){const v=p.node.source?.value;if(v&&map.has(v))p.node.source.value=map.get(v)},
        ExportAllDeclaration(p){const v=p.node.source?.value;if(v&&map.has(v))p.node.source.value=map.get(v)},
        CallExpression(p){
          if(p.node.callee?.type!=='Import'||p.node.arguments?.length!==1)return;
          const a=p.node.arguments[0];
          if(a?.type!=='StringLiteral'||!map.has(a.value))return;
          const id=map.get(a.value);
          if(id==='css:')p.replaceWithSourceString('Promise.resolve({})');
          else p.replaceWithSourceString(`Promise.resolve().then(()=>require(${JSON.stringify(id)}))`);
        }
      }});
      try{return Babel.transform(source,{filename:path,sourceType:'module',presets:this.modulePresets(path),plugins:[rewrite,'transform-modules-commonjs'],retainLines:false}).code}
      catch(err){this.compileErrors.push({file:path,message:String(err?.message||err)});throw new Error(`Could not compile ${path}: ${err?.message||err}`)}
    };

    const extDecl=[];
    const extEntries=[];
    let i=0;
    for(const [spec,url] of externals){
      const name=`__ext${i++}`;
      extDecl.push(`import * as ${name} from ${JSON.stringify(url)};`);
      extEntries.push(`${JSON.stringify(`ext:${spec}`)}:Object.assign({__esModule:true},${name})`);
    }
    const assetEntries=[...assets].map(([path,uri])=>`${JSON.stringify(`asset:${path}`)}:{__esModule:true,default:${JSON.stringify(uri)}}`);
    const moduleEntries=[];
    for(const [path,item] of modules){
      const code=compile(item.source,path,item.map);
      moduleEntries.push(`${JSON.stringify(`local:${path}`)}:function(module,exports,require){\n${code}\n}`);
    }

    const bundle=`${extDecl.join('\n')}\nconst __externalModules={${extEntries.join(',')}};\nconst __assetModules={${assetEntries.join(',')}};\nconst __modules={${moduleEntries.join(',')}};\nconst __cache=Object.create(null);\nfunction __require(id){\n  if(id==='css:')return {};\n  if(Object.prototype.hasOwnProperty.call(__externalModules,id))return __externalModules[id];\n  if(Object.prototype.hasOwnProperty.call(__assetModules,id))return __assetModules[id];\n  if(!Object.prototype.hasOwnProperty.call(__modules,id))throw new Error('Unknown module '+id);\n  if(__cache[id])return __cache[id].exports;\n  const module={exports:{}};__cache[id]=module;\n  __modules[id](module,module.exports,__require);\n  return module.exports;\n}\n__require(${JSON.stringify(`local:${entry}`)});`;
    this.bundleCache.set(entry,bundle);
    return bundle;
  }

  async cssRewrite(css,base,seen=new Set()){
    if(seen.has(base))return css;
    seen.add(base);
    css=css.replace(/@import\s+["']tailwindcss["']\s*;?/gi,'');
    css=css.replace(/@import\s+["']tailwindcss\/[^'"]*["']\s*;?/gi,'');
    for(const m of [...css.matchAll(/@import\s+(?:url\()?["']?([^'")\;\s]+)["']?\)?\s*;?/gi)]){
      const p=this.findLocal(base,m[1]),f=this.files.get(p);
      if(f&&ext(p)==='css'){const imported=await this.cssRewrite(await f.text(),p,seen);css=css.replace(m[0],`\n${imported}\n`)}
    }
    for(const m of [...css.matchAll(/url\((["']?)([^'"]+)\1\)/g)]){
      const ref=m[2].trim();
      if(!isLocalRef(ref))continue;
      const u=await this.dataUrl(this.findLocal(base,ref));
      if(u)css=css.split(m[0]).join(`url("${u}")`);
    }
    return css;
  }

  async injectProjectCss(d,alreadyInlined=new Set()){
    const cssFiles=[...this.files.keys()].filter(n=>ext(n)==='css'&&!alreadyInlined.has(n));
    if(!cssFiles.length)return;
    const usesTailwind=cssFiles.some(n=>n.toLowerCase().includes('tailwind'))||Object.keys(this.packageVersions).some(k=>k==='tailwindcss'||k.startsWith('@tailwindcss/'));
    if(usesTailwind&&!d.querySelector('script[data-debooger-helper="tailwind"]')){
      const tw=d.createElement('script');
      tw.src='https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.1.14';
      tw.setAttribute('data-debooger-helper','tailwind');
      d.head.appendChild(tw);
    }
    for(const p of cssFiles){
      const st=d.createElement('style');
      if(usesTailwind)st.type='text/tailwindcss';
      st.setAttribute('data-debooger-source',p);
      st.textContent=await this.cssRewrite(await this.files.get(p).text(),p);
      d.head.appendChild(st);
    }
  }

  async htmlRewrite(src,base,inject=''){
    const d=new DOMParser().parseFromString(src,'text/html');

    d.querySelectorAll('meta[http-equiv]').forEach(m=>{
      const v=(m.getAttribute('http-equiv')||'').toLowerCase();
      if(v==='content-security-policy'||v==='content-security-policy-report-only')m.remove();
    });

    const inlinedCss=new Set();
    for(const l of [...d.querySelectorAll('link[rel="stylesheet"][href]')]){
      const p=this.findLocal(base,l.getAttribute('href')),f=this.files.get(p);
      if(f){const st=d.createElement('style');st.setAttribute('data-debooger-source',p);st.textContent=await this.cssRewrite(await f.text(),p);l.replaceWith(st);inlinedCss.add(p)}
    }
    await this.injectProjectCss(d,inlinedCss);

    for(const l of [...d.querySelectorAll('link[href]')]){
      if((l.getAttribute('rel')||'').toLowerCase()==='stylesheet')continue;
      const ref=l.getAttribute('href');
      if(!isLocalRef(ref))continue;
      const u=await this.dataUrl(this.findLocal(base,ref));
      if(u)l.setAttribute('href',u);
    }

    for(const el of [...d.querySelectorAll('[src],[poster]')].filter(el=>el.tagName!=='SCRIPT')){
      for(const a of ['src','poster']){
        const r=el.getAttribute(a);
        if(!isLocalRef(r))continue;
        const u=await this.dataUrl(this.findLocal(base,r));
        if(u)el.setAttribute(a,u);
      }
    }

    for(const el of [...d.querySelectorAll('[srcset]')]){
      const parts=splitSrcset(el.getAttribute('srcset')),next=[];
      for(const item of parts){
        const u=isLocalRef(item.url)?await this.dataUrl(this.findLocal(base,item.url)):null;
        next.push(`${u||item.url}${item.descriptor?' '+item.descriptor:''}`);
      }
      if(next.length)el.setAttribute('srcset',next.join(', '));
    }

    for(const el of [...d.querySelectorAll('[style]')])el.setAttribute('style',await this.cssRewrite(el.getAttribute('style'),base));

    for(const s of [...d.querySelectorAll('script[src]')]){
      const raw=s.getAttribute('src');
      if(!isLocalRef(raw))continue;
      const p=this.findLocal(base,raw),f=this.files.get(p);
      if(!f)continue;
      const explicitType=(s.getAttribute('type')||'').toLowerCase();
      if(explicitType==='module'){
        const bundle=await this.buildModuleBundle(p);
        const ns=d.createElement('script');
        ns.setAttribute('type','module');
        ns.setAttribute('data-debooger-source',p);
        ns.textContent=safeInlineScript(bundle);
        s.replaceWith(ns);
        continue;
      }
      const ns=d.createElement('script');
      let text=await f.text();
      if(['ts','tsx','jsx'].includes(ext(p)))try{text=this.transpile(text,p)}catch{}
      ns.textContent=safeInlineScript(text);
      for(const a of [...s.attributes])if(a.name!=='src')ns.setAttribute(a.name,a.value);
      ns.setAttribute('data-debooger-source',p);
      s.replaceWith(ns);
    }

    const captureLib=d.createElement('script');
    captureLib.setAttribute('data-debooger-helper','screenshot');
    const helperSource=await getScreenshotHelper();
    if(helperSource)captureLib.textContent=safeInlineScript(helperSource);
    else captureLib.src='https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
    d.body.appendChild(captureLib);

    const origin=typeof location!=='undefined'?location.origin:'*';
    const nav=d.createElement('script');
    nav.textContent=safeInlineScript(buildPreviewRuntime(base,origin));
    d.body.appendChild(nav);

    if(inject)d.head.insertAdjacentHTML('beforeend',inject);
    return '<!doctype html>\n'+d.documentElement.outerHTML;
  }
}
