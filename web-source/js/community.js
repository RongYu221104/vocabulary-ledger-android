(function(){
 'use strict';
 // Profile & community: one dialog with three leaves — 我的资料 (edit, explicit save), 公开主页 (live preview of the
 // draft as others would see it) and 社区 (search → public profile → public ledger → independent copy).
 // Every request, payload and permission rule is unchanged from phase one; this file only shapes how it feels.
 const $=id=>document.getElementById(id),Av=window.LedgerAvatars,Groups=window.LedgerGroups;
 const dialog=$('community-dialog'),body=$('community-body'),status=$('community-status'),foot=$('community-foot');
 const title=$('community-title'),kicker=$('community-kicker'),tabBar=$('community-tabs'),closeButton=$('community-close');
 const tabs=[...tabBar.querySelectorAll('[role=tab]')];
 const TITLES={profile:['Profile','我的资料'],preview:['As others see you','我的公开主页'],community:['Commons','公开社区']};
 const NICK=/^[\p{L}\p{N}\p{M} ._-]+$/u,MAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/u,PAGE=60;
 let identity=null,generation=0,returnFocus=null,busy=false,dirty=false,controllers=new Set(),groups=new Map();
 let profileName='',avatarKnown=null,tab='profile',panes={},state=null,form=null;
 const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
 const say=(message,error=false)=>{status.textContent=message;status.classList.toggle('error-text',error);};
 function button(text,cls,fn,id){const n=el('button',text,cls);n.type='button';if(id)n.id=id;if(fn)n.addEventListener('click',fn);return n;}
 function art(id){const t=$(id);return t?t.content.firstElementChild.cloneNode(true):el('span');}
 function enter(node){node.classList.remove('is-entering');void node.offsetWidth;node.classList.add('is-entering');}
 function invalidate(){generation++;if(state?.community){clearTimeout(state.community.timer);state.community.searchToken++;state.community.token++;}for(const c of controllers)c.abort();controllers.clear();groups.clear();busy=false;dialog.setAttribute('aria-busy','false');}
 function abortGroup(name){for(const c of groups.get(name)||[])c.abort();groups.delete(name);}
 async function api(path,payload,group){
  const g=generation,key=identity?.key,c=new AbortController();controllers.add(c);
  if(group){if(!groups.has(group))groups.set(group,new Set());groups.get(group).add(c);}
  const timer=setTimeout(()=>c.abort(),45000);
  try{
   const r=await fetch(path,{method:payload?'POST':'GET',credentials:'same-origin',cache:'no-store',signal:c.signal,headers:{'X-Ledger-Session':key||'',...(payload?{'Content-Type':'application/json','X-Ledger-Request':'1'}:{})},body:payload?JSON.stringify(payload):undefined});
   const v=await r.json().catch(()=>({error:'云端返回异常，请重新读取。'}));
   if(g!==generation||key!==identity?.key)throw Object.assign(Error('面板或账号已变化，请重新打开。'),{stale:true});
   if(!r.ok){if(v.code==='auth')window.dispatchEvent(new CustomEvent('ledger-sharing-auth',{detail:key}));throw Object.assign(Error(v.error||'操作未完成。'),{code:v.code});}return v;
  }catch(e){if(g!==generation)e.stale=true;throw e;}
  finally{clearTimeout(timer);controllers.delete(c);groups.get(group)?.delete(c);}
 }
 // Network failures surface as AbortError (timeout) or TypeError (offline); neither message is fit to show as is.
 const errorText=(e,write)=>e.name==='AbortError'||e.name==='TypeError'?(write?'连接中断，结果尚未确认，请重新读取核对。':'连不上云端，检查网络后再试一次。'):e.message;
 function loading(box,text){const n=el('div',undefined,'cm-loading'),dots=el('span',undefined,'cm-dots');n.setAttribute('role','status');dots.setAttribute('aria-hidden','true');dots.append(el('i'),el('i'),el('i'));n.append(dots,el('span',text));box.replaceChildren(n);}
 function failure(box,text,retry){const n=el('div',undefined,'cm-error');n.setAttribute('role','alert');n.append(el('p',text),button('再试一次','quiet',retry));box.replaceChildren(n);}
 // Example bold uses paired **…** markers (as in the ledger); an unpaired trailing marker stays literal.
 function rich(node,raw){const parts=raw.split('**');if(parts.length%2===0){const last=parts.pop();parts[parts.length-1]+='**'+last;}parts.forEach((s,i)=>{if(s)node.append(i%2?el('strong',s):document.createTextNode(s));});return node;}

 /* ---------- Header: the nickname is the way in ---------- */
 function rememberAvatar(n){avatarKnown=Av.valid(n)?n:null;}
 function decorateHeader(){
  const b=$('account-name');if(!identity){b.querySelector('.account-avatar')?.remove();return;}
  const name=profileName||b.textContent.trim(),face=el('span',undefined,'account-avatar');face.append(Av.render(avatarKnown));
  b.replaceChildren(face,el('span',name,'account-label'));b.title=name+' · 个人资料与社区';
 }

 /* ---------- Dialog frame ---------- */
 function setTitle(which){const [k,h]=TITLES[which]||['Profile & Commons','资料与社区'];kicker.textContent=k;title.textContent=h;}
 function open(which){
  if(!dialog.open){returnFocus=document.activeElement;invalidate();dirty=false;state={profile:null,profileTask:null,community:null};panes={};form=null;body.replaceChildren();foot.replaceChildren();foot.hidden=true;say('');resetClose();dialog.showModal();}
  if(!identity)return showGuest();
  tabBar.hidden=false;select(which);
  if(which==='community')$('community-query')?.focus();else tabs.find(t=>t.dataset.tab===which).focus();
 }
 function showGuest(){
  tabBar.hidden=true;foot.hidden=true;setTitle('guest');
  const n=el('div',undefined,'cm-guest cm-pane');n.append(art('art-commons'),el('h3','先登录，再相见','cm-state-title'),el('p','登录后可编辑个人资料、按昵称找到同路人，翻阅并复制他们公开的账本。游客词条仍只留在当前页面。','cm-state-text'));
  n.append(button('通过 ChatGPT 登录','primary',()=>{dialog.close();$('sign-in').click();}));body.replaceChildren(n);enter(n);closeButton.focus();
 }
 function select(which){
  tab=which;setTitle(which);if(!busy)say('');
  for(const t of tabs){const on=t.dataset.tab===which;t.setAttribute('aria-selected',String(on));t.tabIndex=on?0:-1;}
  body.setAttribute('aria-labelledby',tabs.find(t=>t.dataset.tab===which).id);
  if(!panes[which]){panes[which]=el('div',undefined,'cm-pane');panes[which].id='pane-'+which;body.append(panes[which]);}
  for(const [name,p] of Object.entries(panes))p.hidden=name!==which;
  foot.hidden=which!=='profile'||!form;enter(panes[which]);
  if(which==='profile')showProfile();else if(which==='preview')showPreview();else showCommunity();
  body.scrollTop=0;
 }
 tabs.forEach(t=>t.addEventListener('click',()=>{if(t.getAttribute('aria-selected')!=='true')select(t.dataset.tab);}));
 tabBar.addEventListener('keydown',e=>{const i=tabs.indexOf(document.activeElement);if(i<0)return;const j={ArrowRight:(i+1)%tabs.length,ArrowLeft:(i+tabs.length-1)%tabs.length,Home:0,End:tabs.length-1}[e.key];if(j===undefined)return;e.preventDefault();tabs[j].focus();select(tabs[j].dataset.tab);});
 function resetClose(){closeButton.textContent='关闭';delete closeButton.dataset.armed;}
 function close(){
  if(busy){say('正在写入云端，请等它完成。');return;}
  if(dirty&&!closeButton.dataset.armed){closeButton.dataset.armed='1';closeButton.textContent='放弃修改并关闭';say('资料还有修改没保存：可以继续编辑，或再点一次放弃。');return;}
  dialog.close();
 }

 /* ---------- 我的资料 ---------- */
 const snap=(p,ids)=>({nickname:p.nickname,contactEmail:p.contactEmail,goal:p.goal,avatar:p.avatar,discoverable:p.discoverable,booksVisible:p.booksVisible,copyAllowed:p.copyAllowed,emailPublic:p.emailPublic,goalPublic:p.goalPublic,published:[...ids].sort()});
 function ensureProfile(){
  const ownerState=state;
  if(!ownerState.profileTask)ownerState.profileTask=api('/api/profile').then(v=>{ownerState.profile={v,version:v.profile.version,saved:snap(v.profile,v.publishedIds)};return ownerState.profile;},e=>{if(state===ownerState)ownerState.profileTask=null;throw e;});
  return ownerState.profileTask;
 }
 async function showProfile(){
  const pane=panes.profile;if(pane.dataset.ready)return;
  if(!pane.firstChild)loading(pane,'正在取出你的资料…');
  try{const P=await ensureProfile();if(!pane.isConnected||pane.dataset.ready)return;buildProfile(pane,P);if(tab==='profile')foot.hidden=false;}
  catch(e){if(e.stale||!pane.isConnected)return;failure(pane,errorText(e),()=>{loading(pane,'正在取出你的资料…');showProfile();});}
 }
 function switchInput(id,checked){const n=el('input',undefined,'pf-switch');n.type='checkbox';n.id=id;n.checked=checked;n.setAttribute('role','switch');return n;}
 function knot(){const s=document.createElementNS('http://www.w3.org/2000/svg','svg');s.setAttribute('viewBox','0 0 20 20');s.setAttribute('class','pf-knot');s.setAttribute('aria-hidden','true');
  for(const [cls,d] of [['pf-knot-fill','M10.6 4.6c3.2-.1 5.6 2.4 5.4 5.6-.2 3-2.8 5.4-5.8 5.2-3-.2-5.2-2.6-5-5.6.2-2.8 2.6-5.1 5.4-5.2z'],['pf-knot-ring','M9.6 3.4c3.6-.2 6.4 2.6 6.2 6.2-.2 3.4-3 6-6.4 5.8-3.4-.2-6-3-5.8-6.4.2-3.1 2.9-5.5 6-5.6z']]){const p=document.createElementNS('http://www.w3.org/2000/svg','path');p.setAttribute('class',cls);p.setAttribute('d',d);s.append(p);}return s;}
 function step(key,name){
  const row=el('div',undefined,'pf-step'),text=el('div',undefined,'pf-step-text'),label=el('label',name,'pf-step-name'),desc=el('p','','pf-step-desc'),input=switchInput('profile-'+key,false);
  row.dataset.step=key;label.htmlFor=input.id;desc.id=input.id+'-desc';input.setAttribute('aria-describedby',desc.id);
  text.append(label,desc);row.append(knot(),text,input);return {row,input,desc};
 }
 // Ledger names follow the existing 主账本 YY-MM / 子账本 set × type mapping; anything else is a custom ledger.
 function grouped(list){
  const masters=new Map(),customs=[];
  for(const t of list){const x=Groups?.parse(t.name);if(!x){customs.push({t,label:t.name});continue;}if(!masters.has(x.key))masters.set(x.key,{title:Groups.masterTitle(x.key),items:[]});masters.get(x.key).items.push({t,label:'第 '+x.set+' 套 · '+x.type,order:x.set*10+Groups.TYPES.indexOf(x.type)});}
  const out=[...masters.entries()].sort((a,b)=>b[0].localeCompare(a[0])).map(([,m])=>({title:m.title,items:m.items.sort((a,b)=>a.order-b.order)}));
  if(customs.length)out.push({title:out.length?'自定义账本':'',items:customs});return out;
 }
 function buildProfile(pane,P){
  const p=P.v.profile;profileName=p.nickname;rememberAvatar(p.avatar);decorateHeader();
  form=el('form',undefined,'pf');form.id='profile-form';form.noValidate=true;
  // Who: portrait, nickname, avatar shelf.
  const who=el('section',undefined,'pf-who'),portrait=el('span',undefined,'pf-portrait'),idText=el('div',undefined,'pf-who-text');
  portrait.append(Av.render(p.avatar));
  const nickLabel=el('label','昵称','pf-label'),nick=el('input',undefined,'pf-nickname'),nickNote=el('p','','pf-note');
  Object.assign(nick,{id:'profile-nickname',value:p.nickname,maxLength:40,autocomplete:'nickname',spellcheck:false});nickLabel.htmlFor=nick.id;nickNote.id='profile-nickname-note';nick.setAttribute('aria-describedby',nickNote.id);
  idText.append(nickLabel,nick,nickNote);who.append(portrait,idText);
  const shelf=el('fieldset',undefined,'pf-avatars'),legend=el('legend',undefined,'pf-label'),avatarName=el('span','','pf-avatar-name'),grid=el('div',undefined,'pf-avatar-grid pf-avatar-quick');
  shelf.id='profile-avatar';grid.id='profile-avatar-grid';legend.append('头像',avatarName);
  // A hundred marks. The first ten (the original set) stay on the shelf as quick picks; the other ninety sit behind
  // 更多头像 and are drawn only the first time it opens, in a short scrolling drawer of themed rows with a jump bar.
  // All radios share one name, so arrow keys run from the quick row straight into the drawer while it is open. Until the
  // drawer is built a saved mark above ten has no radio; the draft keeps it in picked and the toggle shows it.
  const QUICK=Math.min(10,Av.count),sets=(Av.themes||[]).filter(t=>t[1]>QUICK);let picked=Av.valid(p.avatar)?p.avatar:1,built=false,closing=0,spyFrame=0,jumping=0;
  function option(n){const o=el('label',undefined,'pf-avatar-opt'),r=el('input',undefined,'pf-avatar-input');Object.assign(r,{type:'radio',name:'profile-avatar',value:String(n),id:'profile-avatar-'+n,checked:n===picked});o.title=n+' · '+Av.names[n-1];o.append(r,Av.render(n),el('span',n+' · '+Av.names[n-1],'sr-only'));return o;}
  for(let n=1;n<=QUICK;n++)grid.append(option(n));
  const more=button('','quiet pf-avatar-more',()=>setMore(more.getAttribute('aria-expanded')!=='true'),'profile-avatar-more'),moreLabel=el('span','更多头像','pf-avatar-more-label'),now=el('span',undefined,'pf-avatar-now');
  const drawer=el('div',undefined,'pf-avatar-drawer'),inner=el('div',undefined,'pf-avatar-drawer-inner'),jump=el('div',undefined,'pf-avatar-jump'),scroller=el('div',undefined,'pf-avatar-scroll');
  drawer.id='profile-avatar-drawer';drawer.hidden=true;drawer.append(inner);more.setAttribute('aria-controls',drawer.id);more.setAttribute('aria-expanded','false');
  more.append(chevron(),moreLabel,el('span',String(Av.count-QUICK),'pf-avatar-more-count num'),now);
  jump.setAttribute('role','toolbar');jump.setAttribute('aria-label','按主题跳到');
  const still=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
  function showNow(){const show=picked>QUICK&&more.getAttribute('aria-expanded')!=='true';now.hidden=!show;if(show&&now.dataset.n!==String(picked)){now.dataset.n=String(picked);now.replaceChildren(Av.render(picked),el('span','当前 · '+Av.label(picked)));}}
  function mark(i){jump.querySelectorAll('button').forEach((b,k)=>{if(k===i&&!b.classList.contains('is-current')&&jump.scrollWidth>jump.clientWidth)jump.scrollTo({left:b.offsetLeft-(jump.clientWidth-b.offsetWidth)/2,behavior:still()?'auto':'smooth'});b.classList.toggle('is-current',k===i);});}
  function spy(){if(jumping)return;cancelAnimationFrame(spyFrame);spyFrame=requestAnimationFrame(()=>{const top=scroller.scrollTop+12;let i=0;scroller.querySelectorAll('.pf-avatar-set').forEach((sec,k)=>{if(sec.offsetTop<=top)i=k;});if(scroller.scrollTop+scroller.clientHeight>=scroller.scrollHeight-2)i=sets.length-1;mark(i);});}
  function jumpTo(i,focus){const sec=scroller.querySelectorAll('.pf-avatar-set')[i];if(!sec)return;clearTimeout(jumping);jumping=setTimeout(()=>{jumping=0;},still()?50:700);scroller.scrollTo({top:sec.offsetTop,behavior:still()?'auto':'smooth'});mark(i);if(focus)(sec.querySelector('input:checked')||sec.querySelector('input')).focus({preventScroll:true});}
  // The jump bar is one tab stop (roving tabindex); a jump moves focus onto that row, where Space picks and arrows browse.
  function build(){
   if(built)return;built=true;
   sets.forEach(([name,first],i)=>{const last=(sets[i+1]?.[1]||Av.count+1)-1,sec=el('section',undefined,'pf-avatar-set'),cap=el('p',name,'pf-avatar-theme'),g=el('div',undefined,'pf-avatar-grid');
    cap.setAttribute('aria-hidden','true');for(let n=first;n<=last;n++){const o=option(n);o.style.setProperty('--i',String(n-first));g.append(o);}sec.append(cap,g);scroller.append(sec);
    const b=button(name,'quiet pf-avatar-jump-btn',()=>jumpTo(i,true));b.tabIndex=i?-1:0;jump.append(b);});
   jump.addEventListener('keydown',e=>{const bs=[...jump.querySelectorAll('button')],k=bs.indexOf(document.activeElement),to={ArrowRight:k+1,ArrowLeft:k-1,Home:0,End:bs.length-1}[e.key];if(to===undefined||k<0)return;e.preventDefault();const b=bs[(to+bs.length)%bs.length];bs.forEach(x=>x.tabIndex=x===b?0:-1);b.focus();});
   scroller.addEventListener('scroll',spy,{passive:true});inner.append(jump,scroller);
  }
  function setMore(open){
   clearTimeout(closing);more.setAttribute('aria-expanded',String(open));moreLabel.textContent=open?'收起更多头像':'更多头像';showNow();
   if(open){
    const fresh=!built;build();drawer.hidden=false;drawer.classList.toggle('is-fresh',fresh&&!still());void drawer.offsetHeight;drawer.classList.add('is-open');
    // Land on the row holding the current mark, so a saved pick above ten is in view the moment the drawer opens.
    const at=scroller.querySelector('input:checked')?.closest('.pf-avatar-set'),i=at?[...scroller.children].indexOf(at):0;clearTimeout(jumping);jumping=setTimeout(()=>{jumping=0;},100);scroller.scrollTop=at?at.offsetTop:0;mark(i);
   }else{
    if(drawer.contains(document.activeElement))more.focus({preventScroll:true});drawer.classList.remove('is-open','is-fresh');
    closing=setTimeout(()=>{if(more.getAttribute('aria-expanded')==='false')drawer.hidden=true;},still()?0:260);
   }
  }
  showNow();shelf.append(legend,grid);if(Av.count>QUICK)shelf.append(more,drawer);
  // About: two optional lines, each with its own small public switch.
  const about=el('section',undefined,'pf-about');
  function line(labelText,input,switchId,on,noteText){const wrap=el('div',undefined,'pf-field'),head=el('div',undefined,'pf-field-head'),l=el('label',labelText,'pf-label'),sw=el('label',undefined,'pf-inline-switch'),t=switchInput(switchId,on),note=el('p',noteText,'pf-note');l.htmlFor=input.id;note.id=input.id+'-note';input.setAttribute('aria-describedby',note.id);sw.append(el('span','公开'),t);head.append(l,sw);wrap.append(head,input,note);about.append(wrap);return {toggle:t,note};}
  const email=el('input',undefined,'pf-input');Object.assign(email,{id:'profile-email',type:'email',value:p.contactEmail,maxLength:254,autocomplete:'email',inputMode:'email',spellcheck:false,placeholder:'name@example.com'});
  const goal=el('textarea',undefined,'pf-input pf-goal');Object.assign(goal,{id:'profile-goal',value:p.goal,maxLength:2000,rows:2,placeholder:'写给自己，也可以写给同路人。'});
  const mail=line('联系邮箱',email,'profile-email-public',p.emailPublic,''),aim=line('学习目标',goal,'profile-goal-public',p.goalPublic,'');
  // Who can see me: three gates, each one opening only after the one before it.
  const ladder=el('fieldset',undefined,'pf-ladder');ladder.id='profile-privacy';
  ladder.append(el('legend','谁能看到我','pf-section'));
  const A=step('a','让人找到我'),B=step('b','翻阅我的账本'),C=step('c','允许复制');
  A.input.checked=p.discoverable;B.input.checked=p.booksVisible;C.input.checked=p.copyAllowed;
  const books=el('fieldset',undefined,'pf-books'),booksHead=el('div',undefined,'pf-books-head'),booksCount=el('span','','pf-books-count'),list=el('div',undefined,'pf-book-list'),picks=[],masterChecks=[];
  books.id='profile-publications';books.append(el('legend','选择公开账本','sr-only'));
  const pickAll=button('全选','quiet pf-mini',()=>{picks.forEach(c=>c.checked=true);changed();}),pickNone=button('全不选','quiet pf-mini',()=>{picks.forEach(c=>c.checked=false);changed();});
  booksHead.append(booksCount,pickAll,pickNone);books.append(booksHead,list);
  if(!P.v.ledgers.length){list.append(el('p','你还没有账本。以后新建的账本，也要回到这里勾选才会公开。','pf-note'));pickAll.hidden=pickNone.hidden=true;}
  for(const g of grouped(P.v.ledgers)){
   const box=el('div',undefined,'pf-book-group'),kids=[];
   if(g.title&&g.items.length>1&&Groups?.parse(g.items[0].t.name)){const head=el('label',undefined,'pf-book pf-book-master'),m=el('input');m.type='checkbox';m.className='pf-master-check';head.append(m,el('span',g.title,'pf-book-name'));box.append(head);m.addEventListener('change',()=>{kids.forEach(c=>c.checked=m.checked);changed();});masterChecks.push({m,kids});}
   else if(g.title)box.append(el('p',g.title,'pf-book-title'));
   for(const {t,label} of g.items){const row=el('label',undefined,'pf-book'),c=el('input');c.type='checkbox';c.id='publish-'+t.id;c.dataset.tagId=t.id;c.checked=P.v.publishedIds.includes(t.id);row.title=t.name;row.append(c,el('span',label,'pf-book-name'));box.append(row);picks.push(c);kids.push(c);}
   list.append(box);
  }
  const cascade=el('div',undefined,'pf-cascade');cascade.setAttribute('role','status');cascade.hidden=true;
  const rungs=el('div',undefined,'pf-rungs');rungs.append(A.row,B.row,books,C.row);ladder.append(rungs);
  form.append(who,shelf,about,ladder);pane.replaceChildren(form);pane.dataset.ready='1';
  // Foot: what saving will change, the one primary action, and a way back to the cloud copy.
  const summary=el('p','','pf-summary'),actions=el('div',undefined,'pf-foot-actions'),stamp=el('span',undefined,'pf-stamp');
  summary.id='profile-summary';summary.setAttribute('aria-live','polite');stamp.setAttribute('aria-hidden','true');
  const reload=button('重新读取','quiet',reloadProfile,'profile-reload'),save=el('button','保存资料与权限','primary');save.type='submit';save.id='profile-save';save.setAttribute('form','profile-form');
  actions.append(reload,save);foot.replaceChildren(cascade,stamp,summary,actions);
   let emailTouched=false,cascadeTimer=0,undo=null,nicknameFailure=null;
  const draft=()=>({nickname:nick.value,contactEmail:email.value,goal:goal.value,avatar:picked,discoverable:A.input.checked,booksVisible:B.input.checked,copyAllowed:C.input.checked,emailPublic:mail.toggle.checked,goalPublic:aim.toggle.checked,published:picks.filter(c=>c.checked).map(c=>c.dataset.tagId)});
  state.draft=draft;state.ledgers=P.v.ledgers;
  function nickProblem(){const v=nick.value.normalize('NFKC').replace(/\s+/gu,' ').trim();if(!v)return '昵称不能留空。';if(v.length>40)return '昵称最多 40 字。';if(!NICK.test(v)||!/[\p{L}\p{N}]/u.test(v))return '只能用文字、数字、空格，以及 . _ -';return '';}
  const mailProblem=()=>email.value.trim()&&!MAIL.test(email.value.trim())?'邮箱格式看起来不太对。':'';
  function notes(){
    if(nicknameFailure&&nicknameFailure.value!==nick.value)nicknameFailure=null;
    const n=nickProblem()||nicknameFailure?.message||'',m=emailTouched?mailProblem():'';
   nickNote.textContent=n||(nick.value.trim()===P.saved.nickname?'全站唯一，别人凭它找到你。':'全站唯一；保存时确认是否已被占用。');
   nickNote.classList.toggle('is-error',!!n);nick.setAttribute('aria-invalid',String(!!n));
   mail.note.textContent=m;mail.note.hidden=!m;mail.note.classList.toggle('is-error',!!m);email.setAttribute('aria-invalid',String(!!m));
   const left=2000-goal.value.length;aim.note.textContent=left<200?'还可以写 '+left+' 字。':'';aim.note.hidden=left>=200;
   return !n&&!mailProblem();
  }
  function ladderSync(){
   const a=A.input,b=B.input,c=C.input;if(!a.checked)b.checked=false;if(!b.checked)c.checked=false;b.disabled=!a.checked;c.disabled=!b.checked;books.disabled=!b.checked;
   const d=draft(),n=d.published.length,shown=['头像','昵称',...(d.goalPublic&&d.goal.trim()?['学习目标']:[]),...(d.emailPublic&&d.contactEmail.trim()?['邮箱']:[])];
   A.desc.textContent=a.checked?'别人可按昵称找到你，看到'+shown.join('、')+'。':'此刻没人能搜到你，资料只给自己看。';
   B.desc.textContent=b.disabled?'先打开「让人找到我」。':b.checked?(n?'别人可以翻阅下面勾选的 '+n+' 本，只读。':'还没勾选账本，别人会看到一个空书架。'):'账本只给自己看。';
   C.desc.textContent=c.disabled?'先打开「翻阅我的账本」。':c.checked?'别人可复制一份到自己名下；副本独立，不随你之后的修改而变。':'只能阅读，不能复制。';
   booksCount.textContent=P.v.ledgers.length?(b.checked?'已选 '+n+' / '+P.v.ledgers.length+' 本':'已选 '+n+' 本 · 打开上一道门后生效'):'';
   for(const s of [A,B,C]){s.row.classList.toggle('is-on',s.input.checked);s.row.classList.toggle('is-locked',s.input.disabled);}
   rungs.dataset.a=a.checked?'on':'off';rungs.dataset.b=b.checked?'on':'off';books.classList.toggle('is-locked',!b.checked);
   for(const {m,kids} of masterChecks){const k=kids.filter(x=>x.checked).length;m.checked=k===kids.length;m.indeterminate=k>0&&k<kids.length;m.disabled=!b.checked;}
   for(const t of [mail.toggle,aim.toggle])t.closest('.pf-inline-switch').classList.toggle('is-dormant',!a.checked);
  }
  // What a save would change, in plain words; widening the audience is set in clay so it is never missed.
  function summarize(){
   const s=P.saved,d=draft(),edits=[],open=[],shut=[];
   if(d.nickname.trim()!==s.nickname)edits.push('昵称');if(d.avatar!==s.avatar)edits.push('头像');if(d.contactEmail.trim()!==s.contactEmail)edits.push('邮箱');if(d.goal.trim()!==s.goal)edits.push('目标');
   const was={a:s.discoverable,b:s.discoverable&&s.booksVisible,c:s.discoverable&&s.booksVisible&&s.copyAllowed},now={a:d.discoverable,b:d.booksVisible,c:d.copyAllowed};
   const before=new Set(s.published),after=new Set(d.published),added=d.published.filter(x=>!before.has(x)).length,removed=s.published.filter(x=>!after.has(x)).length;
   if(now.a!==was.a)(now.a?open:shut).push('被搜到');
   if(now.b!==was.b)(now.b?open:shut).push(now.b?'翻阅 '+d.published.length+' 本账本':'翻阅账本');else if(now.b){if(added)open.push('再公开 '+added+' 本');if(removed)shut.push('收回 '+removed+' 本');}
   else if(added||removed)edits.push('账本勾选');
   if(now.c!==was.c)(now.c?open:shut).push('复制');
   for(const [key,label] of [['emailPublic','邮箱'],['goalPublic','学习目标']]){
    if(d[key]!==s[key]){
     if((now.a&&d[key])!==(was.a&&s[key]))((now.a&&d[key])?open:shut).push(label);
     else edits.push(label+'公开设置（仅被找到后生效）');
    }
   }
   summary.replaceChildren();
   if(!edits.length&&!open.length&&!shut.length){summary.append(el('span','与云端一致。','pf-sum-quiet'));return false;}
   const parts=[];if(edits.length)parts.push(el('span','改动：'+edits.join('、')));if(open.length)parts.push(el('span','将开放：'+open.join('、'),'pf-sum-open'));if(shut.length)parts.push(el('span','将收回：'+shut.join('、'),'pf-sum-shut'));
   parts.forEach((x,i)=>{if(i)summary.append(el('span',' · ','pf-sum-sep'));summary.append(x);});return true;
  }
  function changed(){
   ladderSync();const valid=notes(),was=dirty;dirty=summarize();
   if(!busy){save.disabled=!dirty||!valid;reload.textContent='重新读取';delete reload.dataset.armed;}
   if(dirty!==was||closeButton.dataset.armed)resetClose();if(!dirty&&status.classList.contains('error-text'))say('');
  }
  function showCascade(closed,restore){
   clearTimeout(cascadeTimer);undo=restore;cascade.replaceChildren(el('span','已一并关上：'+closed.join('、')+'。'),button('撤销','quiet pf-mini',()=>{undo?.();undo=null;cascade.hidden=true;changed();}));
   cascade.hidden=false;enter(cascade);cascadeTimer=setTimeout(()=>{cascade.hidden=true;undo=null;},10000);
  }
  A.input.addEventListener('change',()=>{const b=B.input.checked,c=C.input.checked;if(!A.input.checked&&(b||c)){B.input.checked=C.input.checked=false;showCascade([b&&'翻阅账本',c&&'允许复制'].filter(Boolean),()=>{A.input.checked=true;B.input.checked=b;C.input.checked=c;});}else cascade.hidden=true;});
  B.input.addEventListener('change',()=>{const c=C.input.checked;if(!B.input.checked&&c){C.input.checked=false;showCascade(['允许复制'],()=>{B.input.checked=true;C.input.checked=true;});}else cascade.hidden=true;});
  shelf.addEventListener('change',e=>{const r=e.target;if(!r.matches?.('.pf-avatar-input'))return;picked=Number(r.value);const o=r.closest('.pf-avatar-opt');o.classList.remove('is-picked');void o.offsetWidth;o.classList.add('is-picked');portrait.replaceChildren(Av.render(picked,'is-new'));avatarName.textContent='· '+Av.label(picked);showNow();});
  avatarName.textContent='· '+Av.label(p.avatar);
  const fit=()=>{goal.style.height='auto';goal.style.height=Math.min(goal.scrollHeight+2,320)+'px';};
  goal.addEventListener('input',fit);requestAnimationFrame(fit);
  email.addEventListener('blur',()=>{emailTouched=true;notes();});
  // Toggles settle on `change`, after their own cascade handlers; text fields update on every keystroke.
  form.addEventListener('input',e=>{if(e.target.type!=='checkbox'&&e.target.type!=='radio')changed();});form.addEventListener('change',changed);
  form.addEventListener('submit',e=>{e.preventDefault();submit();});
  changed();
  async function submit(){
   if(busy)return;emailTouched=true;if(!notes()){(nick.getAttribute('aria-invalid')==='true'?nick:email).focus();say('还有一处需要修改，见上方提示。',true);return;}
   const d=draft(),payload={nickname:d.nickname,contactEmail:d.contactEmail,goal:d.goal,avatar:d.avatar,discoverable:d.discoverable,booksVisible:d.booksVisible,copyAllowed:d.copyAllowed,emailPublic:d.emailPublic,goalPublic:d.goalPublic,version:P.version,ledgerRevision:P.v.ledgerRevision,publishedIds:d.published};
   const g=generation,controls=[...form.querySelectorAll('input,textarea,button'),...foot.querySelectorAll('button')],disabled=controls.map(n=>n.disabled);
   busy=true;dialog.setAttribute('aria-busy','true');controls.forEach(n=>n.disabled=true);save.textContent='保存中…';say('正在写入云端…');
   try{
    const r=await api('/api/profile',payload);if(g!==generation)return;
    P.version=r.profile.version;P.saved=snap(r.profile,r.publishedIds);P.v.publishedIds=r.publishedIds;
    nick.value=r.profile.nickname;email.value=r.profile.contactEmail;goal.value=r.profile.goal;fit();
    profileName=r.profile.nickname;rememberAvatar(r.profile.avatar);decorateHeader();
    say('资料与权限已保存。');foot.classList.remove('is-saved');void foot.offsetWidth;foot.classList.add('is-saved');
   }catch(e){
    if(e.stale||g!==generation)return;say(errorText(e,true),true);
     if(e.code==='nickname_taken')nicknameFailure={value:nick.value,message:e.message};
   }finally{
    if(g===generation){busy=false;dialog.setAttribute('aria-busy','false');controls.forEach((n,i)=>n.disabled=disabled[i]);save.textContent='保存资料与权限';changed();
     if(document.activeElement===document.body||!document.activeElement)(nickNote.classList.contains('is-error')?nick:save.disabled?reload:save).focus();}
   }
  }
  function reloadProfile(){
   if(busy)return;if(dirty&&!reload.dataset.armed){reload.dataset.armed='1';reload.textContent='放弃修改并重新读取';say('再点一次会放弃未保存的修改。');return;}
   dirty=false;resetClose();say('');state.profileTask=null;state.profile=null;form=null;foot.replaceChildren();foot.hidden=true;
   delete pane.dataset.ready;loading(pane,'正在重新读取…');showProfile().then(()=>{if(form&&tab==='profile')$('profile-nickname').focus({preventScroll:true});});
  }
 }

 /* ---------- Public card: shared by the preview and by other people's pages ---------- */
 function person(box,p,ledgers,{preview=false,onBook}={}){
  const card=el('section',undefined,'cm-card'),portrait=el('span',undefined,'cm-portrait'),text=el('div',undefined,'cm-card-text'),name=el('h3',p.nickname,'cm-name');
  portrait.append(Av.render(p.avatar));name.tabIndex=-1;text.append(name);
  if(p.goal?.trim()){const q=el('blockquote',undefined,'cm-goal');q.append(el('p',p.goal,'preserve-lines'));text.append(q);}
  if(p.contactEmail?.trim()){const m=el('p',undefined,'cm-email');m.append(el('span','邮箱','cm-email-label'),el('span',p.contactEmail,'cm-email-value'));text.append(m);}
  card.append(portrait,text);
  const shelf=el('section',undefined,'cm-shelf'),head=el('div',undefined,'cm-shelf-head');
  head.append(el('h4','公开账本','cm-sub'));if(p.booksVisible&&ledgers.length)head.append(el('span',ledgers.length+' 本'+(p.copyAllowed?' · 可复制':' · 只读'),'cm-shelf-meta'));shelf.append(head);
  if(!p.booksVisible)shelf.append(el('p',preview?'你还没打开「翻阅我的账本」，这里是空的。':'对方没有开放账本。','cm-quiet'));
  else if(!ledgers.length)shelf.append(el('p',preview?'还没勾选公开的账本。':'还没有公开的账本。','cm-quiet'));
  else for(const g of grouped(ledgers)){
   if(g.title)shelf.append(el('p',g.title,'cm-group'));const ul=el('ul',undefined,'cm-books');
   for(const {t,label} of g.items){const li=el('li'),row=preview?el('div',undefined,'cm-book'):button('','cm-book',()=>onBook(t),'community-book-'+t.id);row.append(el('span',label,'cm-book-name'));if(t.date)row.append(el('span',t.date,'cm-book-date'));if(!preview)row.append(chevron());li.append(row);ul.append(li);}
   shelf.append(ul);
  }
  box.append(card,shelf);return name;
 }
 function chevron(){const s=document.createElementNS('http://www.w3.org/2000/svg','svg'),p=document.createElementNS('http://www.w3.org/2000/svg','path');s.setAttribute('viewBox','0 0 24 24');s.setAttribute('class','hi cm-chevron');s.setAttribute('aria-hidden','true');p.setAttribute('class','hi-ink');p.setAttribute('d','M9.6 6.4c1.7 1.9 3.5 3.8 5.4 5.7-1.9 1.8-3.7 3.7-5.5 5.6');s.append(p);return s;}

 /* ---------- 公开主页: a live preview of the draft ---------- */
 async function showPreview(){
  const pane=panes.preview;loading(pane,'正在准备预览…');
  try{
   const P=await ensureProfile();if(!pane.isConnected||tab!=='preview')return;
   if(!form){if(!panes.profile){panes.profile=el('div',undefined,'cm-pane');panes.profile.id='pane-profile';panes.profile.hidden=true;body.prepend(panes.profile);}buildProfile(panes.profile,P);}
   const d=state.draft(),box=el('div',undefined,'cm-preview');
   if(dirty||d.discoverable)box.append(el('p',dirty?'按尚未保存的设置预览；保存后才对别人生效。':'这就是别人此刻看到的你。','cm-preview-note'));
   if(!d.discoverable){
    const n=el('div',undefined,'cm-state');n.append(art('art-closed'),el('h3','此刻，没有人能找到你。','cm-state-title'),el('p','资料只属于你自己。打开「让人找到我」后，这一页就是别人看到的样子。','cm-state-text'),button('去打开','quiet cm-link',()=>{select('profile');const a=$('profile-a');a.scrollIntoView({block:'center',behavior:'smooth'});a.focus({preventScroll:true});}));box.append(n);
   }else{
    const pick=new Set(d.published),ledgers=d.booksVisible?state.ledgers.filter(t=>pick.has(t.id)):[];
    person(box,{nickname:d.nickname.trim()||'（未填昵称）',avatar:d.avatar,booksVisible:d.booksVisible,copyAllowed:d.copyAllowed,...(d.emailPublic?{contactEmail:d.contactEmail}:{}),...(d.goalPublic?{goal:d.goal}:{})},ledgers,{preview:true});
   }
   pane.replaceChildren(box);
  }catch(e){if(e.stale||!pane.isConnected)return;failure(pane,errorText(e),showPreview);}
 }

 /* ---------- 社区: search → person → ledger → copy ---------- */
 function showCommunity(){
  const pane=panes.community;if(pane.dataset.ready)return;pane.dataset.ready='1';
  const C=state.community={token:0,searchToken:0,timer:0,after:null,term:'',completed:false,lastPerson:null};
  const search=el('div',undefined,'cm-search'),f=el('form',undefined,'cm-search-form'),field=el('div',undefined,'search-field cm-field'),q=el('input'),label=el('label','按昵称开头查找','sr-only'),submit=el('button','查找','quiet cm-submit');
  search.id='community-search';f.id='community-search-form';f.setAttribute('role','search');submit.type='submit';
  Object.assign(q,{id:'community-query',type:'search',maxLength:80,autocomplete:'off',spellcheck:false,placeholder:'输入昵称的开头'});q.setAttribute('enterkeyhint','search');label.htmlFor=q.id;
  field.append(searchIcon(),q,submit);f.append(label,field);
  const note=el('p','','cm-search-note'),stage=el('div',undefined,'cm-search-stage'),results=el('ul',undefined,'cm-results'),more=button('更多','quiet cm-more',()=>run(true));
  note.id='community-search-note';note.setAttribute('aria-live','polite');results.id='community-results';results.setAttribute('aria-label','搜索结果');more.hidden=true;
  search.append(f,note,stage,results,more);
  const detail=el('div',undefined,'cm-detail');detail.id='community-detail';detail.hidden=true;pane.append(search,detail);
  intro();
  function intro(){results.replaceChildren();more.hidden=true;note.textContent='';const n=el('div',undefined,'cm-state');n.append(art('art-commons'),el('h3','同路的人，在这里','cm-state-title'),el('p','按昵称的开头找人。只有愿意被找到的人，才会出现在这里。','cm-state-text'));stage.replaceChildren(n);}
  let composing=false;
  q.addEventListener('compositionstart',()=>composing=true);q.addEventListener('compositionend',()=>{composing=false;schedule();});
  q.addEventListener('input',()=>{if(!composing)schedule();});
  q.addEventListener('keydown',e=>{if(e.key==='Escape'&&q.value){e.preventDefault();e.stopPropagation();q.value='';schedule();}});
  f.addEventListener('submit',e=>{e.preventDefault();clearTimeout(C.timer);run(false);});
  function schedule(){clearTimeout(C.timer);C.searchToken++;abortGroup('search');more.hidden=true;if(!q.value.trim()){C.term='';intro();return;}C.timer=setTimeout(()=>run(false),420);}
  async function run(next){
   if(!dialog.open||state?.community!==C||!identity)return;
   const term=q.value.trim();if(!term){intro();return;}if(!next&&term===C.term&&C.completed){more.hidden=!C.after;return;}
   const token=++C.searchToken;abortGroup('search');
   if(!next){C.term=term;C.after=null;C.completed=false;stage.replaceChildren();results.replaceChildren(...[0,1,2].map(()=>{const li=el('li',undefined,'cm-ghost');li.setAttribute('aria-hidden','true');li.append(el('i'),el('b'));return li;}));more.hidden=true;note.textContent='正在翻找…';}
   else{more.disabled=true;more.textContent='正在翻找…';}
   try{
    const v=await api('/api/community?q='+encodeURIComponent(term)+(next&&C.after?'&after='+encodeURIComponent(C.after):''),undefined,'search');
    if(token!==C.searchToken)return;
    if(!next)results.replaceChildren();
    v.users.forEach((u,i)=>{const li=el('li'),b=button('','cm-person',()=>openPerson(u.publicId,b));b.dataset.publicId=u.publicId;b.style.setProperty('--i',String(Math.min(i,8)));const face=el('span',undefined,'cm-person-face');face.append(Av.render(u.avatar));b.append(face,nameWithMatch(u.nickname,term),chevron());li.append(b);results.append(li);});
    C.completed=true;C.after=v.next;more.hidden=!v.next;more.disabled=false;more.textContent='更多';
    const total=results.childElementCount;
    if(!total){note.textContent='';const n=el('div',undefined,'cm-state cm-state-small');n.append(art('art-search'),el('p','没有以「'+term+'」开头的公开昵称。','cm-state-title'),el('p','换个开头试试；对方也可能还没打开「让人找到我」。','cm-state-text'));stage.replaceChildren(n);}
    else note.textContent='找到 '+total+' 位'+(v.next?'，往下还有':'')+'。';
   }catch(e){
    if(e.stale||token!==C.searchToken||e.name==='AbortError'&&!dialog.open)return;
    more.disabled=false;more.textContent='更多';if(!next)results.replaceChildren();note.textContent='';failure(stage,errorText(e),()=>run(next));
   }
  }
  C.run=run;C.search=search;C.detail=detail;C.query=q;
 }
 function searchIcon(){const t=document.querySelector('.search-global .search-field .hi');return t?t.cloneNode(true):el('span');}
 function nameWithMatch(name,term){
  const n=el('span',undefined,'cm-person-name'),t=term.normalize('NFKC').toLowerCase();
  if(name.normalize('NFKC')===name&&name.toLowerCase().startsWith(t)&&t.length<=name.length){n.append(el('mark',name.slice(0,t.length),'cm-match'),document.createTextNode(name.slice(t.length)));}else n.textContent=name;return n;
 }
 function backLink(text,fn){const b=button('','quiet cm-back',fn,'community-back'),s=chevron();s.classList.add('cm-back-mark');b.append(s,el('span',text));return b;}
 function showDetail(on){const C=state.community;C.search.hidden=on;C.detail.hidden=!on;if(on)enter(C.detail);else{C.detail.replaceChildren();enter(C.search);}}
 function backToSearch(){const C=state.community;C.token++;if(!busy)say('');abortGroup('nav');showDetail(false);const target=C.lastPerson&&[...$('community-results').querySelectorAll('.cm-person')].find(b=>b.dataset.publicId===C.lastPerson);(target||C.query).focus();}
 async function openPerson(id,from){
  const C=state.community,token=++C.token;abortGroup('nav');if(!busy)say('');if(from)C.lastPerson=id;
  showDetail(true);const box=el('div',undefined,'cm-detail-body');C.detail.replaceChildren(backLink('社区',backToSearch),box);loading(box,'正在打开这张名片…');body.scrollTop=0;C.detail.querySelector('.cm-back').focus();
  try{
   const v=await api('/api/community?user='+encodeURIComponent(id),undefined,'nav');if(token!==C.token)return;
   box.replaceChildren();const heading=person(box,v.profile,v.ledgers,{onBook:t=>openBook(id,t.id,v.profile.nickname)});heading.focus({preventScroll:true});
  }catch(e){if(e.stale||token!==C.token)return;failure(box,errorText(e),()=>openPerson(id));}
 }
 async function openBook(id,tagId,owner){
  const C=state.community,token=++C.token;abortGroup('nav');if(!busy)say('');
  const box=el('div',undefined,'cm-detail-body');C.detail.replaceChildren(backLink(owner||'返回',()=>openPerson(id)),box);enter(C.detail);loading(box,'正在翻开账本…');body.scrollTop=0;C.detail.querySelector('.cm-back').focus();
  try{
   const v=await api('/api/community?user='+encodeURIComponent(id)+'&tag='+encodeURIComponent(tagId),undefined,'nav');if(token!==C.token)return;
   book(box,id,tagId,v);
  }catch(e){if(e.stale||token!==C.token)return;failure(box,errorText(e),()=>openBook(id,tagId,owner));}
 }
 function book(box,id,tagId,v){
  const t=v.data.tags[0],words=v.data.words,x=Groups?.parse(t.name),head=el('header',undefined,'cm-book-head'),name=el('h3',x?'第 '+x.set+' 套 · '+x.type:t.name,'cm-book-title'),meta=el('p',undefined,'cm-book-meta');
  name.tabIndex=-1;meta.append(el('span',words.length+' 条词条'),...(t.date?[el('span',' · '+t.date)]:[]));
  head.append(el('p',v.profile.nickname+' 的公开账本'+(x?' · '+Groups.masterTitle(x.key):''),'cm-kicker'),name,meta);
  const area=el('div',undefined,'cm-copy');area.id='community-copy-area';
  const list=el('ol',undefined,'cm-words'),more=button('','quiet cm-more',append);let at=0;
  function append(){for(const w of words.slice(at,at+PAGE))list.append(word(w));at+=PAGE;more.hidden=at>=words.length;more.textContent='再显示 '+Math.min(PAGE,words.length-at)+' 条';}
  box.replaceChildren(head,area,list,more);append();
  if(!words.length)list.replaceWith(el('p','这本账本还是空的。','cm-quiet'));
  copyStart(area,id,tagId,v.profile.copyAllowed);name.focus({preventScroll:true});
 }
 function word(w){
  const li=el('li',undefined,'share-word cm-word'),en=el('span',w.english,'cm-en');en.lang='en';li.append(en,el('p',w.meaning,'cm-meaning preserve-lines'));
  if(w.exampleSentence?.trim()){const p=rich(el('p',undefined,'cm-example preserve-lines'),w.exampleSentence);p.lang='en';li.append(p);}
  if(w.exampleTranslation?.trim())li.append(rich(el('p',undefined,'cm-translation preserve-lines'),w.exampleTranslation));
  if(w.note?.trim()){const n=el('p',undefined,'cm-note preserve-lines');n.append(el('span','备注','cm-note-label'),document.createTextNode(w.note));li.append(n);}
  return li;
 }
 function copyStart(area,id,tagId,allowed){
  if(!allowed){area.replaceChildren(el('p','作者只开放阅读，没有开放复制。','cm-hint'));return;}
  const go=button('','primary',()=>plan(area,id,tagId,go),'community-copy');go.append(copyIcon(),el('span','复制到我的账本'));
  area.replaceChildren(go,el('p','复制后归你所有，可以自由增删；与原账本互不影响。','cm-hint'));
 }
 function copyIcon(){const s=document.createElementNS('http://www.w3.org/2000/svg','svg');s.setAttribute('viewBox','0 0 24 24');s.setAttribute('class','hi');s.setAttribute('aria-hidden','true');
  for(const [c,d] of [['hi-acc','M9.6 8.4l9.4-.3.3 10.6-9.5.2z'],['hi-paper hi-ink','M4.6 4.8l9.6-.2.2 10.8-9.6.2z'],['hi-ink','M14.4 9.6l5.2-.1.2 10.6-9.6.2-.1-4.6']]){const p=document.createElementNS('http://www.w3.org/2000/svg','path');p.setAttribute('class',c);p.setAttribute('d',d);s.append(p);}return s;}
 async function write(fn){const g=generation;busy=true;dialog.setAttribute('aria-busy','true');try{return await fn();}finally{if(g===generation){busy=false;dialog.setAttribute('aria-busy','false');}}}
 function copied(area,text,fresh){
  const n=el('div',undefined,'cm-copied'+(fresh?' is-fresh':''));n.append(art('art-seal'),el('p',text,'cm-copied-text'));
  if(fresh)n.append(button('回到我的账本','quiet cm-link',()=>dialog.close()));area.replaceChildren(n);
 }
 async function plan(area,id,tagId,go){
  if(busy)return;go.disabled=true;go.lastChild.textContent='正在核对…';say('');
  try{
   const p=await write(()=>api('/api/community',{action:'plan',publicId:id,tagId}));
   if(p.alreadyCopied){say('你已经复制过这本，不会重复创建。');copied(area,'你已经复制过这本，不会重复创建。',false);return;}
   const panel=el('div',undefined,'community-copy-plan'),lineText=el('p',undefined,'cm-plan-line');
   lineText.append('将新建账本',el('strong','「'+p.name+'」'),'，收下 '+p.words+' 条词条。');panel.append(lineText);
   if(p.conflict)panel.append(el('p','你已有同名账本，这份副本会用上面的新名字。','cm-plan-note'));
   const confirm=button('确认复制','primary',()=>commit(area,id,tagId,p,confirm),'community-copy-confirm'),cancel=button('取消','quiet',()=>{copyStart(area,id,tagId,true);$('community-copy').focus();});
   const row=el('div',undefined,'cm-plan-actions');row.append(confirm,cancel);panel.append(row);area.replaceChildren(panel);enter(panel);confirm.focus();
  }catch(e){if(e.stale)return;say(errorText(e,true),true);go.disabled=false;go.lastChild.textContent='复制到我的账本';}
 }
 async function commit(area,id,tagId,p,confirm){
  if(busy)return;confirm.disabled=true;confirm.textContent='正在复制…';
  try{
   const r=await write(()=>api('/api/community',{action:'copy',publicId:id,tagId,expectedRevision:p.expectedRevision,planHash:p.planHash}));
   if(r.alreadyCopied){say('你已经复制过这本，不会重复创建。');copied(area,'你已经复制过这本，不会重复创建。',false);}
   else{say('已复制为你的独立账本。');copied(area,'已复制为你的独立账本「'+p.name+'」。',true);area.querySelector('button')?.focus();}
   window.dispatchEvent(new Event('ledger-sharing-received'));
  }catch(e){if(e.stale)return;say(errorText(e,true),true);copyStart(area,id,tagId,true);$('community-copy')?.focus();}
 }

 /* ---------- Wiring ---------- */
 function clear(){invalidate();identity=null;profileName='';avatarKnown=null;dirty=false;state=null;panes={};form=null;body.replaceChildren();foot.replaceChildren();say('');if(dialog.open){dialog.classList.add('is-instant');dialog.close();requestAnimationFrame(()=>dialog.classList.remove('is-instant'));}$('account-name').disabled=true;decorateHeader();}
 $('account-name').addEventListener('click',()=>open('profile'));$('community-open').addEventListener('click',()=>open('community'));closeButton.addEventListener('click',close);
 dialog.addEventListener('cancel',e=>{if(dirty||busy){e.preventDefault();close();}});
 dialog.addEventListener('close',()=>{invalidate();dirty=false;state=null;panes={};form=null;body.replaceChildren();foot.replaceChildren();foot.hidden=true;say('');resetClose();if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});});
 dialog.addEventListener('keydown',e=>{if(e.key!=='Tab')return;const controls=[...dialog.querySelectorAll('button,input,textarea,select,a[href],[tabindex="0"]')].filter(n=>!n.disabled&&n.tabIndex>=0&&n.getClientRects().length&&!(n.type==='radio'&&!n.checked)),first=controls[0],last=controls.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}});
 window.addEventListener('beforeunload',e=>{if(dirty||busy){e.preventDefault();e.returnValue='';}});
 // Clear sensitive form/search DOM whenever the host's account check starts.
 window.addEventListener('ledger-community-suspend',()=>{if(dialog.open)dialog.close();});
 window.addEventListener('pagehide',clear);
  window.LedgerCommunity={clear,accountChanged(next){if(next?.key!==identity?.key){clear();identity=next;rememberAvatar(next?.avatar);}else if(next){identity=next;if(Av.valid(next.avatar))rememberAvatar(next.avatar);}$('account-name').disabled=!next;if(next&&profileName)$('account-name').textContent=profileName;decorateHeader();}};
})();
