import {test, expect} from 'bun:test';
import {createSiteMotion} from '../src/runtime/site-motion.js';

function fixture({reduced=false, stored=false}={}) {
  const listeners={}, store=new Map(stored?[['ligou-motion-paused','1']]:[]), media={matches:reduced,addEventListener(_e,fn){this.change=fn},removeEventListener(){}};
  const label={textContent:'Pausar animações'}, button={disabled:false,setAttribute(k,v){this[k]=v},querySelector(){return label}};
  const video={isConnected:true,playing:false,play(){this.playing=true;return Promise.resolve()},pause(){this.playing=false},getBoundingClientRect(){return {top:0,bottom:300,left:0,right:600}}};
  const section=(className,visible=true)=>({className,isConnected:true,visible,classes:new Set(),classList:{toggle(name,on){if(on)this.owner.classes.add(name);else this.owner.classes.delete(name)}},getBoundingClientRect(){return this.visible?{top:20,bottom:100,left:0,right:200}:{top:900,bottom:1000,left:0,right:200}}});
  const sections=[section('wavedraw',false),section('capabilities'),section('p7-wf',false)];
  for(const item of sections)item.classList.owner=item;
  let observer;
  const observed=new Set(),unobserved=new Set();
  class Observer{constructor(fn){this.fn=fn;observer=this}observe(node){observed.add(node)}unobserve(node){observed.delete(node);unobserved.add(node)}disconnect(){observed.clear()}}
  const doc={hidden:false,body:{},documentElement:{dataset:{}},querySelectorAll(s){return s==='[data-motion-toggle]'?[button]:s==='.hero4 video'?[video]:sections.filter(item=>item.isConnected&&s.split(',').includes('.'+item.className))},addEventListener(k,fn){listeners[k]=fn},removeEventListener(k){delete listeners[k]}};
  const win={innerWidth:1000,innerHeight:800,matchMedia:()=>media,localStorage:{getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)}};
  const controller=createSiteMotion({window:win,document:doc,IntersectionObserver:Observer});
  return {controller,video,doc,button,label,media,observer,listeners,sections,section,observed,unobserved,click:()=>listeners.click({target:{closest:()=>button}})};
}
test('manual pause persists, resumes only visible video, and does not control voice audio',()=>{
  const f=fixture();expect(f.video.playing).toBe(true);f.click();expect(f.video.playing).toBe(false);expect(f.button['aria-pressed']).toBe('true');expect(f.label.textContent).toBe('Retomar animações');
  f.observer.fn([{target:f.video,isIntersecting:false}]);f.click();expect(f.video.playing).toBe(false);
  f.observer.fn([{target:f.video,isIntersecting:true}]);expect(f.video.playing).toBe(true);f.controller.destroy();expect(f.listeners.click).toBeUndefined();
});
test('background tab and reduced-motion preference stop video playback',()=>{
  const f=fixture();expect(f.doc.documentElement.dataset.ligouVisibility).toBe('visible');
  f.doc.hidden=true;f.listeners.visibilitychange();expect(f.video.playing).toBe(false);expect(f.doc.documentElement.dataset.ligouVisibility).toBe('hidden');
  expect(f.doc.documentElement.dataset.ligouMotion).toBe('playing');expect(f.controller.isPaused()).toBe(false);expect(f.label.textContent).toBe('Pausar animações');
  f.doc.hidden=false;f.listeners.visibilitychange();expect(f.video.playing).toBe(true);expect(f.doc.documentElement.dataset.ligouVisibility).toBe('visible');
  f.media.matches=true;f.media.change();expect(f.video.playing).toBe(false);expect(f.button.disabled).toBe(true);f.click();expect(f.controller.isPaused()).toBe(true);
});
test('stored pause applies to the first video and replacement media',()=>{
  const f=fixture({stored:true});expect(f.video.playing).toBe(false);f.video.playing=true;f.controller.refresh();expect(f.video.playing).toBe(false);
});
test('divider, capabilities and header waveform pause outside the viewport and replacement nodes are observed',()=>{
  const f=fixture(),[divider,capabilities,waveform]=f.sections;
  for(const section of f.sections)expect(f.observed.has(section)).toBe(true);
  expect(divider.classes.has('motion-outside')).toBe(true);expect(waveform.classes.has('motion-outside')).toBe(true);
  expect(capabilities.classes.has('motion-outside')).toBe(false);
  f.observer.fn([{target:divider,isIntersecting:true},{target:waveform,isIntersecting:true},{target:capabilities,isIntersecting:false}]);
  expect(divider.classes.has('motion-outside')).toBe(false);expect(waveform.classes.has('motion-outside')).toBe(false);expect(capabilities.classes.has('motion-outside')).toBe(true);
  waveform.isConnected=false;const replacement=f.section('p7-wf');replacement.classList.owner=replacement;f.sections.push(replacement);f.controller.refresh();
  expect(f.unobserved.has(waveform)).toBe(true);expect(f.observed.has(replacement)).toBe(true);
  f.controller.destroy();expect(f.observed.size).toBe(0);
});
test('returning to a visible document does not override the user motion preference',()=>{
  const f=fixture();f.click();f.doc.hidden=true;f.listeners.visibilitychange();f.doc.hidden=false;f.listeners.visibilitychange();
  expect(f.doc.documentElement.dataset.ligouVisibility).toBe('visible');expect(f.doc.documentElement.dataset.ligouMotion).toBe('paused');
  expect(f.controller.isPaused()).toBe(true);expect(f.video.playing).toBe(false);expect(f.label.textContent).toBe('Retomar animações');
});
