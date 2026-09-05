import {test, expect} from 'bun:test';
import {createSiteMotion} from '../src/runtime/site-motion.js';

function fixture({reduced=false, stored=false}={}) {
  const listeners={}, store=new Map(stored?[['ligou-motion-paused','1']]:[]), media={matches:reduced,addEventListener(_e,fn){this.change=fn},removeEventListener(){}};
  const storageAccess={reads:0,writes:0},queries=[];
  const voice={playCalls:0,pauseCalls:0,play(){this.playCalls++;return Promise.resolve()},pause(){this.pauseCalls++}};
  const video={isConnected:true,playing:false,play(){this.playing=true;return Promise.resolve()},pause(){this.playing=false},getBoundingClientRect(){return {top:0,bottom:300,left:0,right:600}}};
  const heroVideos=[video];
  const section=(className,visible=true)=>({className,isConnected:true,visible,classes:new Set(),classList:{toggle(name,on){if(on)this.owner.classes.add(name);else this.owner.classes.delete(name)}},getBoundingClientRect(){return this.visible?{top:20,bottom:100,left:0,right:200}:{top:900,bottom:1000,left:0,right:200}}});
  const sections=[section('wavedraw',false),section('capabilities'),section('p7-wf',false),section('lc-wf',false)];
  for(const item of sections)item.classList.owner=item;
  let observer;
  const observed=new Set(),unobserved=new Set();
  class Observer{constructor(fn){this.fn=fn;observer=this}observe(node){observed.add(node)}unobserve(node){observed.delete(node);unobserved.add(node)}disconnect(){observed.clear()}}
  const doc={hidden:false,body:{},documentElement:{dataset:{}},querySelectorAll(s){queries.push(s);return s==='.hero4 video'?heroVideos.filter(item=>item.isConnected):['video','audio','.sales-demo audio'].includes(s)?[voice]:sections.filter(item=>item.isConnected&&s.split(',').includes('.'+item.className))},addEventListener(k,fn){listeners[k]=fn},removeEventListener(k){delete listeners[k]}};
  const win={innerWidth:1000,innerHeight:800,matchMedia:()=>media,localStorage:{getItem(k){storageAccess.reads++;return store.get(k)},setItem(k,v){storageAccess.writes++;store.set(k,v)}}};
  const controller=createSiteMotion({window:win,document:doc,IntersectionObserver:Observer});
  return {controller,video,heroVideos,voice,queries,store,storageAccess,doc,media,observer,listeners,sections,section,observed,unobserved};
}
test('automatic visibility resumes only hero videos and never controls voice or registers a toggle',()=>{
  const f=fixture();expect(f.video.playing).toBe(true);expect(f.listeners.click).toBeUndefined();
  f.observer.fn([{target:f.video,isIntersecting:false}]);expect(f.video.playing).toBe(false);
  f.observer.fn([{target:f.video,isIntersecting:true}]);expect(f.video.playing).toBe(true);
  f.doc.hidden=true;f.listeners.visibilitychange();expect(f.video.playing).toBe(false);
  expect(f.voice.playCalls).toBe(0);expect(f.voice.pauseCalls).toBe(0);expect(f.queries).toContain('.hero4 video');
  expect(f.queries).not.toContain('[data-motion-toggle]');expect(f.queries).not.toContain('video');expect(f.queries).not.toContain('audio');
  f.controller.destroy();expect(f.listeners.visibilitychange).toBeUndefined();
});
test('background tab and reduced-motion preference stop video playback',()=>{
  const f=fixture();expect(f.doc.documentElement.dataset.ligouVisibility).toBe('visible');
  f.doc.hidden=true;f.listeners.visibilitychange();expect(f.video.playing).toBe(false);expect(f.doc.documentElement.dataset.ligouVisibility).toBe('hidden');
  expect(f.doc.documentElement.dataset.ligouMotion).toBe('playing');expect(f.controller.isPaused()).toBe(false);
  f.doc.hidden=false;f.listeners.visibilitychange();expect(f.video.playing).toBe(true);expect(f.doc.documentElement.dataset.ligouVisibility).toBe('visible');
  f.media.matches=true;f.media.change();expect(f.video.playing).toBe(false);expect(f.controller.isPaused()).toBe(true);expect(f.doc.documentElement.dataset.ligouMotion).toBe('paused');
  f.observer.fn([{target:f.video,isIntersecting:false}]);f.media.matches=false;f.media.change();expect(f.controller.isPaused()).toBe(false);expect(f.video.playing).toBe(false);
  f.observer.fn([{target:f.video,isIntersecting:true}]);expect(f.video.playing).toBe(true);
});
test('old stored manual pause is ignored for initial and replacement hero media',()=>{
  const f=fixture({stored:true});expect(f.video.playing).toBe(true);expect(f.controller.isPaused()).toBe(false);expect(f.doc.documentElement.dataset.ligouMotion).toBe('playing');
  f.video.isConnected=false;const replacement={...f.video,isConnected:true,playing:false};f.heroVideos.push(replacement);f.controller.refresh();
  expect(replacement.playing).toBe(true);expect(f.unobserved.has(f.video)).toBe(true);expect(f.observed.has(replacement)).toBe(true);
  expect(f.storageAccess).toEqual({reads:0,writes:0});expect(f.store.get('ligou-motion-paused')).toBe('1');
});
test('divider, capabilities and both header waveforms pause outside the viewport and replacement nodes are observed',()=>{
  const f=fixture(),[divider,capabilities,waveform,mobileWaveform]=f.sections;
  for(const section of f.sections)expect(f.observed.has(section)).toBe(true);
  expect(divider.classes.has('motion-outside')).toBe(true);expect(waveform.classes.has('motion-outside')).toBe(true);
  expect(mobileWaveform.classes.has('motion-outside')).toBe(true);
  expect(capabilities.classes.has('motion-outside')).toBe(false);
  f.observer.fn([{target:divider,isIntersecting:true},{target:waveform,isIntersecting:true},{target:mobileWaveform,isIntersecting:true},{target:capabilities,isIntersecting:false}]);
  expect(divider.classes.has('motion-outside')).toBe(false);expect(waveform.classes.has('motion-outside')).toBe(false);expect(capabilities.classes.has('motion-outside')).toBe(true);
  expect(mobileWaveform.classes.has('motion-outside')).toBe(false);
  waveform.isConnected=false;const replacement=f.section('p7-wf');replacement.classList.owner=replacement;f.sections.push(replacement);f.controller.refresh();
  expect(f.unobserved.has(waveform)).toBe(true);expect(f.observed.has(replacement)).toBe(true);
  f.controller.destroy();expect(f.observed.size).toBe(0);
});
test('returning to a visible document still respects the operating system reduced-motion setting',()=>{
  const f=fixture({reduced:true,stored:true});expect(f.video.playing).toBe(false);f.doc.hidden=true;f.listeners.visibilitychange();f.doc.hidden=false;f.listeners.visibilitychange();
  expect(f.doc.documentElement.dataset.ligouVisibility).toBe('visible');expect(f.doc.documentElement.dataset.ligouMotion).toBe('paused');
  expect(f.controller.isPaused()).toBe(true);expect(f.video.playing).toBe(false);
  f.media.matches=false;f.media.change();expect(f.doc.documentElement.dataset.ligouMotion).toBe('playing');expect(f.video.playing).toBe(true);
});
