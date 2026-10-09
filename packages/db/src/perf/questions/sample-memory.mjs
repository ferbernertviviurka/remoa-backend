/** Samples the private harness telemetry file; no HTTP request or DB connection. */
import {readFileSync,existsSync} from 'node:fs';
import {directory,save} from './target.mjs';
const samples=[],started=Date.now(),deadline=started+360000;
while(Date.now()<deadline){const sample=JSON.parse(readFileSync(directory+'server-memory.json','utf8'));if(samples.at(-1)?.at!==sample.at)samples.push(sample);save('memory-profile'+(process.env.F33_MEMORY_PHASE?'-'+process.env.F33_MEMORY_PHASE:'')+'.json',{synthetic:true,scope:'5-second harness snapshots; sampling began after load started, so this is a sampled maximum rather than an absolute peak',samples,maxRssBytes:Math.max(...samples.map(s=>s.rss)),maxHeapUsedBytes:Math.max(...samples.map(s=>s.heapUsed))});if(existsSync(directory+'load-results.json')&&Date.parse(JSON.parse(readFileSync(directory+'load-results.json')).finishedAt)>=started)break;await new Promise(r=>setTimeout(r,5000));}
