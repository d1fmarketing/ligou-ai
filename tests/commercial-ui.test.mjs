import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createHookRuntime,createElement,findAll,textContent} from './helpers/runtime-harness.mjs';
const identity={user:{id:'operator',email:'operator@example.test'}};
async function harness({initial=null,failInit=false,auth={},leads=[],transcriptError=false}={}) {
  const hooks=createHookRuntime();let onAuth;
  const client={auth:{getSession:async()=>({data:{session:initial},error:null}),onAuthStateChange(fn){onAuth=fn;return{data:{subscription:{unsubscribe(){}}}}},signInWithOAuth:async()=>({error:null}),signOut:async()=>({error:null}),...auth}};
  const context={console,URL,React:{Fragment:Symbol('Fragment'),createElement,useState:hooks.useState,useEffect:hooks.useEffect,useRef:hooks.useRef},ReactDOM:{createRoot(){return{render(){}}}},window:{LIGOU_PUBLIC_CONFIG:{supabaseUrl:'https://fixture.supabase.co',supabaseKey:'public-fixture'},location:{origin:'https://fixture.example'}},document:{getElementById(){return{}}},createClient(){if(failInit)throw Error('storage blocked');return client;},browserCustodyStorage(){return{}},stripProviderFields:x=>x,loadSalesLeads:async()=>leads,loadSalesTranscript:async()=>{if(transcriptError)throw Error('Não foi possível carregar a conversa.');return[];}};
  context.globalThis=context;
  const source=(await readFile(new URL('../src/commercial/commercial.jsx',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'')+'\nglobalThis.TestApp=App;';
  vm.runInNewContext(new Bun.Transpiler({loader:'jsx',tsconfig:{compilerOptions:{jsx:'react'}}}).transformSync(source),context);
  const render=()=>hooks.render(context.TestApp);
  const flush=async()=>{let tree;for(let i=0;i<6;i++){await new Promise(resolve=>setImmediate(resolve));tree=render();}return tree;};
  return{render,flush,authEvent:value=>onAuth('SIGNED_IN',value),close:hooks.unmount};
}
const button=(tree,label)=>findAll(tree,n=>n.type==='button'&&textContent(n)===label)[0];

test('commercial initialization failure renders an actionable page instead of blank output',async()=>{
  const h=await harness({failInit:true});expect(textContent(h.render())).toContain('armazenamento');h.close();
});
test('OAuth rejection releases the login button and shows a retryable error',async()=>{
  const h=await harness({auth:{signInWithOAuth:async()=>{throw Error('offline')}}});h.render();let tree=await h.flush();
  await button(tree,'Entrar com Google').props.onClick();tree=await h.flush();
  expect(button(tree,'Entrar com Google').props.disabled).toBe(false);
  expect(textContent(tree)).toContain('Não foi possível iniciar o login');h.close();
});
test('a rejected session lookup leaves a usable login page',async()=>{
  const h=await harness({auth:{getSession:async()=>{throw Error('storage inaccessible')}}});h.render();const tree=await h.flush();
  expect(textContent(tree)).toContain('Não foi possível recuperar a sessão');expect(button(tree,'Entrar com Google')).toBeDefined();h.close();
});
test('a late initial session cannot replace a newer sign-in event',async()=>{
  let finish;const h=await harness({auth:{getSession:()=>new Promise(resolve=>{finish=resolve;})}});h.render();await h.flush();
  h.authEvent(identity);await h.flush();finish({data:{session:null},error:null});const tree=await h.flush();
  expect(button(tree,'Sair')).toBeDefined();expect(textContent(tree)).toContain('operator@example.test');h.close();
});
test('commercial signout is local and a failed signout is reported',async()=>{
  let options;const h=await harness({initial:identity,auth:{signOut:async value=>{options=value;return{error:{message:'offline'}};}}});h.render();let tree=await h.flush();
  await button(tree,'Sair').props.onClick();tree=await h.flush();
  expect(options).toEqual({scope:'local'});expect(textContent(tree)).toContain('Não foi possível sair');h.close();
});
test('transcript read failure never claims that the conversation has no transcript',async()=>{
  const h=await harness({initial:identity,leads:[{id:'lead',company:'QA',name:'Teste'}],transcriptError:true});h.render();const tree=await h.flush();
  expect(textContent(tree)).toContain('Não foi possível carregar a conversa');
  expect(textContent(tree)).not.toContain('Não há transcrição disponível');h.close();
});
