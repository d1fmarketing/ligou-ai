/** Opt-in capture in the installed tab. No network, synthetic input or voice controls.
 * buildHumanDiagnosticsSource({origin, pathname:'/dashboard/setup/website', armed:true})
 * installs window.__ligouHumanDiagnostics. Await .ready before the real Start.
 * .status(), .arm(), .disable(), .list(), .exportLatest(), .exportCapture(runId),
 * .exportChunk(runId,index), .downloadLatest(). Export descriptors contain bytes,
 * parts and SHA256; exportChunk returns base64 UTF-8 JSON pieces below 256 KiB.
 * The archive has manifest + ordered records. audio.chunk blobs concatenate by
 * streamId/chunkIndex; only audio.end identifies the final chunk. Individual
 * MediaRecorder timeslices are NOT claimed to be independently playable files.
 * After reload/reopening, reinstall to recover same-origin/path captures. tabId
 * remains provenance, not a recovery restriction; no other tab is instrumented.
 * Cloned tracks and original gate/element states are separate evidence, not a
 * claim about physical speaker audibility or exactly what reached the provider.
 */

export function redactHumanDiagnostics(input) {
  const forbidden=new Set('accesstoken refreshtoken idtoken token authorization clientsecret apikey servicekey secret password credentials cookie setcookie sdp offersdp answersdp headers instructions prompt session __proto__ constructor prototype'.split(' '));
  let nodes=0,redactions=0,truncated=false;const seen=new WeakSet();
  const clean=value=>{
    if(/(?:^|[\s"'])v=0(?:\r?\n)|\ba=(?:ice-pwd|ice-ufrag|fingerprint):|\bm=(?:audio|video)\s+\d+/i.test(value)){redactions++;return '[redacted SDP]';}
    return value.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+|\b(?:sk-|sb_secret_)[A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi,()=>{redactions++;return '[redacted]';})
      .replace(/((?:access_token|refresh_token|token|api_key|secret|password)=)[^&\s]+/gi,(_all,prefix)=>{redactions++;return prefix+'[redacted]';});
  };
  function visit(value,depth){
    if(++nodes>20000||depth>16){truncated=true;return '[structure limit]';}
    if(typeof value==='string'){if(value.length>262144){truncated=true;return '[string limit: '+value.length+']';}return clean(value);}
    if(value===null||typeof value==='boolean'||typeof value==='number')return Number.isFinite(value)||typeof value!=='number'?value:null;
    if(typeof value!=='object')return null;
    if(seen.has(value)){truncated=true;return '[cycle]';}seen.add(value);
    const result=Array.isArray(value)?[]:Object.create(null);
    for(const [key,child] of Object.entries(value)){
      const normalized=key.toLowerCase().replace(/[^a-z]/g,'');
      if(forbidden.has(normalized)||/(?:apikey|clientsecret|accesstoken|refreshtoken|idtoken|password|credential|authorization|secret)/.test(normalized)||normalized.endsWith('token')||['__proto__','constructor','prototype'].includes(key)){redactions++;result[key]='[redacted]';}
      else result[key]=visit(child,depth+1);
    }
    seen.delete(value);return result;
  }
  return {value:visit(input,0),redactions,truncated};
}

export function projectHumanDiagnosticEvent(event,direction,redact=redactHumanDiagnostics) {
  if(!event||typeof event!=='object'||typeof event.type!=='string')return null;
  const selected=new Set(['session.update','session.created','session.updated','session.ended','response.create','response.created','response.done','response.cancel',
    'input_audio_buffer.speech_started','input_audio_buffer.speech_stopped','input_audio_buffer.committed','input_audio_buffer.commit','input_audio_buffer.clear',
    'output_audio_buffer.started','output_audio_buffer.stopped','output_audio_buffer.cleared','output_audio_buffer.clear',
    'conversation.item.created','conversation.item.done','conversation.item.create','conversation.item.truncate','conversation.item.truncated',
    'conversation.item.input_audio_transcription.completed','conversation.item.input_audio_transcription.failed',
    'response.output_audio_transcript.delta','response.output_audio_transcript.done','response.output_item.added','response.output_item.done',
    'response.function_call_arguments.delta','response.function_call_arguments.done','error']);
  if(!selected.has(event.type))return null;
  return (async()=>{
  const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>Object.hasOwn(value??{},key)).map(key=>[key,value[key]]));
  const hash=async text=>{if(typeof text!=='string')return null;const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return [...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,'0')).join('');};
  const parse=async value=>{if(typeof value!=='string')return value;try{return JSON.parse(value);}catch{return {unparsed:true,chars:value.length,sha256:await hash(value)};}};
  const data={direction,...pick(event,['type','event_id','response_id','item_id','previous_item_id','call_id','content_index','output_index','audio_start_ms','audio_end_ms','transcript','delta'])};
  // Partial text/JSON can split a credential across events. Keep timing/identity;
  // the completed events below retain redacted business content.
  if(event.type.endsWith('.delta')){delete data.delta;data.deltaChars=typeof event.delta==='string'?event.delta.length:0;}
  if(event.error)data.error=pick(event.error,['type','code','param','event_id']);
  if(Object.hasOwn(event,'arguments'))data.arguments=await parse(event.arguments);
  if(event.session){
    const session=event.session,output=session.audio?.output,input=session.audio?.input;
    data.configuration={...pick(session,['type','model','output_modalities','tool_choice','max_output_tokens']),
      voice:output?.voice??null,transcription:pick(input?.transcription,['model','language','languages']),
      turnDetection:pick(input?.turn_detection,['type','eagerness','threshold','prefix_padding_ms','silence_duration_ms','create_response','interrupt_response']),
      tools:Array.isArray(session.tools)?session.tools.map(tool=>pick(tool,['type','name'])):[],
      toolsSha256:await hash(JSON.stringify(session.tools??[])),promptSha256:await hash(session.instructions)};
  }
  const projectItem=async item=>{
    const result=pick(item,['id','type','role','status','call_id','name']);
    if(item?.type==='function_call')result.arguments=await parse(item.arguments);
    else if(item?.type==='function_call_output')result.output=await parse(item.output);
    else if(Array.isArray(item?.content)){
      result.content=item.content.map(part=>pick(part,['type','transcript']));
      const text=item.content[0]?.text,prefix='ligou.website_native:';
      if(item.role==='system'&&typeof text==='string'&&text.startsWith(prefix))result.nativeContext=await parse(text.slice(prefix.length));
    }
    return result;
  };
  if(event.item)data.item=await projectItem(event.item);
  if(event.response){
    const response=event.response;
    data.response={...pick(response,['id','status','status_details','output_modalities','tool_choice','max_output_tokens','usage']),
      metadata:pick(response.metadata,['native_request_id','native_checkpoint','native_budget_pause','ligou_call_id','ligou_action_id','ligou_dispatch_id','ligou_source_digest']),
      ...(Array.isArray(response.output)?{output:await Promise.all(response.output.map(projectItem))}:{}),
      ...(typeof response.instructions==='string'?{promptSha256:await hash(response.instructions)}:{})};
    if(response.status_details?.error)data.response.status_details={...pick(response.status_details,['type','reason']),error:pick(response.status_details.error,['type','code','param','event_id'])};
  }
  const safe=redact(data);return {...safe.value,redactions:safe.redactions,truncated:safe.truncated};
  })();
}

export function projectHumanAudioStats(report) {
  const keys=['id','type','timestamp','kind','mediaType','trackIdentifier','ssrc','packetsReceived','packetsSent','packetsLost','bytesReceived','bytesSent',
    'jitter','fractionLost','roundTripTime','totalRoundTripTime','roundTripTimeMeasurements','concealedSamples','silentConcealedSamples','concealmentEvents',
    'totalSamplesReceived','jitterBufferDelay','jitterBufferEmittedCount','jitterBufferTargetDelay','jitterBufferMinimumDelay','audioLevel','totalAudioEnergy','totalSamplesDuration'];
  const result=[];
  for(const row of report.values())if(['inbound-rtp','outbound-rtp','remote-inbound-rtp','media-source'].includes(row.type)&&(row.kind==='audio'||row.mediaType==='audio'))
    result.push(Object.fromEntries(keys.filter(key=>typeof row[key]==='string'||typeof row[key]==='number'&&Number.isFinite(row[key])).map(key=>[key,row[key]])));
  return result;
}

export function installHumanDiagnostics(settings,redact,projectEvent,projectStats) {
  const inScope=()=>location.origin===settings.origin&&location.pathname.replace(/\/$/,'')===settings.pathname;
  if(!inScope()||window.__ligouHumanDiagnostics)return;
  const pageId=crypto.randomUUID(),tabKey='ligou.human.diagnostics.tab.v1';let tabId;
  try{const saved=sessionStorage.getItem(tabKey);tabId=/^[0-9a-f-]{36}$/i.test(saved??'')?saved:crypto.randomUUID();sessionStorage.setItem(tabKey,tabId);}catch{tabId=pageId;}
  let armed=settings.armed,run=null,storageReady=false,storageError=false,badge=null,lastClick=null;
  const hooks={getUserMedia:false,peer:false,outputElements:false};
  const peers=new Set(),peerCaptures=new WeakMap(),elements=new Set(),knownTracks=new WeakMap(),exports=new Map();
  const stamp=()=>({browserMs:performance.now(),wallMs:Date.now()});
  const quiet=fn=>{try{return fn();}catch{return undefined;}};
  const bytes64=bytes=>{let text='';for(let i=0;i<bytes.length;i+=16384)text+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(text);};
  const sha=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
  const mediaSupported=typeof MediaRecorder==='function'&&typeof window.RTCPeerConnection==='function'&&typeof navigator.mediaDevices?.getUserMedia==='function';
  const dbReady=new Promise(resolve=>{
    let settled=false;const finish=db=>{if(settled){quiet(()=>db?.close());return;}settled=true;storageReady=Boolean(db);storageError=!db;paint();resolve(db);};
    try{
      const request=indexedDB.open('ligou-voice-human-diagnostics-v1',1);
      request.onupgradeneeded=()=>{const store=request.result.createObjectStore('records',{keyPath:['runId','seq']});store.createIndex('kind','kind');};
      request.onsuccess=()=>finish(request.result);
      request.onerror=request.onblocked=()=>finish(null);
    }catch{finish(null);}
  });
  async function transaction(mode,work){
    const db=await dbReady;if(!db)throw Error('storage_unavailable');
    return new Promise((resolve,reject)=>{
      let tx,result;
      try{try{tx=db.transaction('records',mode,{durability:'strict'});}catch{tx=db.transaction('records',mode);}
        tx.oncomplete=()=>resolve(result);tx.onerror=tx.onabort=()=>reject(Error('storage_transaction_failed'));
        work(tx.objectStore('records'),value=>{result=value;});
      }catch(error){reject(error);}
    });
  }
  const manifest=cap=>({runId:cap.id,tabId,pageId:cap.pageId,origin:settings.origin,pathname:settings.pathname,started:cap.started,ended:cap.ended??null,
    state:cap.state,complete:cap.state==='complete'&&!cap.storageError,observedSeq:cap.seq,persistedSeq:cap.persistedSeq,
    callId:cap.callId,attemptId:cap.attemptId,errors:[...cap.errors],streams:cap.streams.map(s=>({streamId:s.id,direction:s.direction,originalTrackId:s.original.id,
      mime:s.mime,chunkCount:s.chunks,finalChunkIndex:s.ended?s.chunks-1:null,ended:s.ended,reason:s.reason??null})),
    evidence:'cloned browser tracks; original track and output element gates are logged separately; no hardware audibility claim'});
  function fault(cap,code,seq=null){if(!cap)return;cap.errors.push({code,seq,...stamp()});if(cap.errors.length>50)cap.errors.shift();paint();}
  function append(cap,kind,value,blob=null){
    if(!cap)return Promise.resolve();const seq=++cap.seq,at=stamp();cap.pendingWrites++;
    // Attach both handlers immediately, even while earlier IDB writes are pending.
    const prepared=Promise.resolve(value).then(raw=>{try{return {ok:true,safe:redact(raw)};}catch{return {ok:false};}},()=>({ok:false}));
    cap.queue=cap.queue.then(async()=>{
      try{
        const result=await prepared;if(!result.ok)fault(cap,'record_projection_failed',seq);
        const safe=result.ok?result.safe:{value:{code:'record_projection_failed',sourceKind:kind}};
        const data={...safe.value,...(safe.redactions?{redactions:safe.redactions}:{}),...(safe.truncated?{truncated:true}:{})};
        const record={runId:cap.id,seq,kind:result.ok?kind:'diagnostic.error',...at,data,...(blob?{blob}:{})};
        await transaction('readwrite',store=>{store.put(record);store.put({runId:cap.id,seq:0,kind:'manifest',data:redact({...manifest(cap),persistedSeq:seq}).value});});
        cap.persistedSeq=seq;
      }catch{cap.storageError=true;storageError=true;fault(cap,'record_persistence_failed',seq);}
      finally{cap.pendingWrites--;paint();}
    });return cap.queue;
  }
  const audioSettings=value=>Object.fromEntries(['echoCancellation','noiseSuppression','autoGainControl','sampleRate','channelCount'].filter(key=>Object.hasOwn(value??{},key)).map(key=>{
    const raw=value[key],safe=typeof raw==='boolean'||typeof raw==='string'||Number.isFinite(raw)?raw:
      raw&&typeof raw==='object'?Object.fromEntries(['ideal','exact'].filter(k=>typeof raw[k]==='boolean'||typeof raw[k]==='string'||Number.isFinite(raw[k])).map(k=>[k,raw[k]])):null;
    return [key,safe];
  }));
  const trackState=track=>({id:track.id,kind:track.kind,enabled:track.enabled,muted:track.muted,readyState:track.readyState,settings:audioSettings(quiet(()=>track.getSettings())??{})});
  const elementState=audio=>({muted:audio.muted,volume:audio.volume,paused:audio.paused,ended:audio.ended,readyState:audio.readyState});
  function stopStream(stream,reason){
    if(stream.stopping)return;stream.stopping=true;stream.reason=reason;
    quiet(()=>{if(stream.recorder.state!=='inactive')stream.recorder.stop();});quiet(()=>stream.clone.stop());
  }
  function observeTrack(original,direction,cap){
    if(!cap?.active||!inScope()||original?.kind!=='audio'||original.readyState==='ended'||knownTracks.has(original))return;
    let clone,recorder;
    try{
      clone=original.clone();const mime=MediaRecorder.isTypeSupported('audio/webm;codecs=opus')?'audio/webm;codecs=opus':MediaRecorder.isTypeSupported('audio/webm')?'audio/webm':'';
      recorder=new MediaRecorder(new MediaStream([clone]),mime?{mimeType:mime}:{});
      let resolveDone;const entry={id:direction+'-'+(cap.streams.filter(s=>s.direction===direction).length+1),direction,original,clone,recorder,mime:recorder.mimeType||mime,
        chunks:0,ended:false,stopping:false,done:new Promise(resolve=>{resolveDone=resolve;})};
      knownTracks.set(original,entry);cap.streams.push(entry);
      const oldStop=original.stop;
      original.stop=function(...args){try{return Reflect.apply(oldStop,this,args);}finally{quiet(()=>{if(cap.active||cap.state==='finalizing')append(cap,'track.state',{streamId:entry.id,direction,reason:'original_stop',...trackState(original)});stopStream(entry,'original_stop');});}};
      for(const type of ['mute','unmute','ended'])original.addEventListener(type,()=>quiet(()=>{
        if(cap.active||cap.state==='finalizing')append(cap,'track.state',{streamId:entry.id,direction,reason:type,...trackState(original)});if(type==='ended')stopStream(entry,'original_ended');
      }));
      recorder.ondataavailable=event=>quiet(()=>{
        if(!event.data?.size)return;const chunkIndex=entry.chunks++,blob=event.data;
        append(cap,'audio.chunk',(async()=>({streamId:entry.id,direction,chunkIndex,first:chunkIndex===0,bytes:blob.size,mime:entry.mime,
          sha256:await sha(await blob.arrayBuffer())}))(),blob);
      });
      recorder.onerror=()=>quiet(()=>{fault(cap,'recorder_error');append(cap,'audio.error',{streamId:entry.id,direction,code:'recorder_error'});stopStream(entry,'recorder_error');});
      recorder.onstop=()=>quiet(()=>{
        entry.ended=true;quiet(()=>clone.stop());append(cap,'audio.end',{streamId:entry.id,direction,chunkCount:entry.chunks,finalChunkIndex:entry.chunks-1,reason:entry.reason??'source_ended'});
        resolveDone();paint();
      });
      append(cap,'audio.start',{streamId:entry.id,direction,mime:entry.mime,original:trackState(original),clone:trackState(clone),...stamp()});
      recorder.start(500);paint();
    }catch{quiet(()=>clone?.stop());fault(cap,'recorder_start_failed');append(cap,'audio.error',{direction,code:'recorder_start_failed'});}
  }
  function observeElement(audio){
    if(!audio||elements.has(audio))return;elements.add(audio);
    for(const type of ['playing','pause','volumechange','emptied','ended','error'])audio.addEventListener(type,()=>quiet(()=>{
      if(run?.active&&inScope())append(run,'output.element',{event:type,...elementState(audio)});
    }));
    if(run?.active&&inScope())append(run,'output.element',{event:'observed',...elementState(audio)});
  }
  function wire(cap,event,direction){
    if(!cap?.active||cap!==run||!inScope())return;
    const projected=projectEvent(event,direction,redact);if(projected)append(cap,'wire',projected);
  }
  async function sample(cap){
    if(!cap.active)return;if(!inScope()){void closeRun(cap,'scope_left');return;}
    for(const stream of cap.streams){
      append(cap,'track.state',{streamId:stream.id,direction:stream.direction,reason:'sample',...trackState(stream.original)});
      if(stream.original.readyState==='ended')stopStream(stream,'original_ended_observed');
    }
    for(const audio of elements)append(cap,'output.element',{event:'sample',...elementState(audio)});
    for(const peer of cap.peers){
      append(cap,'peer.state',{peerId:peer.id,connectionState:peer.value.connectionState,iceConnectionState:peer.value.iceConnectionState,signalingState:peer.value.signalingState});
      try{const result=await peer.value.getStats();if(cap.active)append(cap,'audio.stats',{peerId:peer.id,rows:projectStats(result)});}
      catch{fault(cap,'get_stats_failed');append(cap,'diagnostic.error',{peerId:peer.id,code:'get_stats_failed'});}
    }
  }
  function begin(detail){
    if(!armed||!inScope()||run?.active||run?.state==='finalizing'||typeof detail?.attemptId!=='string'||!detail.attemptId)return;
    const cap={id:crypto.randomUUID(),pageId,started:stamp(),state:'recording',active:true,seq:0,persistedSeq:0,pendingWrites:0,queue:Promise.resolve(),
      storageError:false,errors:[],streams:[],peers:[],attemptId:detail?.attemptId??null,callId:null};run=cap;
    append(cap,'capture.start',{attemptId:cap.attemptId,click:lastClick,optIn:true});cap.timer=setInterval(()=>{void sample(cap).catch(()=>fault(cap,'sampling_failed'));},1000);paint();
  }
  function closeRun(cap,reason){
    if(!cap)return Promise.resolve(status());if(cap.closing)return cap.closing;
    cap.active=false;cap.state='finalizing';clearInterval(cap.timer);append(cap,'capture.stopping',{reason});
    for(const stream of cap.streams)stopStream(stream,reason);
    cap.closing=(async()=>{
      let timeout;await Promise.race([Promise.all(cap.streams.map(s=>s.done)),new Promise(resolve=>{timeout=setTimeout(()=>{fault(cap,'recorder_finalization_timeout');resolve();},2000);})]);clearTimeout(timeout);
      await cap.queue;
      if(reason==='pagehide'||reason==='scope_left')fault(cap,'document_left_before_verified_export');
      if(!cap.streams.some(s=>s.direction==='input'))fault(cap,'input_not_captured');
      if(!cap.streams.some(s=>s.direction==='output'))fault(cap,'output_not_captured');
      if(cap.streams.some(s=>!s.ended||!s.chunks))fault(cap,'audio_incomplete');
      cap.ended=stamp();cap.state=cap.errors.length||cap.storageError?'incomplete':'complete';
      await append(cap,'capture.end',{reason,complete:cap.state==='complete'});if(cap.storageError)cap.state='incomplete';paint();return status();
    })();return cap.closing;
  }
  function status(){return {ready:storageReady&&mediaSupported&&Object.values(hooks).every(Boolean),storageReady,mediaSupported,hooks:{...hooks},armed,state:run?.state??(armed?'armed':'disabled'),runId:run?.id??null,
    pendingWrites:run?.pendingWrites??0,pendingRecorders:run?.streams.filter(s=>!s.ended).length??0,storageError:storageError||Boolean(run?.storageError)};}
  const nativeGet=navigator.mediaDevices?.getUserMedia;
  if(nativeGet){const wrapped=function(...args){
    const cap=run,result=Reflect.apply(nativeGet,this,args);
    quiet(()=>{if(cap?.active&&inScope())append(cap,'microphone.requested',{audio:audioSettings(args[0]?.audio),videoRequested:Boolean(args[0]?.video)});
      result.then(stream=>quiet(()=>{if(cap?.active&&inScope())for(const track of stream.getAudioTracks())observeTrack(track,'input',cap);}),()=>quiet(()=>{
        if(cap?.active)append(cap,'diagnostic.error',{code:'get_user_media_rejected'});
      })).catch(()=>{});
    });return result;
  };quiet(()=>{navigator.mediaDevices.getUserMedia=wrapped;});hooks.getUserMedia=navigator.mediaDevices.getUserMedia===wrapped;}
  const NativePeer=window.RTCPeerConnection;
  if(NativePeer){const WrappedPeer=class extends NativePeer{
    constructor(...args){super(...args);const peer={id:'peer-'+(peers.size+1),value:this};peers.add(peer);const cap=run;peerCaptures.set(this,cap);if(cap?.active&&inScope())cap.peers.push(peer);
      this.addEventListener('track',event=>quiet(()=>observeTrack(event.track,'output',cap)));
      for(const type of ['connectionstatechange','iceconnectionstatechange','signalingstatechange'])this.addEventListener(type,()=>quiet(()=>{
        if(cap?.active&&inScope())append(cap,'peer.state',{peerId:peer.id,event:type,connectionState:this.connectionState,iceConnectionState:this.iceConnectionState,signalingState:this.signalingState});
      }));
    }
    createDataChannel(...args){const channel=super.createDataChannel(...args),send=channel.send,cap=peerCaptures.get(this);
      quiet(()=>{channel.send=function(...values){const result=Reflect.apply(send,this,values);quiet(()=>{if(typeof values[0]==='string'&&values[0].length<=1048576)wire(cap,JSON.parse(values[0]),'client');});return result;};});
      channel.addEventListener('message',event=>quiet(()=>{if(typeof event.data==='string'&&event.data.length<=1048576)wire(cap,JSON.parse(event.data),'provider');}));
      for(const type of ['open','close','error'])channel.addEventListener(type,()=>quiet(()=>{if(cap?.active&&cap===run&&inScope())append(cap,'channel.state',{event:type,readyState:channel.readyState});}));
      return channel;
    }
  };quiet(()=>{window.RTCPeerConnection=WrappedPeer;});hooks.peer=window.RTCPeerConnection===WrappedPeer;}
  const nativePlay=globalThis.HTMLMediaElement?.prototype.play;
  if(nativePlay){const wrapped=function(...args){const result=Reflect.apply(nativePlay,this,args);quiet(()=>{if(inScope())observeElement(this);});return result;};quiet(()=>{HTMLMediaElement.prototype.play=wrapped;});hooks.outputElements=HTMLMediaElement.prototype.play===wrapped;}
  document.addEventListener('click',event=>quiet(()=>{if(inScope()&&event.target?.closest?.('.voice-live-button'))lastClick={...stamp(),eventTimeStamp:event.timeStamp,isTrusted:event.isTrusted};}),true);
  window.addEventListener('ligou:voice-timing',event=>quiet(()=>{
    const detail=event.detail;if(!inScope())return;if(detail?.event==='start')begin(detail);
    const cap=run;if(!cap?.active||detail?.attemptId!==cap.attemptId)return;
    if(typeof detail?.callId==='string'){
      if(cap.callId!==null&&cap.callId!==detail.callId)return;
      cap.callId=detail.callId;
    }
    append(cap,'application.timing',detail);
    if(['session_ended','start_cancelled','start_failed'].includes(detail?.event))void closeRun(cap,detail.event);
  }));
  window.addEventListener('pagehide',()=>quiet(()=>{armed=false;void closeRun(run,'pagehide');}));
  window.addEventListener('popstate',()=>quiet(()=>{if(!inScope())void closeRun(run,'scope_left');}));
  async function list(){
    const rows=await transaction('readonly',(store,set)=>{const request=store.index('kind').getAll('manifest');request.onsuccess=()=>set(request.result);});
    return rows.filter(row=>row.data.origin===settings.origin&&row.data.pathname===settings.pathname).map(row=>{
      const value=row.data;return value.pageId!==pageId&&['recording','finalizing'].includes(value.state)?{...value,state:'incomplete',complete:false,interruptedDocument:true}:value;
    }).sort((a,b)=>b.started.wallMs-a.started.wallMs);
  }
  async function exportCapture(runId){
    if(run?.id===runId)await run.queue;
    const records=await transaction('readonly',(store,set)=>{const request=store.getAll(IDBKeyRange.bound([runId,0],[runId,Number.MAX_SAFE_INTEGER]));request.onsuccess=()=>set(request.result);});
    const head=records.find(row=>row.seq===0);if(!head||head.data.origin!==settings.origin||head.data.pathname!==settings.pathname)throw Error('capture_outside_scope');
    const meta={...head.data},ordered=records.filter(row=>row.seq>0).sort((a,b)=>a.seq-b.seq),gaps=[];
    for(let expected=1,index=0;expected<=meta.observedSeq;expected++){if(ordered[index]?.seq===expected)index++;else gaps.push(expected);}
    if(meta.pageId!==pageId&&['recording','finalizing'].includes(meta.state)){meta.state='incomplete';meta.interruptedDocument=true;}
    if(run?.id===runId&&run.storageError){meta.state='incomplete';meta.errors=[...run.errors];}
    meta.gaps=gaps;meta.complete=meta.state==='complete'&&gaps.length===0;meta.status=meta.state;
    for(const record of ordered)if(record.blob){record.data={...record.data,base64:bytes64(new Uint8Array(await record.blob.arrayBuffer()))};delete record.blob;}
    const bytes=new TextEncoder().encode(JSON.stringify({schema:'ligou.voice.human.capture.v1',manifest:meta,records:ordered}));
    const descriptor={runId,bytes:bytes.length,parts:Math.ceil(bytes.length/131072),sha256:await sha(bytes),complete:meta.complete,status:meta.state};
    exports.set(runId,{bytes,descriptor});return descriptor;
  }
  async function exportLatest(){const captures=await list();if(!captures.length)throw Error('capture_not_found');return exportCapture(captures[0].runId);}
  async function exportChunk(runId,index){
    if(!exports.has(runId))await exportCapture(runId);const item=exports.get(runId);
    if(!Number.isSafeInteger(index)||index<0||index>=item.descriptor.parts)throw Error('export_index_invalid');
    return {runId,index,parts:item.descriptor.parts,encoding:'base64',data:bytes64(item.bytes.subarray(index*131072,(index+1)*131072))};
  }
  async function downloadLatest(){
    const descriptor=await exportLatest(),blob=new Blob([exports.get(descriptor.runId).bytes],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url;link.download='voice-human-'+descriptor.runId+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return descriptor;
  }
  function paint(){quiet(()=>{if(badge){const value=status();badge.querySelector('span').textContent='Diagnóstico humano: '+value.state+(value.storageError?' · erro ao salvar':'')+(!Object.values(hooks).every(Boolean)?' · interceptação indisponível':'')+' · pendentes '+value.pendingWrites;badge.dataset.state=value.state;}});}
  const api={version:1,ready:dbReady.then(()=>status()),status,arm(){if(inScope()){armed=true;paint();}return status();},
    async disable(){armed=false;await closeRun(run,'disabled');paint();return status();},list,exportLatest,exportCapture,exportChunk,downloadLatest};
  window.__ligouHumanDiagnostics=api;
  const mount=()=>quiet(()=>{
    if(badge||!document.body||!inScope())return;badge=document.createElement('aside');badge.id='ligou-human-diagnostics';
    badge.style.cssText='position:fixed;left:12px;bottom:12px;z-index:2147483647;padding:8px;background:#10201d;color:white;font:12px system-ui;border-radius:6px;max-width:400px';
    badge.setAttribute('aria-label','Diagnóstico local de áudio autorizado');badge.append(document.createElement('span'));
    for(const [label,action] of [['Armar',()=>api.arm()],['Desativar',()=>api.disable()],['Baixar captura',()=>api.downloadLatest()]]){
      const button=document.createElement('button');button.textContent=label;button.style.marginLeft='6px';button.addEventListener('click',()=>{Promise.resolve().then(action).catch(()=>{if(run)fault(run,'export_failed');});});badge.append(button);
    }document.body.append(badge);paint();
  });
  mount();document.addEventListener('DOMContentLoaded',mount,{once:true});
}

export function buildHumanDiagnosticsSource({origin,pathname='/dashboard/setup/website',armed=false}={}) {
  let url;try{url=new URL(origin);}catch{throw Error('human_diagnostics_origin_invalid');}
  if(url.origin!==origin||url.username||url.password||!(url.protocol==='https:'||url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)))throw Error('human_diagnostics_origin_invalid');
  if(pathname!=='/dashboard/setup/website'||typeof armed!=='boolean')throw Error('human_diagnostics_scope_invalid');
  return `(${installHumanDiagnostics.toString()})(${JSON.stringify({origin,pathname,armed})},${redactHumanDiagnostics.toString()},${projectHumanDiagnosticEvent.toString()},${projectHumanAudioStats.toString()});`;
}
