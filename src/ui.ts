export const css = `
:host{--bg:#fff7d6;--ink:#423500;--border:#e9bf44;--surface:#fff;--body:#172b4d;--muted:#44546f;--accent:#0c66e4;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--body);color-scheme:light dark;display:block;box-sizing:border-box}
@media(prefers-color-scheme:dark){:host{--bg:#332e1b;--ink:#f5d47d;--border:#a58b43;--surface:#22272b;--body:#dee4ea;--muted:#b6c2cf;--accent:#579dff}}
:host([data-theme=light]){--bg:#fff7d6;--ink:#423500;--border:#e9bf44;--surface:#fff;--body:#172b4d;--muted:#44546f;--accent:#0c66e4}\n:host([data-theme=dark]){--bg:#332e1b;--ink:#f5d47d;--border:#a58b43;--surface:#22272b;--body:#dee4ea;--muted:#b6c2cf;--accent:#579dff}
*{box-sizing:border-box}button,a{font:inherit}button{cursor:pointer;border:1px solid transparent;border-radius:5px;padding:6px 10px;background:transparent;color:inherit;font-weight:600}button:hover{background:#8882}button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid var(--accent);outline-offset:3px}button:disabled{cursor:default;opacity:.6}a{color:var(--accent)}p{margin:0 0 8px}p:last-child{margin:0}.indicator{border:1px solid var(--border);border-radius:7px;background:var(--bg);color:var(--ink);padding:8px 12px;margin:6px 0;max-width:100%;overflow-wrap:anywhere}.row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.row strong{flex:1;min-width:160px}.details{margin-top:6px}summary{cursor:pointer}ul{padding-left:20px;margin:6px 0}.subtle{color:var(--muted);font-size:12px}.warning-detail{margin-top:5px}dialog{padding:0;border:1px solid var(--border);border-radius:12px;background:var(--surface);color:var(--body);width:min(480px,calc(100vw - 32px));max-height:calc(100dvh - 32px);overflow:auto;box-shadow:0 16px 56px #0005}dialog::backdrop{background:#091e4277}header{padding:22px 24px 12px;background:var(--bg);color:var(--ink);border-bottom:1px solid var(--border)}h2{font-size:19px;line-height:1.3;margin:0 0 5px}.content{padding:20px 24px}.content p{margin-bottom:12px}label{display:flex;gap:10px;align-items:flex-start;margin-top:18px}input{accent-color:var(--accent);width:17px;height:17px;flex-shrink:0;margin:2px 0}footer{display:flex;justify-content:flex-end;gap:8px;padding:0 24px 22px}.primary{background:#0c66e4;color:#fff}.primary:hover{background:#0055cc}.secondary{background:#8882}.error{color:#b42318} @media(prefers-reduced-motion:no-preference){dialog[open]{animation:appear .12s ease-out}@keyframes appear{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}}
`;
export function element<K extends keyof HTMLElementTagNameMap>(tag:K,content?:string,className?:string):HTMLElementTagNameMap[K]{
  const node=document.createElement(tag);if(content!==undefined)node.textContent=content;if(className)node.className=className;return node;
}
export function host(id:string):{host:HTMLElement;root:ShadowRoot}{
  const h=element('div');h.id=id;h.dataset.tga='';
  const theme=document.documentElement.dataset.colorMode ?? document.documentElement.dataset.theme;
  if(theme?.includes('dark'))h.dataset.theme='dark';
  else if(theme?.includes('light'))h.dataset.theme='light';
  const root=h.attachShadow({mode:'open'});root.append(element('style',css));return{host:h,root};
}
export function button(label:string,action:()=>void,className?:string):HTMLButtonElement{
  const b=element('button',label,className);b.type='button';b.addEventListener('click',action);return b;
}
