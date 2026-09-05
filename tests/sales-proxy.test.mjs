import {test} from 'node:test';
import assert from 'node:assert/strict';
import {proxySalesSession} from '../src/server/sales-proxy.mjs';
const cfg={edgeUrl:'https://project.supabase.co/functions/v1/sales-session',proxySecret:'a-private-proxy-secret',allowedOrigins:['https://preview.example'],networkIp:'192.0.2.18'};
function request(headers={}){return new Request('https://preview.example/api/sales-session',{method:'POST',headers:{origin:'https://preview.example','content-type':'application/json',authorization:'Bearer '+'a'.repeat(43),...headers},body:JSON.stringify({action:'status',session_id:'a'})});}
test('proxy discards forged forwarding and proxy headers and injects its trusted network',async()=>{
  let captured;
  const result=await proxySalesSession(request({'x-sales-network-ip':'1.2.3.4','x-sales-proxy-secret':'forged','x-forwarded-for':'1.2.3.4'}),cfg,async(_url,options)=>{captured=options;return Response.json({status:'ready'});});
  assert.equal(result.status,200);assert.equal(captured.headers['x-sales-network-ip'],'192.0.2.18');
  assert.equal(captured.headers['x-sales-proxy-secret'],'a-private-proxy-secret');
  assert.equal('x-forwarded-for' in captured.headers,false);
  assert.equal(result.headers.get('cache-control'),'no-store');
});
test('an untrusted origin or missing verified network cannot reach Edge',async()=>{
  let calls=0;const fetcher=async()=>{calls++;return Response.json({});};
  assert.equal((await proxySalesSession(request({origin:'https://attacker.example'}),cfg,fetcher)).status,403);
  assert.equal((await proxySalesSession(request(),{...cfg,networkIp:''},fetcher)).status,503);
  assert.equal(calls,0);
});
test('non-JSON and oversized bodies are refused before forwarding',async()=>{
  let calls=0;const fetcher=async()=>{calls++;return Response.json({});};
  assert.equal((await proxySalesSession(request({'content-type':'text/plain'}),cfg,fetcher)).status,415);
  const big=new Request('https://preview.example/api/sales-session',{method:'POST',headers:{origin:'https://preview.example','content-type':'application/json'},body:'x'.repeat(100000)});
  assert.equal((await proxySalesSession(big,cfg,fetcher)).status,413);assert.equal(calls,0);
});
test('provider errors do not expose exception details or private proxy secret',async()=>{
  const r=await proxySalesSession(request(),cfg,async()=>{throw new Error(cfg.proxySecret);});
  assert.equal(r.status,502);assert.equal((await r.text()).includes(cfg.proxySecret),false);
});
