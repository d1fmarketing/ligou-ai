import {test, expect} from 'bun:test';
import {createSiteMotion} from '../src/runtime/site-motion.js';

function fixture({reduced=false, stored=false}={}) {
  const listeners={}, store=new Map(stored?[['ligou-motion-paused','1']]:[]), media={matches:reduced,addEventListener(_e,fn){this.change=fn},removeEventListener(){}};
  const label={textContent:'Pausar animações'}, button={disabled:false,setAttribute(k,v){this[k]=v},querySelector(){return label}};
  const video={isConnected:true,playing:false,play(){this.playing=true;return Promise.resolve()},pause(){this.playing=false},getBoundingClientRect(){return {top:0,bottom:300,left:0,right:600}}};
  let observer;
  class Observer{constructor(fn){this.fn=fn;observer=this}observe(){}unobserve(){}disconnect(){}}
  const doc={hidden:false,body:{},documentElement:{dataset:{}},querySelectorAll(s){return s==='[data-motion-toggle]'?[button]:s==='.hero4 video'?[video]:[]},addEventListener(k,fn){listeners[k]=fn},removeEventListener(k){delete listeners[k]}};
  const win={innerWidth:1000,innerHeight:800,matchMedia:()=>media,localStorage:{getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)}};
  const controller=createSiteMotion({window:win,document:doc,IntersectionObserver:Observer});
  return {controller,video,doc,button,label,media,observer,listeners,click:()=>listeners.click({target:{closest:()=>button}})};
}
test('manual pause persists, resumes only visible video, and does not control voice audio',()=>{
  const f=fixture();expect(f.video.playing).toBe(true);f.click();expect(f.video.playing).toBe(false);expect(f.button['aria-pressed']).toBe('true');expect(f.label.textContent).toBe('Retomar animações');
  f.observer.fn([{target:f.video,isIntersecting:false}]);f.click();expect(f.video.playing).toBe(false);
  f.observer.fn([{target:f.video,isIntersecting:true}]);expect(f.video.playing).toBe(true);f.controller.destroy();expect(f.listeners.click).toBeUndefined();
});
test('background tab and reduced-motion preference stop video playback',()=>{
  const f=fixture();f.doc.hidden=true;f.listeners.visibilitychange();expect(f.video.playing).toBe(false);f.doc.hidden=false;f.listeners.visibilitychange();expect(f.video.playing).toBe(true);
  f.media.matches=true;f.media.change();expect(f.video.playing).toBe(false);expect(f.button.disabled).toBe(true);f.click();expect(f.controller.isPaused()).toBe(true);
});
test('stored pause applies to the first video and replacement media',()=>{
  const f=fixture({stored:true});expect(f.video.playing).toBe(false);f.video.playing=true;f.controller.refresh();expect(f.video.playing).toBe(false);
});
