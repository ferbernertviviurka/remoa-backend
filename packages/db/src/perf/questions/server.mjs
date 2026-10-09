/** Loopback-only HTTP harness: synthetic auth sessions, actual application routes/DB/RLS. */
import {targetUrl,state,save} from './target.mjs';
process.env.DATABASE_URL=targetUrl();process.env.NODE_ENV='test';process.env.LOG_LEVEL='error';
process.env.SHARE_SECRET='synthetic-fr32-benchmark-cursor';
process.env.QUESTIONS_CATALOG_ENABLED='1';process.env.QUESTIONS_SESSIONS_ENABLED='1';process.env.QUESTIONS_IMPORT_ENABLED='0';
const {createApp}=await import('../../../../../apps/api/src/app.ts');
const {liveSession}=await import('../../../../../apps/api/src/auth-session.ts');
const {serve}=await import('../../../../../apps/api/node_modules/@hono/node-server/dist/index.mjs');
const users=new Map(state().users.map(u=>[u.id,u]));
const app=createApp({webOrigin:'http://127.0.0.1:43133',verifyToken:async(token,opts)=>{const u=users.get(token);if(!u)return null;if(opts?.defer)return{userId:u.id,sessionId:u.authSessionId,pending:true};const live=await liveSession(u.id,u.authSessionId);return live&&{userId:u.id,sessionId:u.authSessionId,account:live.account};}});
const port=43133;
const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port},()=>{save('server-ready.json',{pid:process.pid,port,synthetic:true,startedAt:new Date().toISOString()});process.stdout.write('FR32 synthetic HTTP harness listening loopback:43133\n');});
setInterval(()=>save('server-memory.json',{...process.memoryUsage(),at:new Date().toISOString()}),5000).unref();
for(const sig of['SIGTERM','SIGINT'])process.on(sig,()=>server.close(()=>process.exit(0)));
