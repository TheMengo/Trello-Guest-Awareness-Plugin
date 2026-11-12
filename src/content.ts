import {classify} from './classify';
import {dismissalKey} from './preferences';
import type {Snapshot,Warning} from './types';
import * as dom from './dom';
import {host,element,button} from './ui';

type Preferences={enabled:boolean;dismissals:Record<string,string>};
type Attempt={editor:dom.Editor;save:HTMLElement|null;form:HTMLFormElement|null;submitter:HTMLElement|null};
let prefs:Preferences={enabled:true,dismissals:{}};
let snapshot:Snapshot|undefined;
let error='Unable to verify guest status. Checking Trello authorization…';
let contextKey='';
let generation=0;
let lastFetch=0;
let pending=false;
let replaying=false;
let dialogHost:HTMLElement|undefined;
let closeDialog:((restore?:boolean)=>void)|undefined;
let guard:{editor:dom.Editor;draft:string;until:number}|undefined;
let approvedSubmit:{editor:dom.Editor;form:HTMLFormElement;draft:string;generation:number;until:number}|undefined;
let knownEditor:dom.Editor|undefined;
const retiredEditors=new WeakSet<dom.Editor>();
let renderTimer:ReturnType<typeof setTimeout>|undefined;
let retired=false;
const events=new AbortController();
let prefRequest=0;

async function rpc(message:object):Promise<any>{
  try{return await chrome.runtime.sendMessage(message);}catch{return{ok:false,error:'Unable to verify guest status. Reload this Trello tab after reloading the extension.'};}
}
function openSettings(){void rpc({type:'open-settings'});}
async function preferences(){
  const version=++prefRequest;
  const result=await rpc({type:'get-preferences'});
  if(version!==prefRequest)return;
  if(result?.ok){prefs={enabled:result.enabled,dismissals:result.dismissals};}
}
function sameContext(){return JSON.stringify(dom.route(location.pathname))===contextKey;}
function routeChanged(){
  const next=JSON.stringify(dom.route(location.pathname));
  if(next!==contextKey){
    if(knownEditor&&dom.route(location.pathname)?.cardRef)retiredEditors.add(knownEditor);
    contextKey=next;generation++;snapshot=undefined;lastFetch=0;pending=false;guard=undefined;approvedSubmit=undefined;
    closeDialog?.(false);error='Unable to verify guest status. Checking board membership…';
    render();void refresh();
  }
}
async function refresh(force=false){
  const ref=dom.route(location.pathname);
  if(!ref||!prefs.enabled||pending||retired)return;
  pending=true;const version=generation;lastFetch=Date.now();
  const result=await rpc({type:'snapshot',...ref,force});
  if(!sameContext()){routeChanged();return;}
  if(version!==generation)return;
  pending=false;
  if(result?.ok){snapshot=result.snapshot;error='';}
  else{snapshot=undefined;error=result?.error??'Unable to verify guest status.';closeDialog?.();}
  await preferences();
  if(!sameContext()){routeChanged();return;}
  if(version===generation){if(closeDialog)closeDialog();render();}
}
function historical(){const root=dom.cardRoot();return root&&snapshot?dom.previousMentions(root,snapshot.board.members):{memberIds:[],unresolved:false};}
function warning(editor?:dom.Editor):Warning|undefined{
  if(!snapshot)return undefined;
  const history=historical();
  return classify(snapshot,editor?dom.draftText(editor):'',history.memberIds,editor?dom.renderedMentions(editor,snapshot.board.members).memberIds:[]);
}
function mountIndicator(id:string,anchor:HTMLElement|undefined,title:string,messages:string[],guests?:string[]){
  document.getElementById(id)?.remove();
  if(!anchor)return;
  const ui=host(id);const panel=element('div',undefined,'indicator');panel.setAttribute('role','status');
  const row=element('div',undefined,'row');row.append(element('strong',title));
  if(id==='tga-board-indicator')row.append(button('Refresh',()=>{void refresh(true);}),button('Settings',openSettings));
  panel.append(row);
  for(const message of messages)panel.append(element('p',message,'warning-detail'));
  if(guests?.length){
    const details=element('details',undefined,'details');details.append(element('summary','Guest names'));
    const list=element('ul');guests.forEach(name=>list.append(element('li',name)));details.append(list);panel.append(details);
  }
  ui.root.append(panel);anchor.insertAdjacentElement('afterend',ui.host);
}
let renderSignature='';
function render(){
  if(retired)return;
  if(!sameContext()){routeChanged();return;}
  const ref=dom.route(location.pathname);
  const header=document.querySelector<HTMLElement>(dom.BOARD_HEADER);
  const root=dom.cardRoot();
  const first=root?dom.editors(root)[0]:undefined;
  const staleEditor=!!first&&retiredEditors.has(first);
  const w=warning(staleEditor?undefined:first);
  const adapterUnsupported=!!(ref?.cardRef&&root&&((!first&&!dom.editorCollapsed(root))||staleEditor||(first&&!dom.saveFor(first))));
  const unresolvedHistory=historical().unresolved;
  knownEditor=first;
  const signature=JSON.stringify({contextKey,prefs:prefs.enabled,error,w,adapterUnsupported,unresolvedHistory,theme:document.documentElement.dataset.colorMode??document.documentElement.dataset.theme,header:!!header,root:!!root});
  const wantsBoard=!!(ref&&prefs.enabled&&(error||w?.guests.length));
  const wantsCard=!!(ref?.cardRef&&root&&prefs.enabled&&w?.guests.length&&(w.specific||adapterUnsupported||unresolvedHistory));
  const boardMissing=wantsBoard&&!!header&&!document.getElementById('tga-board-indicator');
  const cardMissing=wantsCard&&!document.getElementById('tga-card-indicator');
  if(signature===renderSignature&&!boardMissing&&!cardMissing)return;
  renderSignature=signature;
  document.getElementById('tga-board-indicator')?.remove();document.getElementById('tga-card-indicator')?.remove();
  if(!ref||!prefs.enabled)return;
  const boardAnchor=header??(ref.cardRef?(root?dom.cardHeading(root):undefined)??undefined:undefined);
  if(error){mountIndicator('tga-board-indicator',boardAnchor,'Unable to verify guest status',[error]);return;}
  if(!w?.guests.length)return;
  mountIndicator('tga-board-indicator',boardAnchor,`This board has ${w.guests.length} ${w.guests.length===1?'guest':'guests'}.`,['Guests can view cards, comments, and attachments on this board. A guest is outside this board’s Trello Workspace membership.'],w.guests.map(m=>m.fullName||'@'+m.username));
  if(ref.cardRef&&root&&(w.specific||adapterUnsupported||unresolvedHistory)){
    const anchor=dom.cardHeading(root)??first?.closest<HTMLElement>('form, .comment-box, [data-testid="card-comment-form"], [data-testid="card-back-new-comment"], [data-testid="card-back-comment-editor-container"]');
    const messages=staleEditor?[]:w.messages.slice(1);
    if(unresolvedHistory)messages.push('A rendered mention could not be matched to a verified board member. Guest involvement from that mention is unverified.');
    if(adapterUnsupported)messages.push('Comment controls are not recognized. Pre-post confirmation is unavailable in this editor; review guest access before using Trello’s controls.');
    mountIndicator('tga-card-indicator',anchor??undefined,'Guest awareness on this card',messages);
  }
}
function scheduleRender(){if(renderTimer)return;renderTimer=setTimeout(()=>{renderTimer=undefined;routeChanged();render();},80);}
function stop(event:Event){event.preventDefault();event.stopImmediatePropagation();}
function intercept(event:Event,attempt:Attempt){
  if(!prefs.enabled||retired)return;
  if(event.type==='submit'&&approvedSubmit&&approvedSubmit.editor===attempt.editor&&approvedSubmit.form===attempt.form&&approvedSubmit.generation===generation&&Date.now()<approvedSubmit.until&&dom.text(attempt.editor)===approvedSubmit.draft){approvedSubmit=undefined;return;}
  if(replaying&&event.type!=='submit')return;
  // Never use information from a previous route, an old card DOM, or a stale request.
  if(!sameContext()){routeChanged();return;}
  if(!dom.route(location.pathname)?.cardRef||retiredEditors.has(attempt.editor)||!dom.visible(attempt.editor)||!dom.cardRoot()?.contains(attempt.editor))return;
  const raw=dom.text(attempt.editor);if(!raw.trim())return;
  if(guard?.editor===attempt.editor&&guard.draft===raw&&Date.now()<guard.until){stop(event);return;}
  if(dialogHost){stop(event);return;}
  if(!snapshot||Date.now()-snapshot.fetchedAt>120_000){void refresh(true);return;}
  const w=warning(attempt.editor);if(!w?.guests.length)return;
  if(prefs.dismissals[dismissalKey(w.scope,w.scopeId)]===w.fingerprint)return;
  stop(event);confirm(w,attempt,raw);
}
function confirm(w:Warning,attempt:Attempt,rawDraft:string){
  const currentGeneration=generation;
  const ui=host('tga-confirmation');dialogHost=ui.host;
  const dialog=element('dialog');dialog.setAttribute('aria-labelledby','tga-title');dialog.setAttribute('aria-describedby','tga-description');
  const header=element('header');header.append(element('h2','Workspace Guest Warning'));header.querySelector('h2')!.id='tga-title';
  header.append(element('p',w.specific?'Guest involvement on this card':'Guests have access to this board'));
  const content=element('div',undefined,'content');const description=element('div');description.id='tga-description';
  description.append(element('p',`This board has ${w.guests.length} Workspace ${w.guests.length===1?'guest':'guests'} who can view your comment.`));
  w.messages.slice(1).forEach(message=>description.append(element('p',message)));
  description.append(element('p','Please review your comment before posting.'));content.append(description);
  const label=element('label');const checkbox=element('input');checkbox.type='checkbox';label.append(checkbox,element('span',`Do not show again for this ${w.scope}`));content.append(label);
  const status=element('p','', 'subtle');status.setAttribute('role','status');content.append(status);
  const footer=element('footer');let accepted=false;
  const close=(restore=true)=>{
    if(dialog.open)dialog.close();ui.host.remove();dialogHost=undefined;closeDialog=undefined;
    if(restore&&attempt.editor.isConnected)attempt.editor.focus();
  };
  closeDialog=close;
  const cancel=button('Cancel',()=>close(),'secondary');
  const proceed=button('Post Anyway',()=>{
    if(accepted)return;accepted=true;proceed.disabled=true;cancel.disabled=true;
    // Revalidate immediately before invoking Trello; never transfer a draft or replay on another card.
    if(currentGeneration!==generation||!sameContext()||!dom.visible(attempt.editor)||!dom.cardRoot()?.contains(attempt.editor)||(attempt.save&&!dom.visible(attempt.save))||dom.text(attempt.editor)!==rawDraft||!prefs.enabled){close();return;}
    const current=warning(attempt.editor);
    if(!current||current.fingerprint!==w.fingerprint){close();return;}
    if(checkbox.checked){
      prefs.dismissals[dismissalKey(w.scope,w.scopeId)]=w.fingerprint;
      void rpc({type:'dismiss',scope:w.scope,scopeId:w.scopeId,boardId:snapshot!.board.id,fingerprint:w.fingerprint}).then(result=>{
        if(!result?.ok){delete prefs.dismissals[dismissalKey(w.scope,w.scopeId)];}
      });
    }
    close(false);
    guard={editor:attempt.editor,draft:rawDraft,until:Date.now()+1200};
    approvedSubmit=attempt.form?{editor:attempt.editor,form:attempt.form,draft:rawDraft,generation,until:Date.now()+1200}:undefined;
    const thisGuard=guard;
    setTimeout(()=>{if(guard===thisGuard)guard=undefined;if(approvedSubmit&&Date.now()>=approvedSubmit.until)approvedSubmit=undefined;},1250);
    replaying=true;
    try{
      if(attempt.save?.isConnected&&!(attempt.save as HTMLButtonElement).disabled)attempt.save.click();
      else if(attempt.form?.isConnected)attempt.form.requestSubmit(attempt.submitter instanceof HTMLButtonElement||attempt.submitter instanceof HTMLInputElement?attempt.submitter:undefined);
    }catch{
      // Leave the untouched draft with Trello if its native control is no longer available.
      guard=undefined;approvedSubmit=undefined;
    }finally{replaying=false;if(attempt.editor.isConnected)attempt.editor.focus();}
  },'primary');
  footer.append(cancel,proceed);dialog.append(header,content,footer);ui.root.append(dialog);(dom.cardRoot()??document.body).append(ui.host);
  // Keep modal interactions out of Trello’s delegated shortcuts and outside-click handlers.
  for(const eventType of ['click','pointerdown','mousedown','keydown','keyup'])ui.root.addEventListener(eventType,event=>event.stopPropagation());
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  dialog.addEventListener('keydown',event=>{
    if(event.key!=='Tab')return;
    const focusable=[checkbox,cancel,proceed].filter(e=>!e.disabled);
    if(event.shiftKey&&ui.root.activeElement===focusable[0]){event.preventDefault();focusable.at(-1)!.focus();}
    else if(!event.shiftKey&&ui.root.activeElement===focusable.at(-1)){event.preventDefault();focusable[0].focus();}
  });
  dialog.showModal();cancel.focus();
}
function click(event:MouseEvent){
  if(!(event.target instanceof Element)||replaying)return;
  const save=event.target.closest<HTMLElement>(dom.SAVE);if(!save||!dom.visible(save)||(save as HTMLButtonElement).disabled)return;
  const editor=dom.editorFor(save);if(editor)intercept(event,{editor,save,form:save.closest('form'),submitter:save});
}
function keyboard(event:KeyboardEvent){
  if(event.key!=='Enter'||!(event.ctrlKey||event.metaKey)||event.shiftKey||event.altKey||event.isComposing||!(event.target instanceof Element))return;
  const editor=dom.editorFor(event.target);if(!editor||!(event.target===editor||editor.contains(event.target)))return;
  const save=dom.saveFor(editor);if(!save||(save as HTMLButtonElement).disabled)return;
  intercept(event,{editor,save,form:editor.closest('form'),submitter:save});
}
function submit(event:SubmitEvent){
  if(!(event.target instanceof HTMLFormElement))return;
  const editor=dom.editors(event.target)[0];if(!editor)return;
  intercept(event,{editor,save:dom.saveFor(editor),form:event.target,submitter:event.submitter});
}
function input(){if(guard&&dom.text(guard.editor)!==guard.draft)guard=undefined;scheduleRender();}
function retire(){
  retired=true;events.abort();chrome.runtime.onMessage.removeListener(onPreferencesChanged);closeDialog?.(false);observer.disconnect();clearInterval(routeClock);clearInterval(refreshClock);
  if(renderTimer)clearTimeout(renderTimer);
  document.removeEventListener('click',click,true);document.removeEventListener('keydown',keyboard,true);document.removeEventListener('submit',submit,true);document.removeEventListener('input',input,true);
  document.getElementById('tga-board-indicator')?.remove();document.getElementById('tga-card-indicator')?.remove();
}
// A re-injected copy retires the old isolated-world instance before registering listeners.
document.dispatchEvent(new CustomEvent('tga-retire'));
document.addEventListener('tga-retire',retire,{once:true,signal:events.signal});
document.addEventListener('click',click,{capture:true,signal:events.signal});document.addEventListener('keydown',keyboard,{capture:true,signal:events.signal});document.addEventListener('submit',submit,{capture:true,signal:events.signal});document.addEventListener('input',input,{capture:true,signal:events.signal});
window.addEventListener('popstate',routeChanged,{signal:events.signal});window.addEventListener('hashchange',routeChanged,{signal:events.signal});
window.addEventListener('focus',()=>{if(Date.now()-lastFetch>30_000)void refresh(true);},{signal:events.signal});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&Date.now()-lastFetch>30_000)void refresh(true);},{signal:events.signal});
const observer=new MutationObserver(records=>{
  if(records.some(record=>!(record.target instanceof Element)||!record.target.closest('[data-tga]')))scheduleRender();
});
observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['data-color-mode','data-theme']});
const routeClock=setInterval(routeChanged,500);
const refreshClock=setInterval(()=>{if(!document.hidden&&Date.now()-lastFetch>=60_000)void refresh();},30_000);
function onPreferencesChanged(message:any){
  if(message?.type==='preferences-changed'){
    if(message.credentialsChanged){snapshot=undefined;generation++;pending=false;closeDialog?.();error='Unable to verify guest status. Authorization changed; checking membership…';render();}
    void preferences().then(()=>{if(retired)return;if(!prefs.enabled){closeDialog?.();render();}else{render();void refresh(true);}});
  }
}
chrome.runtime.onMessage.addListener(onPreferencesChanged);
void preferences().then(()=>{routeChanged();render();});
