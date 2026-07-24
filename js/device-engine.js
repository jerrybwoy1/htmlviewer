export const DEVICES={desktop:{label:'Desktop',width:1440,height:900},tablet:{label:'iPad',width:1024,height:1366},mobile:{label:'Mobile',width:390,height:844}};

export function deviceCss(mode){
  if(mode==='desktop')return'';
  const w=DEVICES[mode].width;
  return `<style id="debooger-device-adapt">
html,body{max-width:100%;overflow-x:hidden!important}img,video,canvas,svg{max-width:100%!important;height:auto}table{max-width:100%}iframe{max-width:100%}
@media(max-width:${w}px){
  .debooger-auto-grid,[class*="grid"],[class*="cards"]{grid-template-columns:minmax(0,1fr)!important}
  [class*="sidebar"],[class*="sidenav"]{max-width:min(88vw,320px)}
  [class*="modal"],[role="dialog"]{max-width:calc(100vw - 24px)!important;max-height:calc(100vh - 24px)!important}
  input,select,textarea,button{max-width:100%}
}
</style>`;
}