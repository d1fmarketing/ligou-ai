import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';

export async function runSalesPreDispatchCancellationSuite(env){
  if(env.PGHOST!=='127.0.0.1'||env.PGPORT!=='55439'||env.PGUSER!=='postgres'||env.PGDATABASE!=='postgres'||env.LIGOU_SALES_DISPOSABLE_TEST!=='yes')throw Error('sales pre-dispatch cancellation suite requires explicit disposable loopback PostgreSQL');
  const statements=await readFile(new URL('./sales-pre-dispatch-cancellation.sql',import.meta.url),'utf8');
  const result=await new Promise((resolve,reject)=>{
    const p=spawn(env.LIGOU_PSQL_BIN??'/opt/homebrew/opt/postgresql@16/bin/psql',['-XqAt','-v','ON_ERROR_STOP=1','-f','-'],{env:{...env,PGCONNECT_TIMEOUT:'5'},stdio:['pipe','pipe','pipe']});
    let output='',error='';p.stdout.on('data',d=>output+=d);p.stderr.on('data',d=>error+=d);p.on('error',reject);p.on('close',code=>code?reject(Error(error)):resolve(output.trim()));p.stdin.end(statements);
  });
  assert.equal(result,'sales_preflight_regression_passed');
  return {passed:1,scope:'sales-only PostgreSQL fixture; transaction rolled back'};
}
if(import.meta.main||process.argv[1]?.endsWith('local-sales-pre-dispatch-cancellation.mjs'))console.log(JSON.stringify(await runSalesPreDispatchCancellationSuite(process.env)));
