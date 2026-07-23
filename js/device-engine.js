export const DEVICES={desktop:{label:'Desktop',width:1440,height:900},tablet:{label:'iPad',width:1024,height:1366},mobile:{label:'Mobile',width:390,height:844}};
export function deviceCss(mode){if(mode==='desktop')return'';const w=DEVICES[mode].width;return `
<style id="debooger-device-adapt">
html,body{max-width:100%;overflow-x:hidden!important}img,video,canvas,svg{max-width:100%!important;height:auto}table{max-width:100%}iframe{max-width:100%}
@media(max-width:${w}px){
  .debooger-auto-grid,[class*="grid"],[class*="cards"]{grid-template-columns:minmax(0,1fr)!important}
  [class*="sidebar"],[class*="sidenav"]{max-width:min(88vw,320px)}
  [class*="modal"],[role="dialog"]{max-width:calc(100vw - 24px)!important;max-height:calc(100vh - 24px)!important}
  input,select,textarea,button{max-width:100%}
}
</style>`}
export function scoreDeviceReadiness(doc){if(!doc)return{score:0,issues:['Preview is not available yet.']};const issues=[];const root=doc.documentElement;const overflow=Math.max(root.scrollWidth,doc.body?.scrollWidth||0)-root.clientWidth;if(overflow>4)issues.push(`The page is about ${Math.round(overflow)} pixels wider than the screen, so some content may be cut off.`);const tiny=[...doc.querySelectorAll('body *')].filter(el=>{const s=getComputedStyle(el);const n=parseFloat(s.fontSize);return n>0&&n<11&&el.textContent?.trim()}).length;if(tiny)issues.push(`${tiny} text areas are very small and may be hard to read.`);const fixed=[...doc.querySelectorAll('body *')].filter(el=>getComputedStyle(el).position==='fixed').length;if(fixed>8)issues.push(`There are ${fixed} fixed-position items. On a small screen they may overlap.`);return{score:Math.max(0,100-issues.length*18),issues};}
