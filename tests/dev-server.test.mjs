import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,mkdir,copyFile,symlink,rm} from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
const project=fileURLToPath(new URL('../',import.meta.url));

async function withPreview(run) {
  const scratch=await mkdtemp(path.join(os.tmpdir(),'ligou-preview-test-')),root=path.join(scratch,'site');
  let child;
  try {
    await mkdir(path.join(root,'src/server'),{recursive:true});await mkdir(path.join(root,'assets'));
    await mkdir(path.join(root,'scripts'));
    for(const name of ['dev-server.mjs','src/server/sales-proxy.mjs','scripts/public-site-config.mjs'])await copyFile(path.join(project,name),path.join(root,name));
    await writeFile(path.join(root,'index.html'),'<h1>Preview fixture</h1>');
    await writeFile(path.join(root,'assets/sample.txt'),'0123456789');
    await writeFile(path.join(root,'.env'),'private-fixture');
    await writeFile(path.join(scratch,'outside.txt'),'outside-fixture');
    await symlink(path.join(scratch,'outside.txt'),path.join(root,'assets/escape.txt'));
    await symlink(path.join(root,'.env'),path.join(root,'assets/private.txt'));
    await symlink(path.join(root,'src/server/sales-proxy.mjs'),path.join(root,'assets/source.txt'));
    const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
    const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
    child=spawn(process.execPath,[path.join(root,'dev-server.mjs')],{cwd:root,env:{PATH:process.env.PATH,LIGOU_PREVIEW_PORT:String(port)},stdio:['ignore','pipe','pipe']});
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('preview_start_timeout')),5000);
      child.stdout.on('data',data=>{if(String(data).includes('Ligou preview:')){clearTimeout(timer);resolve();}});
      child.once('exit',code=>{clearTimeout(timer);reject(Error(`preview exited ${code}`));});
      child.stderr.on('data',()=>{});
    });
    const request=(requestPath,headers={},method='GET')=>new Promise((resolve,reject)=>{
      const req=http.request({hostname:'127.0.0.1',port,path:requestPath,method,headers},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));});
      req.setTimeout(3000,()=>req.destroy(Error('request_timeout')));req.on('error',reject);req.end();
    });
    await run(request);
  }finally {
    if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}
    await rm(scratch,{recursive:true,force:true});
  }
}

test('malformed URI returns 400 and does not kill the preview',()=>withPreview(async request=>{
  assert.equal((await request('/%ZZ')).status,400);
  assert.equal((await request('/')).status,200);
}));
test('private paths and symlinks escaping the preview root are not served',()=>withPreview(async request=>{
  for(const p of ['/.env','/%2eenv','/assets/escape.txt','/assets/private.txt','/assets/source.txt','/src/server/sales-proxy.mjs'])assert.equal((await request(p)).status,404,p);
}));
test('public pages and video-style byte ranges retain their normal behavior',()=>withPreview(async request=>{
  assert.match((await request('/')).body,/Preview fixture/);
  const ranged=await request('/assets/sample.txt',{range:'bytes=2-5'});
  assert.equal(ranged.status,206);assert.equal(ranged.body,'2345');
  assert.equal((await request('/assets/sample.txt',{},'HEAD')).body,'');
  assert.equal((await request('/assets/sample.txt',{range:'bytes=99-100'})).status,416);
}));
test('untrusted hosts and static mutations are rejected',()=>withPreview(async request=>{
  assert.equal((await request('/',{Host:'attacker.example'})).status,403);
  assert.equal((await request('/',{},'POST')).status,405);
  assert.equal((await request('/%00')).status,400);
}));
