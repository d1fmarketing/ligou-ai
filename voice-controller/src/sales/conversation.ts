import { config, emptyUsage, sessionCostUsd } from '../config.ts';
import { parseSalesUsage, salesSessionConfig } from './provider.ts';
import type { SalesStore, WorkerSession } from './store.ts';

type Evidence = { id: string; role:'user'|'assistant'; text:string; context:'real'|'roleplay'; seq:number };
const norm = (v: string) => v.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
const contact = (v: string, channel: string) => channel === 'phone' ? v.replace(/\D/g,'') : norm(v).replace(/\s*arroba\s*/g,'@').replace(/\s*ponto\s*/g,'.').replace(/\s/g,'');
const affirmative = (v:string) => /^(sim\b|confirmo\b|correto\b|esta correto\b|autorizo\b|eu autorizo\b|pode (sim|entrar|me contatar|enviar|ligar)\b)/.test(norm(v)) && !/\b(nao|talvez|mas|porem|se|depois|ainda)\b/.test(norm(v));
const negative = (v:string) => /^(nao\b|nao autorizo\b|prefiro nao\b)/.test(norm(v));
// Revocations do not need a contact, a model tool call, or a new permission question.
const explicitWithdrawal = (text:string) => {
  const n=norm(text);
  return /\bnao (?:autorizo|permito)(?: mais)?(?:[.!?]|$)/.test(n)
    || /\bnao (?:autorizo|quero|desejo|permito|aceito) (?:mais )?(?:(?:o|nenhum|qualquer) )?(?:contato|ligacoes|ligacao|mensagens|mensagem|e-?mails?)(?:\b|$)/.test(n)
    || /\bnao (?:autorizo|quero|desejo|permito) que (?:(?:voces|a equipe|a ligou) )?(?:me (?:liguem|contatem|contactem)|entrem em contato)\b/.test(n)
    || /\bnao (?:quero|desejo) (?:mais )?(?:receber (?:ligacoes|mensagens|e-?mails?)|ser (?:contatado|contatada|contactado|contactada))\b/.test(n)
    || /\bnao me (?:mandem|enviem) (?:mais )?(?:e-?mails?|mensagens)\b/.test(n)
    || /\bnao (?:me )?(?:ligue|liguem|contate|contatem|contacte|contactem)(?:\b|$)/.test(n)
    || /\bnao (?:entrem?|entre) em contato\b/.test(n)
    || /\b(?:pare|parem) de (?:me )?(?:ligar|contatar|contactar|enviar mensagens|mandar mensagens)\b/.test(n)
    || /\b(?:retiro|revogo|cancelo) (?:a |o |minha |meu )?(?:autorizacao|permissao|consentimento)\b/.test(n)
    || /\b(?:tire|tirem|remova|removam|exclua|excluam) (?:o |os )?meu(?:s)? (?:numero|contato|email|dados)\b/.test(n)
    || /\b(?:do not|don't|stop) (?:contacting|calling|emailing|contact|call|email) me\b/.test(n)
    || /\b(?:withdraw|revoke) (?:my )?consent\b/.test(n);
};
const specificContactRequest = (text:string,channel?:string) => {
  const n=norm(text);
  const hasChannel=channel==='phone'?/telefone|ligacao/.test(n):channel==='email'?/e-?mail/.test(n):/telefone|ligacao|e-?mail/.test(n);
  return hasChannel&&n.includes('ligou')&&n.includes('piloto')&&/autoriza|permissao/.test(n)&&/entrar em contato|contatar|ligar|enviar/.test(n);
};
const canonical = (v:any):string => JSON.stringify(v && typeof v==='object' ? Array.isArray(v) ? v.map(x=>JSON.parse(canonical(x))) : Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])) : v);
export function isSalesSessionIntact(session:any, model:string) {
  const expected = salesSessionConfig(model);
  if (!session || session.model !== model || session.instructions !== expected.instructions || session.tool_choice !== 'auto') return false;
  if (canonical(session.tools) !== canonical(expected.tools) || canonical(session.output_modalities) !== canonical(['audio'])) return false;
  const input=session.audio?.input, output=session.audio?.output;
  return output?.voice === 'ash' && input?.transcription?.model === expected.audio.input.transcription.model
    && input?.turn_detection?.type === 'semantic_vad' && input.turn_detection.create_response === true && input.turn_detection.interrupt_response === true
    && input.turn_detection.eagerness === 'low' && session.max_output_tokens === expected.max_output_tokens;
}

/** Events are serialized by the socket adapter. No browser-supplied text item is a transcript. */
export class SalesConversation {
  private evidence = new Map<string,Evidence>();
  private fields = new Map<string,string>();
  private contactEvidenceSequence = new Map<string,number>();
  private consentDecision: {seq:number;id:string;granted:boolean} | null = null;
  private confirmed: {channel:string;value:string;seq:number} | null = null;
  private roleplay = false;
  private responses = new Set<string>();
  private completed = new Set<string>();
  private tools = new Set<string>();
  private usage = emptyUsage();
  private interruptedUsage = false;
  private transcriptionCost = 0;
  private transcriptionSeen = new Set<string>();
  private pendingAudio = new Set<string>();
  private transcriptionIncomplete = false;
  private sequence = 0;
  private observed: number;
  private endingRequested = false;
  private audioPlaying = false;
  constructor(private row: WorkerSession, private store: SalesStore, private send:(event:any)=>void, private stop:(reason:string)=>Promise<void>) { this.observed=Number(row.observed_cost_usd)||0; }
  private async write(op:string,payload:Record<string,unknown>) { this.row=await this.store.apply(this.row,op,payload); }
  private async transcript(id:string,role:'user'|'assistant',text:string,usage?:unknown) {
    if (!id || !text?.trim() || text.length > 16000) return;
    const existing=this.evidence.get(id);
    if (existing) { if (existing.role!==role || existing.text!==text) throw new Error('sales_transcript_conflict'); return; }
    const n=norm(text);
    if(role==='assistant') {
      if (/fim da (simulacao|demonstracao)|voltando (a|para) (sua empresa|conversa real)|encerramos a simulacao/.test(n)) this.roleplay=false;
      else if (/simulacao|demonstracao|role.?play/.test(n)) this.roleplay=true;
    }
    const item:Evidence={id,role,text,context:this.roleplay?'roleplay':'real',seq:++this.sequence};
    await this.write('transcript',{provider_item_id:id,role,text,context:item.context,...(usage ? {usage} : {})});
    this.evidence.set(id,item); // Never expose unsaved evidence to tool validation/model.
    if(item.role==='user'&&item.context==='real'&&this.isWithdrawal(item)) await this.revoke(item);
    this.send({type:'conversation.item.create',item:{type:'message',role:'system',content:[{type:'input_text',text:`Evidência persistida: item_id=${id}, role=${role}, contexto=${item.context}. Use este identificador para referenciar a fala correspondente nas ferramentas. Não confunda contexto de simulação com fato real.`}]}});
  }
  private item(id:unknown,role:'user'|'assistant'):Evidence {
    if(typeof id!=='string') throw new Error('evidence_required');
    const e=this.evidence.get(id);
    if(!e || e.role!==role || e.context!=='real') throw new Error('real_persisted_evidence_required');
    return e;
  }
  private isWithdrawal(reply:Evidence) {
    if(explicitWithdrawal(reply.text)) return true;
    const previous=[...this.evidence.values()].find(e=>e.seq===reply.seq-1);
    return negative(reply.text)&&previous?.role==='assistant'&&previous.context==='real'&&specificContactRequest(previous.text);
  }
  private async revoke(reply:Evidence) {
    if(this.consentDecision&&reply.seq<=this.consentDecision.seq){
      if(reply.id===this.consentDecision.id&&!this.consentDecision.granted)return;
      throw new Error('stale_consent_decision');
    }
    await this.write('lead_patch',{fields:{},followup_consent:{granted:false,response_item_id:reply.id}});
    this.consentDecision={seq:reply.seq,id:reply.id,granted:false};
  }
  private async tool(call:any) {
    if(!call.call_id || this.tools.has(call.call_id)) return;
    this.tools.add(call.call_id);
    let result:any;
    try {
      if(typeof call.arguments!=='string' || call.arguments.length>8000) throw new Error('invalid_arguments');
      const a=JSON.parse(call.arguments);
      if(!a || typeof a!=='object' || Array.isArray(a)) throw new Error('invalid_arguments');
      switch(call.name) {
        case 'save_lead_fact': {
          const allowed=['name','company','website','industry','region','language','call_volume','current_tools','main_need','contact_preference','phone','email','pilot_interest'];
          if(!allowed.includes(a.field)||typeof a.value!=='string'||!a.value.trim()||a.value.length>1000) throw new Error('invalid_fact');
          const e=this.item(a.evidence_item_id,'user');
          const channel=['phone','email'].includes(a.field)?a.field:null;
          if(channel&&e.seq<(this.contactEvidenceSequence.get(channel)??0))throw new Error('stale_contact_evidence');
          const needle=channel?contact(a.value,channel):norm(a.value);
          const haystack=channel?contact(e.text,channel):norm(e.text);
          if(!needle || !haystack.includes(needle)) throw new Error('value_not_in_evidence');
          if(a.field==='phone' && !/^\+?[\d\s().-]{7,30}$/.test(a.value)) throw new Error('invalid_phone');
          if(a.field==='email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.value)) throw new Error('invalid_email');
          await this.write('lead_patch',{fields:{[a.field]:{value:a.value,evidence_item_ids:[e.id]}}});
          if(channel && this.fields.get(a.field)!==a.value) this.confirmed=null;
          if(channel)this.contactEvidenceSequence.set(channel,e.seq);
          this.fields.set(a.field,a.value); result={ok:true,saved_field:a.field}; break;
        }
        case 'confirm_contact': {
          if(!['phone','email'].includes(a.channel)||typeof a.value!=='string'||this.fields.get(a.channel)!==a.value) throw new Error('saved_contact_required');
          const read=this.item(a.readback_item_id,'assistant'), reply=this.item(a.confirmation_item_id,'user');
          if(read.seq<=(this.contactEvidenceSequence.get(a.channel)??0)||reply.seq!==read.seq+1||!contact(read.text,a.channel).includes(contact(a.value,a.channel))||!/corret|confirm|certo/.test(norm(read.text))||!affirmative(reply.text)) throw new Error('explicit_contact_confirmation_required');
          await this.write('lead_patch',{fields:{},contact_confirmation:a});
          this.confirmed={channel:a.channel,value:a.value,seq:reply.seq}; result={ok:true,contact_confirmed:true}; break;
        }
        case 'record_followup_consent': {
          if(typeof a.granted!=='boolean')throw new Error('invalid_consent');
          const reply=this.item(a.response_item_id,'user');
          if(!a.granted){
            if(!this.isWithdrawal(reply))throw new Error('explicit_withdrawal_required');
            await this.revoke(reply);result={ok:true,followup_consent:false};break;
          }
          if(this.consentDecision&&reply.seq<=this.consentDecision.seq)throw new Error('stale_consent_decision');
          if(!this.confirmed||a.channel!==this.confirmed.channel||this.fields.get(a.channel)!==this.confirmed.value) throw new Error('confirmed_contact_required');
          const request=this.item(a.request_item_id,'assistant');
          if(request.seq<=Math.max(this.confirmed.seq,this.consentDecision?.seq??0)||reply.seq!==request.seq+1||!specificContactRequest(request.text,a.channel)||!affirmative(reply.text)) throw new Error('specific_followup_consent_required');
          await this.write('lead_patch',{fields:{},followup_consent:a});
          this.consentDecision={seq:reply.seq,id:reply.id,granted:true};result={ok:true,followup_consent:true};break;
        }
        case 'end_sales_call': this.endingRequested=true; result={ok:true,ending:true}; break;
        default: throw new Error('sales_tool_forbidden');
      }
    } catch(error) { result={ok:false,error:error instanceof Error?error.message:'invalid_tool',instruction:'Não afirme que salvou. Peça evidência ou confirmação explícita quando necessário.'}; }
    this.send({type:'conversation.item.create',item:{type:'function_call_output',call_id:call.call_id,output:JSON.stringify(result)}});
  }
  async handle(event:any):Promise<void> {
    switch(event.type) {
      case 'session.updated': if(!isSalesSessionIntact(event.session,String(this.row.model))) await this.stop('session_authority_changed'); break;
      case 'input_audio_buffer.committed': if(event.item_id)this.pendingAudio.add(event.item_id); break;
      case 'conversation.item.input_audio_transcription.completed': {
        await this.transcript(event.item_id,'user',event.transcript,event.usage);
        if(!event.item_id || this.transcriptionSeen.has(event.item_id)) break;
        this.transcriptionSeen.add(event.item_id);this.pendingAudio.delete(event.item_id);
        const u=event.usage;
        if(u?.type==='tokens' && [u.input_tokens,u.output_tokens,u.total_tokens].every(x=>Number.isSafeInteger(x)&&x>=0) && u.total_tokens===u.input_tokens+u.output_tokens){
          // Official pricing 2026-09-04: mini-transcribe input $1.25, output $5 / 1M.
          this.transcriptionCost+=(u.input_tokens*1.25+u.output_tokens*5)/1e6;
          this.observed=Math.max(this.observed,sessionCostUsd(String(this.row.model),this.usage)+this.transcriptionCost);
          await this.write('usage',{observed_cost_usd:this.observed,final:false,provider_event_id:`transcription:${event.item_id}`,provider_usage:u});
          if(this.observed>=Math.min(config.sessionCostCeilingUsd,1.5,Number(this.row.reserved_cost_usd))) await this.stop('cost_ceiling');
        }else this.transcriptionIncomplete=true;
        break;
      }
      case 'response.output_audio_transcript.done': await this.transcript(event.item_id,'assistant',event.transcript); break;
      case 'conversation.item.input_audio_transcription.failed': await this.stop('transcription_failed'); break;
      case 'output_audio_buffer.started': this.audioPlaying=true; break;
      case 'output_audio_buffer.stopped': case 'output_audio_buffer.cleared':
        this.audioPlaying=false;if(this.endingRequested)await this.stop('agent_ended');break;
      case 'response.created': {
        const r=event.response;
        if((r?.output_modalities&&canonical(r.output_modalities)!==canonical(['audio']))||(r?.max_output_tokens!==undefined&&(!Number.isFinite(r.max_output_tokens)||r.max_output_tokens>1024))){await this.stop('response_authority_changed');break;}
        if(r?.id)this.responses.add(r.id);break;
      }
      case 'response.done': {
        const r=event.response;
        if(!r?.id||!this.responses.has(r.id)||this.completed.has(r.id)) return;
        this.completed.add(r.id);
        const usage=parseSalesUsage(r.usage);
        if(usage) {
          for(const k of Object.keys(this.usage) as Array<keyof typeof this.usage>) this.usage[k]+=usage[k];
          this.observed=Math.max(this.observed,sessionCostUsd(String(this.row.model),this.usage)+this.transcriptionCost);
          await this.write('usage',{observed_cost_usd:this.observed,final:false,provider_event_id:`response:${r.id}`,provider_usage:r.usage});
          if(this.observed>=Math.min(config.sessionCostCeilingUsd,1.5,Number(this.row.reserved_cost_usd))) { await this.stop('cost_ceiling'); return; }
        } else this.interruptedUsage=true;
        const calls=Array.isArray(r.output)?r.output.filter((x:any)=>x.type==='function_call'):[];
        for(const call of calls) await this.tool(call);
        if(this.endingRequested) { if(!this.audioPlaying)await this.stop('agent_ended'); return; }
        if(calls.length) this.send({type:'response.create'});
        break;
      }
      case 'session.ended': case 'session.closed': {
        const usage=parseSalesUsage(event.usage);
        if(usage) {
          const cost=sessionCostUsd(String(this.row.model),usage)+this.transcriptionCost;
          const complete=!this.interruptedUsage&&!this.transcriptionIncomplete&&this.pendingAudio.size===0&&this.responses.size===this.completed.size&&cost>=this.observed;
          await this.write('usage',{observed_cost_usd:Math.max(cost,this.observed),final:complete,provider_event_id:`terminal:${event.event_id??this.row.session_id}`,provider_usage:event.usage});
        }
        await this.stop('provider_ended'); break;
      }
      case 'error': await this.stop('provider_error'); break;
    }
  }
}
