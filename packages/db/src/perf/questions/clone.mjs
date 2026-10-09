/** Schema-only clone from an explicit F33 fixture. Never reads .env or copies user data. */
import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import postgres from 'postgres';
const sourceFile=process.env.F33_SOURCE_URL_FILE??'/private/tmp/remoa-f33-test-url';
const source=new URL(readFileSync(sourceFile,'utf8').trim());
if(!['127.0.0.1','localhost'].includes(source.hostname)||!source.pathname.includes('f33_test'))throw Error('isolated local source required');
const name='remoa_perf_f33_20261008';
const target=new URL(source);target.pathname='/'+name;
const outputFile=process.env.F33_PERF_URL_FILE??'/private/tmp/remoa-f33-perf-url';
const admin=postgres(source.toString(),{max:1,onnotice:()=>{}});
try{
 const [exists]=await admin`SELECT 1 FROM pg_database WHERE datname=${name}`;
 if(exists){const check=postgres(target.toString(),{max:1,onnotice:()=>{}});try{const [r]=await check`SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','auth','extensions') AND c.relkind IN ('r','v','m')`;if(r.n!==0)throw Error('target already populated; refusing replacement');}finally{await check.end();}}
 const childEnv={...process.env,PGHOST:source.hostname,PGPORT:source.port||'5432',PGUSER:decodeURIComponent(source.username),PGPASSWORD:decodeURIComponent(source.password),PGDATABASE:decodeURIComponent(source.pathname.slice(1))};
 const dump=spawnSync('/usr/local/bin/docker',['exec',process.env.F33_PGDUMP_CONTAINER??'supabase_db_remoa','pg_dump','-U',decodeURIComponent(source.username),'-d',decodeURIComponent(source.pathname.slice(1)),'--schema-only','--no-owner','--schema=public','--schema=auth','--schema=extensions'],{env:childEnv,maxBuffer:32*1024*1024});
 if(dump.status!==0){writeFileSync('/private/tmp/remoa-f33-perf-dump-errors',dump.stderr??Buffer.from(String(dump.error)),{mode:0o600});throw Error('schema-only dump failed');}
 if(!exists)await admin.unsafe('CREATE DATABASE "'+name+'"');
 const restore=spawnSync('/usr/local/bin/docker',['exec','-i',process.env.F33_PGDUMP_CONTAINER??'supabase_db_remoa','psql','-U',decodeURIComponent(source.username),'-d',name,'-X','--single-transaction','-v','ON_ERROR_STOP=1','-q'],{env:childEnv,input:'CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;\n'+dump.stdout.toString().replace(/^CREATE SCHEMA public;\n/m,''),maxBuffer:32*1024*1024});
 if(restore.status!==0){writeFileSync('/private/tmp/remoa-f33-perf-restore-errors',restore.stderr,{mode:0o600});throw Error('restore failed; isolated target retained for inspection');}
 writeFileSync(outputFile,target.toString()+'\n',{mode:0o600});
 process.stdout.write('Schema-only F33 perf clone prepared: '+name+'; no data copied\n');
}finally{await admin.end();}
