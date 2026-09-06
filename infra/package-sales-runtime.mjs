import {execFileSync} from 'node:child_process';
import {readFile,mkdir,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=process.argv[2];if(!output||!path.isAbsolute(output))throw Error('absolute package output directory required');
const status=execFileSync('git',['status','--porcelain=v1','--untracked-files=no'],{cwd:root,encoding:'utf8'});
if(status.trim())throw Error('sales package requires committed tracked source');
const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const scratch=await mkdtemp(path.join(tmpdir(),'ligou-sales-package-'));
try{
  const bodies=[];
  for(const n of [1,2]){
    const outdir=path.join(scratch,String(n));
    const result=await Bun.build({entrypoints:[path.join(root,'voice-controller/src/sales/server.ts')],outdir,target:'bun',format:'esm',naming:'server.js',minify:false});
    if(!result.success)throw Error(result.logs.join('\n'));
    if(result.outputs.length!==1)throw Error('sales package must be standalone');
    bodies.push(await readFile(path.join(outdir,'server.js')));
  }
  if(!bodies[0].equals(bodies[1]))throw Error('independent sales builds differ');
  await mkdir(output,{recursive:true});
  await writeFile(path.join(output,'server.js'),bodies[0]);
  const unit=await readFile(path.join(root,'infra/ligou-sales.service'));
  await writeFile(path.join(output,'ligou-sales.service'),unit);
  const manifest={kind:'ligou-sales-sidecar-v1',commit,bun:Bun.version,sha256:createHash('sha256').update(bodies[0]).digest('hex'),bytes:bodies[0].length,unit_sha256:createHash('sha256').update(unit).digest('hex'),independent_builds_equal:true};
  await writeFile(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  console.log(JSON.stringify(manifest));
}finally{await rm(scratch,{recursive:true,force:true});}
