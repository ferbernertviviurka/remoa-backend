/** F34/G27 phase 5 loopback load: student bank + exam builder routes. 20 VUs closed loop, 30 s warm-up + 300 s measured. Env F33_PERF_DB=remoa_f33_bench. */
import {randomUUID} from 'node:crypto';
import {loadavg} from 'node:os';
import {state,save,port} from './target.mjs';
const seeded=state(),base=`http://127.0.0.1:${port}/v1`,duration=Number(process.env.F34_DURATION_MS??300000),warmup=Number(process.env.F34_WARMUP_MS??30000);
// targets: G26 (list/search 500, resume/answer 400); the rest are PROPOSED by this phase (no SLO exists yet).
const targets={list:500,facets:500,availability:500,preview40:500,preview100:600,swap:500,drawer:400,resume:400,answer:400,builderStart:600,builderFinish:400};
const operations=Object.keys(targets),continuous=operations.filter(n=>!n.startsWith("builder")&&(!process.env.F34_OPS||process.env.F34_OPS.split(",").includes(n)));
const samples=Object.fromEntries(operations.map(n=>[n,[]])),failures=[];
const summary=v=>{const s=[...v].sort((a,b)=>a-b),p=q=>s[Math.max(0,Math.ceil(s.length*q)-1)]??null;return{count:s.length,p50Ms:p(.5),p95Ms:p(.95),p99Ms:p(.99),maxMs:s.at(-1)??null};};
const A=seeded.area;
const params=count=>({count,mode:'study',source:'catalog',areaIds:[A],difficulties:['medium','easy','hard'],progress:'all',distribution:'balanced'});
import {createHash} from 'node:crypto';
const md5uuid=s=>{const h=createHash('md5').update(s).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;};
async function call(u,name,method,path,body,extra={}){
 const t0=performance.now();let res,payload,text;
 res=await fetch(base+path,{method,headers:{authorization:'Bearer '+u.id,...(body?{'content-type':'application/json'}:{}),...extra},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});
 text=await res.text();payload=JSON.parse(text);return{res,payload,text,ms:performance.now()-t0};
}
async function request(u,name,record){
 let r,ok=200;
 try{
  const rec=(extra={})=>record&&samples[name].push({ms:r.ms,bytes:Buffer.byteLength(r.text),queries:Number(r.res.headers.get('x-remoa-queries')),...extra});
  const S='scope=catalog&sourceId='+seeded.source;
  if(name==='list'){const sorts=['recent','difficulty','topic'];u.n=(u.n??0)+1;r=await call(u,name,'GET',`/questions?${S}&areaIds=${A}&difficulties=easy&difficulties=medium&institutions=Synthetic&sort=${sorts[u.n%3]}&limit=25`);if(r.payload.data?.items?.some(q=>'correctKey'in q||'explanation'in q))throw Error('reference_leak');}
  else if(name==='facets')r=await call(u,name,'GET',`/questions/facets?${S}&areaIds=${A}&difficulties=easy&difficulties=medium&groups=area,topic,institution,year,difficulty`);
  else if(name==='availability')r=await call(u,name,'POST','/exam-builder/availability',{source:'catalog',areaIds:[A],difficulties:['easy','medium'],progress:'all'});
  else if(name==='preview40'||name==='preview100')r=await call(u,name,'POST','/exam-builder/preview',{params:params(name==='preview40'?40:100)});
  else if(name==='swap'){const p=await call(u,name,'POST','/exam-builder/preview',{params:params(40)});const items=p.payload.data.items;r=await call(u,name,'POST','/exam-builder/swap',{params:params(40),seed:p.payload.data.seed,questionId:items[0].questionId,currentIds:items.map(i=>i.questionId)});}
  else if(name==='drawer'){const g=1+u.index*2000+(u.drawerCounter++%2000);r=await call(u,name,'POST','/questions/'+md5uuid('f33-perf-q-'+g)+'/answer',{selectedKey:'B',mutationId:randomUUID(),elapsedMs:1500});}
  else if(name==='resume'){r=await call(u,name,'GET','/question-sessions/'+u.activeSessionId);if(r.res.status===200&&r.payload.data.items.length!==200)throw Error('resume_count');}
  else if(name==='answer'){r=await call(u,name,'PUT','/question-sessions/'+u.activeSessionId+'/items/'+u.itemId+'/answer',{selectedKey:u.revision%2?'B':'A',revision:u.revision,mutationId:randomUUID(),elapsedMs:1000});if(r.res.status===200)u.revision=r.payload.data.revision;}
  else if(name==='builderStart'){ // preview -> start -> finish (settles; one active builder session per user). Preview not recorded here.
   const p=await call(u,'x','POST','/exam-builder/preview',{params:params(40)});const ids=p.payload.data.items.map(i=>i.questionId),pr=params(40);
   r=await call(u,name,'POST','/question-sessions',{mode:'study',questionIds:ids,count:ids.length,timerSec:null,shuffle:false,builder:{seed:p.payload.data.seed,params:pr,templateId:null}},{'idempotency-key':randomUUID()});
   if(r.res.status!==200)throw Error('HTTP_'+r.res.status+'_'+(r.payload.error?.code??'unknown'));rec();
   const f=await call(u,'builderFinish','POST','/question-sessions/'+r.payload.data.id+'/finish',{});r=f;name='builderFinish';
  }
  if(r.res.status!==ok)throw Error('HTTP_'+r.res.status+'_'+(r.payload.error?.code??'unknown'));
  rec();
 }catch(e){if(record)failures.push({name,status:r?.res.status??null,code:String(e.message).slice(0,80)});}
}
async function runFor(ms,record){const started=performance.now(),deadline=started+ms;await Promise.all(seeded.users.map(async(u,i)=>{u.index=i;u.drawerCounter=u.drawerCounter??0;let seq=i,built=0;while(performance.now()<deadline){if(record&&built<5&&performance.now()>=started+built*60000){built++;await request(u,'builderStart',true);}else await request(u,continuous[seq++%continuous.length],record);}}));}
for(const u of seeded.users){const r=await fetch(base+'/question-sessions/'+u.activeSessionId,{headers:{authorization:'Bearer '+u.id}});const p=await r.json();if(r.status!==200)throw Error('harness readiness failed '+r.status);u.revision=p.data.items[0].revision;}
const loadStart=loadavg();process.stdout.write('F34 warm-up '+new Date().toISOString()+' load '+loadStart+'\n');await runFor(warmup,false);
const startedAt=new Date().toISOString();const t0=performance.now();await runFor(duration,true);
const loadEnd=loadavg();
const metrics=Object.fromEntries(operations.map(n=>{const v=samples[n],l=summary(v.map(s=>s.ms)),qs=v.map(s=>s.queries);return[n,{...l,p95Bytes:summary(v.map(s=>s.bytes)).p95Ms,maxQueries:Math.max(0,...qs),queryHistogram:qs.reduce((a,q)=>(a[q]=(a[q]??0)+1,a),{}),targetP95Ms:targets[n],pass:l.p95Ms!==null&&l.p95Ms<=targets[n]}];}));
const total=operations.reduce((s,n)=>s+samples[n].length,0);
const result={synthetic:true,startedAt,elapsedMs:Math.round(performance.now()-t0),vus:20,warmupMs:warmup,durationMs:duration,hostLoadAvgBefore:loadStart,hostLoadAvgAfter:loadEnd,requests:total,errorRate:failures.length/(total+failures.length),failureCount:failures.length,failures:failures.slice(0,50),metrics,note:'seed has 1 area/1 topic; sessions resume/answer use seeded 200-item simulations; builder start+finish back to back x5/VU'};
save(process.env.F34_OPS?"load-f34-light-results.json":"load-f34-results.json",result);process.stdout.write(JSON.stringify(result)+'\n');
