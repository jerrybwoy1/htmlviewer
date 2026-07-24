export const DEVICES={desktop:{label:'Desktop',width:1440,height:900},tablet:{label:'iPad',width:1024,height:1366},mobile:{label:'Mobile',width:390,height:844}};

export function deviceCss(mode){
  if(mode==='desktop')return'';
  const w=DEVICES[mode].width;
  return `<style id="debooger-device-adapt">
html body{max-width:100%;overflow-x:hidden}
html body img,html body video,html body canvas,html body svg{max-width:100%;height:auto}
html body table,html body iframe{max-width:100%}
@media(max-width:${w}px){
  html body .debooger-auto-grid,html body [class*="grid"],html body [class*="cards"]{grid-template-columns:minmax(0,1fr)}
  html body [class*="sidebar"],html body [class*="sidenav"]{max-width:min(88vw,320px)}
  html body [class*="modal"],html body [role="dialog"]{max-width:calc(100vw - 24px);max-height:calc(100vh - 24px)}
  html body input,html body select,html body textarea,html body button{max-width:100%}
}
</style>`;
}
