(function(){
'use strict';
const M=window.LedgerModel;
class StorageError extends Error{constructor(message,code='cloud'){super(message);this.name='StorageError';this.code=code;}}
class GuestStore{
 constructor(){this.mode='guest';this.current=M.empty();this.blocked=false;this.pending=null;this.dirty=false;}
 async read(){return M.clone(this.current);}
 async load(){return {data:await this.read(),error:null};}
 async save(next,{action,payload,restore=false}={}){
  const valid=M.validate(next);valid.revision=this.current.revision+1;
  if(new TextEncoder().encode(JSON.stringify(valid)).length>M.LIMITS.bytes-1024)throw new StorageError('账本已达 8 MiB 容量上限。请导出后整理记录；当前数据未改变。','quota');
  if(!restore&&payload?.id){const item=(action.includes('Tag')?valid.tags:valid.words).find(x=>x.id===payload.id);if(item)item.recordVersion++;}
  this.current=valid;this.dirty=true;return M.clone(valid);
 }
 dispose(){this.current=M.empty();this.pending=null;this.dirty=false;this.blocked=true;}
}
async function session({signal}={}){
 const r=await fetch('/api/session',{credentials:'same-origin',cache:'no-store',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});
 if(r.status===401||r.status===403||r.redirected)throw new StorageError('登录状态已失效。','auth');
 if(!r.ok||r.redirected||!r.headers.get('content-type')?.includes('application/json'))throw new StorageError('无法确认登录状态。当前可使用游客账本；请导出备份。','session');
 return r.json();
}
// One server identity request per generation. Invalidated replies can never revive a disposed account.
class SessionGate{
 constructor(read=session){this.read=read;this.epoch=0;this.flight=null;}
 invalidate(){this.epoch++;this.flight?.controller.abort();this.flight=null;}
 check(){
  if(this.flight)return this.flight.promise;
  const epoch=this.epoch,flight={controller:new AbortController(),promise:null};
  flight.promise=Promise.resolve().then(()=>this.read({signal:flight.controller.signal})).then(value=>{
   if(epoch!==this.epoch)throw new StorageError('身份检查已过期。','stale');return value;
  },error=>{if(epoch!==this.epoch)throw new StorageError('身份检查已过期。','stale');throw error;})
   .finally(()=>{if(this.flight===flight)this.flight=null;});
  this.flight=flight;return flight.promise;
 }
}
class Store{
 constructor(identity){this.mode='cloud';this.identity=identity;this.current=M.empty();this.blocked=true;this.pending=null;this.generation=0;this.controllers=new Set();}
 dispose(){this.generation++;for(const c of this.controllers)c.abort();this.controllers.clear();this.current=M.empty();this.pending=null;this.identity=null;this.blocked=true;}
 async request(method,body,query=''){
  const generation=this.generation,sourceKey=this.identity?.key,c=new AbortController();this.controllers.add(c);const timer=setTimeout(()=>c.abort(),45000);let response;
  const authError=message=>Object.assign(new StorageError(message,'auth'),{sourceKey});
  try{response=await fetch('/api/ledger'+query,{method,credentials:'same-origin',cache:'no-store',headers:{'X-Ledger-Session':this.identity?.key||'',...(method==='POST'?{'Content-Type':'application/json','X-Ledger-Request':'1'}:{})},body:body?JSON.stringify(body):undefined,signal:c.signal});}
  catch{throw new StorageError('连接失败，尚未确认保存。输入已保留；可重试相同操作或重新读取核对。','network');}
  finally{clearTimeout(timer);this.controllers.delete(c);}
  if(generation!==this.generation)throw authError('会话已结束。');
  if(response.redirected||response.headers.get('content-type')?.includes('text/html'))throw authError('登录已失效，请通过 ChatGPT 重新登录。');
  const result=await response.json().catch(()=>({error:'云端返回无法解析，保存尚未确认。'}));
  if(generation!==this.generation)throw authError('会话已结束。');
  if(!response.ok){const error=new StorageError(result.error||'保存失败，请重试。',response.status===401||response.status===403?'auth':result.code||'cloud');if(error.code==='auth')error.sourceKey=sourceKey;throw error;}return result;
 }
 async revision(){return (await this.request('GET',null,'?mode=revision')).revision;}
 async read(){
  for(let attempt=0;attempt<2;attempt++){
   try{let state=M.empty(),after=-1;
    for(let pages=0;pages<=Math.ceil(M.LIMITS.words/500);pages++){
     const r=await this.request('GET',null,'?mode=page&after='+after+(after===-1?'':'&revision='+state.revision));
     if(after===-1){state.revision=r.revision;state.tags=r.tags;if(r.structure)state.structure=r.structure;}state.words.push(...r.words);
     if(r.next===null)return M.validate(state);
     if(r.next<=after)throw new StorageError('分页读取异常。');after=r.next;
    }throw new StorageError('记录数量超出限制。');
   }catch(e){if(e.code!=='conflict'||attempt===1)throw e;}
  }
 }
 async load(){try{this.current=await this.read();this.blocked=false;return {data:M.clone(this.current),error:null};}catch(error){return {data:null,error:error.message,failure:error};}}
 async save(next,{action,payload,restore=false,review,expectedReviewRevision}={}){
  if(this.blocked)throw new StorageError('尚未连接云端，请重新读取账本。');
  const intent=JSON.stringify(restore?{action:'restore',backup:next,review,expectedReviewRevision}:{action,payload});
  if(this.pending&&this.pending.intent!==intent)throw new StorageError('上次保存尚未确认，请先重试或重新读取核对。','uncertain');
  if(!this.pending){
   const item=payload?.id?(action.includes('Tag')?this.current.tags:this.current.words).find(x=>x.id===payload.id):null;
   this.pending={intent,body:{action:restore?'restore':action,payload:restore?next:payload,expectedRevision:this.current.revision,recordVersion:item?.recordVersion??null,requestId:crypto.randomUUID(),...(review?{review,expectedReviewRevision}:{})}};
  }
  try{const result=await this.request('POST',this.pending.body,'?mode=delta');let saved;
   if(result.data)saved=M.validate(result.data);
   else if(result.action==='importTag'){saved=M.clone(this.current);saved.revision=result.revision;saved.tags.push(result.record.tag);saved.words.push(...result.record.words);saved=M.validate(saved);}
   else if(result.action==='setStructure'){saved=M.clone(this.current);saved.revision=result.revision;if(result.record)saved.structure=result.record;else delete saved.structure;saved=M.validate(saved);}
   else{saved=M.clone(this.current);saved.revision=result.revision;
    const tagAction=result.action.includes('Tag'),list=tagAction?'tags':'words';
    if(result.action.startsWith('delete')){saved[list]=saved[list].filter(x=>x.id!==result.id);if(tagAction)saved.words=saved.words.filter(x=>x.tagId!==result.id);}
    else if(result.action.startsWith('add'))saved[list].push(result.record);
    else saved[list]=saved[list].map(x=>x.id===result.id?result.record:x);
    saved=M.validate(saved);
   }
   this.reviewSaved=result.review||null;this.pending=null;this.current=saved;return M.clone(saved);
  }catch(error){if(!['network','cloud'].includes(error.code))this.pending=null;throw error;}
 }
}
window.LedgerCloud={Store,GuestStore,session,SessionGate,StorageError};
})();
