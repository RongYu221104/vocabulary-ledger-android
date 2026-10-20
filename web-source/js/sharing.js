(function(){
 'use strict';
 const M=window.LedgerModel,G=window.LedgerGroups,$=id=>document.getElementById(id);
 let current=M.empty(),identity=null,generation=0,busy=false,returnFocus=null,mode='',pendingCreate=null,preview=null,selected=new Set(),plan=null;
 const dialog=$('sharing-dialog'),body=$('sharing-body'),actions=$('sharing-actions'),status=$('sharing-status');
 const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
 const button=(text,fn,cls='quiet')=>{const b=el('button',cls,text);b.type='button';b.addEventListener('click',()=>run(fn));return b;};
 const say=(message,error=false)=>{status.textContent=message;status.classList.toggle('error-text',error);};
 let locked=new Map();
 function lock(value){busy=value;dialog.setAttribute('aria-busy',String(value));if(value){locked=new Map();for(const c of dialog.querySelectorAll('button,input,select')){locked.set(c,c.disabled);c.disabled=true;}}else{for(const [c,disabled] of locked)if(c.isConnected)c.disabled=disabled;locked.clear();}$('sharing-close').disabled=false;}
 async function run(fn){if(busy)return;let g=generation;try{const work=fn();g=generation;if(!work?.then)return;lock(true);await work;}catch(e){if(g===generation)say(e.message,true);}finally{if(g===generation)lock(false);}}
 async function api(payload,token){
  const key=identity?.key,g=generation;
  let r;
  try{r=await fetch('/api/shares',{method:payload?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:{...(token?{'X-Ledger-Share':token}:{'X-Ledger-Session':key||''}),...(payload?{'Content-Type':'application/json','X-Ledger-Request':'1'}:{})},body:payload?JSON.stringify(payload):undefined,signal:AbortSignal.timeout(45000)});}catch{throw Error('连接中断，结果尚未确认。请重试相同操作。');}
  const v=await r.json().catch(()=>({error:'云端返回异常，请稍后重试。'}));
  if(g!==generation||(!token&&key!==identity?.key))throw Error('账号或面板已变化，请重新打开。');
  if(!r.ok){if(v.code==='auth')window.dispatchEvent(new CustomEvent('ledger-sharing-auth',{detail:key}));throw Error(v.error||'操作失败，请重试。');}
  return v;
 }
 function open(title,nextMode){
  generation++;busy=false;locked.clear();dialog.setAttribute('aria-busy','false');mode=nextMode;body.replaceChildren();actions.replaceChildren();say('');$('sharing-title').textContent=title;
  if(!dialog.open){returnFocus=document.activeElement;dialog.showModal();}document.documentElement.classList.add('sharing-modal-open');$('sharing-close').focus();
 }
 function clear(){generation++;busy=false;pendingCreate=null;preview=null;plan=null;selected.clear();body.replaceChildren();actions.replaceChildren();say('');if(dialog.open)dialog.close();identity=null;}
 dialog.addEventListener('close',()=>{generation++;busy=false;document.documentElement.classList.remove('sharing-modal-open');if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});});
 $('sharing-close').addEventListener('click',()=>dialog.close());
 dialog.addEventListener('keydown',e=>{if(e.key!=='Tab')return;const controls=[...dialog.querySelectorAll('button,input,select,summary,a[href]')].filter(n=>!n.disabled&&n.getClientRects().length);const first=controls[0],last=controls.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}});
 dialog.addEventListener('cancel',()=>{ /* native Escape and focus trap remain available during an uncertain request */ });
 function needLogin(){
  body.append(el('p','sharing-note','登录 ChatGPT 后可分享个人云端账本。公开昵称由你填写，不代表官方认证用户名。'));
  actions.append(button('通过 ChatGPT 登录',()=>{$('sign-in').click();} ,'primary'));
 }
 async function confirmIdentity(){const g=generation,latest=await window.LedgerCloud.session();if(g!==generation)throw Error('面板已关闭，请重新打开。');if(!latest.authenticated||latest.key!==identity?.key){const old=identity?.key;clear();window.dispatchEvent(new CustomEvent('ledger-sharing-auth',{detail:old}));throw Error('账号已变化，请重新登录读取。');}}
 function tree(data,picks,onChange,showWords=false){
  const root=el('div','share-tree'),org=G.organize(data.tags),parents=[];const counts=M.tagStats(data);
  const tools=el('div','share-selection-tools'),total=el('output','share-count');total.setAttribute('aria-live','polite');
  const all=button('全选',()=>{data.tags.forEach(t=>picks.add(t.id));sync();});const none=button('取消选择',()=>{picks.clear();sync();});
  tools.append(all,none,total);root.append(tools);
  const inputs=[];
  const row=(tag,target)=>{
   const label=el('label','share-leaf'),input=el('input');input.type='checkbox';input.value=tag.id;input.checked=picks.has(tag.id);
   const copy=el('span','share-leaf-copy');copy.append(el('span','share-leaf-name',tag.name),el('span','share-leaf-count',counts.get(tag.id).total+' 个词条'));
   label.append(input,copy);target.append(label);inputs.push(input);input.addEventListener('change',()=>{input.checked?picks.add(tag.id):picks.delete(tag.id);sync();});
   if(showWords){const words=data.words.filter(w=>w.tagId===tag.id);const details=el('details','share-words'),summary=el('summary','',words.length?'查看词条预览 · '+Math.min(10,words.length)+' / '+words.length:'空账本');details.append(summary);
    details.addEventListener('toggle',()=>{if(!details.open||details.dataset.loaded)return;details.dataset.loaded='1';for(const w of words.slice(0,10)){const p=el('div','share-word');p.append(el('b','',w.english),el('p','preserve-lines',w.meaning));if(w.exampleSentence)p.append(el('p','preserve-lines',w.exampleSentence));if(w.exampleTranslation)p.append(el('p','preserve-lines',w.exampleTranslation));if(w.note)p.append(el('p','preserve-lines share-note',w.note));details.append(p);}});target.append(details);
   }
  };
  for(const m of org.masters){
   const section=el('section','share-master'),heading=el('div','share-master-head'),label=el('label'),input=el('input');input.type='checkbox';input.setAttribute('aria-label','选择主账本 '+(m.label||m.key));
   label.append(input,el('strong','',m.label||m.key));heading.append(label,el('span','',m.subs.length+' 个子账本'));section.append(heading);
   const children=el('div','share-children');m.subs.forEach(s=>row(s.tag,children));section.append(children);root.append(section);parents.push({input,ids:m.subs.map(s=>s.tag.id)});
   input.addEventListener('change',()=>{for(const s of m.subs)input.checked?picks.add(s.tag.id):picks.delete(s.tag.id);sync();});
  }
  for(const t of org.customs){const section=el('section','share-master');row(t,section);root.append(section);}
  function sync(){for(const i of inputs)i.checked=picks.has(i.value);for(const p of parents){const n=p.ids.filter(x=>picks.has(x)).length;p.input.checked=n===p.ids.length;p.input.indeterminate=n>0&&n<p.ids.length;}
   const groups=org.masters.filter(m=>m.subs.some(s=>picks.has(s.tag.id))).length,words=data.words.filter(w=>picks.has(w.tagId)).length;
   total.textContent=groups+' 个主账本 · '+picks.size+' 个账本 · '+words+' 个词条';onChange?.();
  }
  sync();return root;
 }
 function copyLink(url,target){
  const box=el('div','share-link-box'),label=el('label','', '独立分享链接'),input=el('input','share-link');input.type='text';input.readOnly=true;input.value=url;input.setAttribute('aria-label','独立分享链接');
  const copy=button('复制链接',async()=>{try{await navigator.clipboard.writeText(url);say('链接已复制。');copy.textContent='已复制';}catch{input.focus();input.select();say('请选择链接并使用系统复制。');}});
  label.append(input);box.append(label,copy);target.append(box);
 }
 async function createPanel(){
  open('分享账本','create');pendingCreate=null;
  if(!identity){needLogin();return;}
  say('正在读取分享设置…');await confirmIdentity();const settings=await api();say('');
  if(!current.tags.length){body.append(el('p','empty','还没有可以分享的账本。空账本也可以分享。'));return;}
  const source=M.clone(current),picks=new Set(),fields=el('div','share-options'),nickLabel=el('label','', '公开昵称'),nick=el('input');nick.id='share-nickname';nick.maxLength=40;nick.autocomplete='nickname';nick.value=settings.nickname;nick.placeholder='例如 rongyu1104';nickLabel.append(nick);
  const expiryLabel=el('label','','有效期'),expiry=el('select');expiry.id='share-expiry';for(const n of [1,7,30,90]){const o=el('option','',n+' 天');o.value=n;expiry.append(o);}expiry.value='30';expiryLabel.append(expiry);fields.append(nickLabel,expiryLabel);
  body.append(fields,el('p','sharing-note','任何持有链接的人都能预览并接收所选内容。昵称为自定义公开名称；修改昵称只影响新分享。'));
  const create=button('创建分享链接',async()=>{
   await confirmIdentity();
   const payload={action:'create',ids:[...picks].sort(),nickname:nick.value.trim(),days:Number(expiry.value),expectedRevision:source.revision};
   const fingerprint=JSON.stringify(payload);if(!pendingCreate||pendingCreate.fingerprint!==fingerprint)pendingCreate={fingerprint,payload:{...payload,requestId:crypto.randomUUID()}};
   const v=await api(pendingCreate.payload);pendingCreate=null;open('分享已创建','success');body.append(el('p','sharing-note',v.share.tags+' 个账本 · '+v.share.words+' 个词条 · '+new Date(v.share.expiresAt).toLocaleDateString('zh-CN')+' 到期'));copyLink(v.share.url,body);actions.append(button('分享管理',managePanel,'primary'));say('可以复制链接并发送。');
  },'primary');create.id='share-create';actions.append(create);
  body.append(tree(source,picks,()=>{create.disabled=!picks.size;}));create.disabled=!picks.size;
 }
 async function managePanel(){
  open('分享管理','manage');if(!identity){needLogin();return;}say('正在读取分享…');await confirmIdentity();const v=await api();say('');
  if(!v.shares.length){body.append(el('p','empty','还没有分享链接。'));actions.append(button('分享账本',createPanel,'primary'));return;}
  for(const s of v.shares){const card=el('section','share-master'),header=el('div','share-master-head');header.append(el('strong','',s.nickname),el('span','',({active:'有效',revoked:'已撤销',expired:'已过期'})[s.state]));card.append(header,el('p','sharing-note',s.tags+' 个账本 · '+s.words+' 个词条 · '+new Date(s.expiresAt).toLocaleDateString('zh-CN')+' 到期'));copyLink(s.url,card);
   if(s.state==='active'){const revoke=button('撤销链接',()=>{say('');const p=el('div','share-revoke-confirm');p.append(el('p','','撤销后将禁止新的预览和接收，已有副本会保留。'),button('取消',()=>p.remove()),button('确认撤销',async()=>{await api({action:'revoke',id:s.id});await managePanel();say('分享已撤销。');},'danger'));card.append(p);revoke.disabled=true;});card.append(revoke);}body.append(card);
  }
  actions.append(button('分享账本',createPanel,'primary'));
 }
 function picksInUrl(){if(!preview)return;const u=new URL(location.href);u.searchParams.set('pick',preview.data.tags.map((t,i)=>selected.has(t.id)?i.toString(36):null).filter(x=>x!==null).join('.'));history.replaceState(null,'',u);$('sign-in').href='/signin-with-chatgpt?return_to='+encodeURIComponent(u.pathname+u.search);$('auth-continue').href=$('sign-in').href;}
 async function previewPanel(){
  const token=new URL(location.href).searchParams.get('share');if(!token)return;
  open('接收分享账本','preview');say('正在读取分享快照…');
  try{preview=await api(null,token);preview.token=token;selected=new Set();
   const raw=new URL(location.href).searchParams.get('pick');const indices=raw===null?preview.data.tags.map((_,i)=>i):raw.split('.').filter(x=>/^[a-z0-9]{1,3}$/.test(x)).map(x=>parseInt(x,36));
   indices.forEach(i=>{const t=preview.data.tags[i];if(t)selected.add(t.id);});renderPreview();say('');
  }catch(e){body.append(el('p','sharing-note',e.message));say(e.message,true);actions.append(button('返回我的账本',()=>dialog.close(),'primary'));}
 }
 function renderPreview(){
  body.replaceChildren();actions.replaceChildren();plan=null;mode='preview';$('sharing-title').textContent='来自 '+preview.nickname+' 的账本';
  body.append(el('p','sharing-note','接收为独立副本，可自由编辑。'+new Date(preview.expiresAt).toLocaleDateString('zh-CN')+' 到期。'),el('p','share-nickname-note','分享者使用自定义公开昵称。'));
  const receive=button(identity?'接收选中账本':'登录并接收',async()=>{
   picksInUrl();
   if(!identity){dialog.close();$('sign-in').click();return;}
   await confirmIdentity();const v=await api({action:'plan',token:preview.token,ids:[...selected]});
   if(v.alreadyReceived){showReceived(v);return;}
   plan=v;body.replaceChildren();actions.replaceChildren();$('sharing-title').textContent='确认接收';body.append(el('p','sharing-note','将新增独立副本。同名账本自动改名；现有内容会完整保留。'));
   for(const row of v.rows){const p=el('p','share-plan-row');p.append(el('strong','',row.name),el('span','',row.container?'放入主账本：'+row.container:'自定义账本'));if(row.conflict)p.append(el('small','','已处理重名'));body.append(p);}
   actions.append(button('返回选择',()=>{renderPreview();say('');}),button('确认接收独立副本',async()=>{await confirmIdentity();const r=await api({action:'receive',token:preview.token,ids:[...selected],expectedRevision:plan.expectedRevision,planHash:plan.planHash});showReceived(r);},'primary'));
  },'primary');receive.id='share-receive';actions.append(receive);body.append(tree(preview.data,selected,()=>{receive.disabled=!selected.size;picksInUrl();},true));receive.disabled=!selected.size;
 }
 function showReceived(v){
  $('sharing-title').textContent=v.alreadyReceived?'这份分享已接收':'账本已接收';body.replaceChildren(el('p','sharing-note',v.alreadyReceived?'此账号已接收过这份分享，本次没有重复复制。':'已保存到个人云端。你可以编辑、添加词条和背诵，来源会持续保留。'));actions.replaceChildren(button('查看我的账本',()=>{dialog.close();window.dispatchEvent(new Event('ledger-sharing-received'));},'primary'));say('');window.dispatchEvent(new Event('ledger-sharing-received'));
 }
 $('sharing-open').addEventListener('click',()=>run(createPanel));$('sharing-manage').addEventListener('click',()=>run(managePanel));
 window.LedgerSharing={clear,accountChanged(next){if(identity&&identity.key!==next?.key)clear();identity=next;if(mode==='preview'&&$('share-receive'))$('share-receive').textContent=next?'接收选中账本':'登录并接收';},update(data,next){current=data;this.accountChanged(next);}};
 // Only public snapshot IDs enter the return URL; private guest/cloud records never enter browser storage.
 if(new URL(location.href).searchParams.has('share'))previewPanel();
})();
