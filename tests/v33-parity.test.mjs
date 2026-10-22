import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
const root=new URL('../',import.meta.url),file=p=>fs.readFileSync(new URL(p,root)),json=p=>JSON.parse(file(p));
const manifest=json('web-source/SOURCE_MANIFEST.json');
const hash=(b,kind)=>crypto.createHash('sha256').update(kind==='utf8-lf'?b.toString('utf8').replace(/\r\n/g,'\n'):b).digest('hex');
test('standalone source is exactly pinned v33; generated adapter preserves all unpatched assets',()=>{
 assert.equal(manifest.gitSha,'7abd627af0798821eb37f982ce0e439954af365b');assert.equal(manifest.siteVersion,33);
 const adapted=new Set(['ledger.html','js/app.js','js/official-ui.js','js/review-ui.js']);
 for(const f of manifest.files){assert.equal(hash(file('web-source/'+f.path),f.kind),f.sha256,f.path);if(!adapted.has(f.path))assert.equal(hash(file('www/'+f.path),f.kind),f.sha256,f.path);}
 assert.match(file('android/app/build.gradle').toString(),/versionCode 5/);assert.match(file('android/app/build.gradle').toString(),/versionName "1\.3\.0"/);
 assert.equal(json('capacitor.config.json').appId,'site.chatgpt.rongyu1104.cetledger');
 assert.match(file('src/android-offline.js').toString(),/cet_vocabulary_ledger_offline_v1/);
});
test('all official v33 bilingual spans, true source identities and copied examples survive offline packaging',()=>{
 const ctx={TextEncoder};vm.runInNewContext(file('www/js/official.js').toString(),ctx);const O=ctx.LedgerOfficial;
 let count=0,real=0,original=0,totalCopied=0;
 for(const book of json('www/official/catalog.json').ledgers){
  const entries=book.chunks.flatMap(p=>json('www/official/'+p).entries);const n=O.normalizeEntries(entries,book.id),copy=O.toWords(n.entries);assert.equal(n.skipped,0);assert.equal(copy.clipped,0);totalCopied+=copy.words.length;
  const byWord=new Map(copy.words.map(w=>[w.english.toLowerCase(),w]));
  for(const e of entries){count++;const w=byWord.get(e.english.toLowerCase());assert.ok(w.meaning.includes(e.meaning));assert.ok(w.exampleSentence.includes(e.examples[0].en));assert.ok(w.exampleTranslation.includes(e.examples[0].zh));
   assert.match(e.examples[0].en,/\*\*[^*]+\*\*/);assert.match(e.examples[0].zh,/\*\*[^*]+\*\*/);assert.doesNotMatch(e.note,/角标|编辑判断|编辑判读|PDF 第|原行 /);
   if(e.provenance.sourceEvidence){real++;const s=e.provenance.sourceEvidence;assert.match(s.pdfSha256,/^[a-f0-9]{64}$/);assert.equal(e.source,(s.examLevel==='CET-4'?'四级':'六级')+'·'+s.yearMonth.slice(0,4)+'年'+Number(s.yearMonth.slice(5))+'月·第'+s.setNo+'套');}else{original++;assert.equal(e.source,'原创');}
  }
 }
 assert.deepEqual({count,real,original,totalCopied},{count:9567,real:5080,original:4487,totalCopied:9399});
});
test('actual fixed curve, exclusive tiers and UTC boundaries use bundled v33 code',()=>{
 const c={Date,Map,Set,setTimeout,clearTimeout};c.globalThis=c;for(const f of ['curve.js','review.js'])vm.runInNewContext(file('www/js/'+f).toString(),c);const C=c.LedgerCurve,R=c.LedgerReview;
 const word={id:'qa',mastered:false};let at=Date.parse('2026-10-22T09:00:00Z'),card=null;
 assert.equal(R.stage(word,card),'fresh');
 for(const interval of [1,2,3,5,7,7]){card=C.apply(card,{wordId:'qa',grade:3,at,day:R.dayKey(at),tz:0});assert.equal(C.dayDiff(at,card.due),interval);assert.equal(R.stage(word,card),interval<7?'memorizing':'consolidating');at=card.due;}
 assert.equal(R.stage({...word,mastered:true},card),'mastered');
 for(let utcOffsetMinutes=-720;utcOffsetMinutes<=840;utcOffsetMinutes+=15){const s={utcOffsetMinutes},t=Date.parse('2026-10-22T16:00:00Z'),start=R.statisticsStart(t,s);assert.equal(R.statisticsDay(start-1,s),C.addDays(R.statisticsDay(start,s),-1));assert.equal(R.untilReset(start,s),86400000);assert.equal(R.statisticsEnd(t,s)-start,86400000);}
});
