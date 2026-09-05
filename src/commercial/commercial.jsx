import { createClient } from '@supabase/supabase-js';
import { browserCustodyStorage, stripProviderFields } from '../../dashboard/src/auth/session-storage.js';
import { loadSalesLeads, loadSalesTranscript } from './commercial-data.js';
const {useState,useEffect,useRef}=React;
const cfg=window.LIGOU_PUBLIC_CONFIG||{};
let client=null,clientError='';
try {if(cfg.supabaseUrl&&cfg.supabaseKey)client=createClient(cfg.supabaseUrl,cfg.supabaseKey,{auth:{flowType:'pkce',storageKey:'ligou-sales-operator',storage:browserCustodyStorage(),persistSession:true,detectSessionInUrl:true,autoRefreshToken:true}});}
catch {clientError='Não foi possível iniciar a área comercial. Permita o armazenamento deste site e recarregue a página.';}
const date=value=>{const d=new Date(value);return Number.isNaN(d.getTime())?'':d.toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'});};

function App(){
  const [session,setSession]=useState(undefined),[leads,setLeads]=useState([]),[selected,setSelected]=useState(null);
  const [transcript,setTranscript]=useState([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[reading,setReading]=useState(false);
  const [transcriptError,setTranscriptError]=useState(''),[loggingOut,setLoggingOut]=useState(false);
  const generation=useRef(0),principal=useRef(undefined);
  const [refreshRevision,setRefreshRevision]=useState(0);
  useEffect(()=>{
    if(!client){setSession(null);return;}
    let alive=true,authRevision=0;
    const acceptSession=value=>{
      if(!alive)return;
      const next=stripProviderFields(value),nextId=next?.user?.id||null;
      if(principal.current!==nextId){
        principal.current=nextId;generation.current++;
        setLeads([]);setSelected(null);setTranscript([]);setError('');setBusy(false);setReading(false);setTranscriptError('');setLoggingOut(false);
      }
      setSession(next);
    };
    const initialRevision=authRevision;
    Promise.resolve().then(()=>client.auth.getSession()).then(({data,error})=>{if(alive&&authRevision===initialRevision){acceptSession(data?.session||null);if(error)setError('Não foi possível recuperar a sessão. Entre novamente.');}}).catch(()=>{if(alive&&authRevision===initialRevision){acceptSession(null);setError('Não foi possível recuperar a sessão. Entre novamente.');}});
    const {data}=client.auth.onAuthStateChange((_event,value)=>{authRevision++;acceptSession(value);});
    return()=>{alive=false;generation.current++;data.subscription.unsubscribe();};
  },[]);
  async function refresh(){
    const current=++generation.current;setBusy(true);setError('');
    try{const rows=await loadSalesLeads(client);if(current===generation.current){setLeads(rows);setSelected(old=>rows.find(r=>r.id===old?.id)||rows[0]||null);setRefreshRevision(value=>value+1);}}
    catch(e){if(current===generation.current)setError(e.message);}
    finally{if(current===generation.current)setBusy(false);}
  }
  useEffect(()=>{if(session?.user?.id)void refresh();},[session?.user?.id]);
  useEffect(()=>{
    let alive=true;const owner=principal.current;setTranscript([]);setReading(false);setTranscriptError('');if(!selected)return;
    setReading(true);
    loadSalesTranscript(client,selected.id).then(rows=>{if(alive&&owner===principal.current)setTranscript(rows);}).catch(e=>{if(alive&&owner===principal.current)setTranscriptError(e.message);}).finally(()=>{if(alive&&owner===principal.current)setReading(false);});
    return()=>{alive=false;};
  },[selected?.id,refreshRevision,session?.user?.id]);
  async function login(){
    setError('');setBusy(true);
    try {const {error}=await client.auth.signInWithOAuth({provider:'google',options:{redirectTo:new URL('/comercial/',window.location.origin).href,scopes:'openid email profile'}});if(error)throw error;}
    catch {setError('Não foi possível iniciar o login. Tente novamente.');setBusy(false);}
  }
  async function logout(){
    if(loggingOut)return;
    const current=++generation.current;setLoggingOut(true);setLeads([]);setSelected(null);setTranscript([]);setTranscriptError('');setBusy(false);setReading(false);setError('');
    try {const {error}=await client.auth.signOut({scope:'local'});if(error)throw error;if(current===generation.current)setSession(null);}
    catch {if(current===generation.current)setError('Não foi possível sair. Confira a conexão e tente novamente.');}
    finally {if(current===generation.current)setLoggingOut(false);}
  }
  return <>
    <header className="commercial-header"><a href="/" className="commercial-brand"><img src="/assets/crop-logo-mark.png" alt=""/>Ligou <span>Comercial</span></a>{session?.user&&<div><span>{session.user.email}</span><button className="quiet" disabled={loggingOut} onClick={logout}>{loggingOut?'Saindo…':'Sair'}</button></div>}</header>
    <main className="commercial-main">
      {error&&<p className="commercial-error" role="alert">{error}</p>}
      {!client?<section className="login"><p className="kicker">Área restrita</p><h1>Oportunidades do Ligou.</h1><p>{clientError||'Esta prévia ainda não está conectada à área comercial.'}</p><a href="/">Voltar ao website</a></section>
      :session===undefined?<p role="status">Verificando seu acesso…</p>
      :!session?<section className="login"><p className="kicker">Área restrita</p><h1>Oportunidades do Ligou.</h1><p>Acompanhe as empresas que conversaram com o Ligou e o próximo passo combinado.</p><button className="primary" disabled={busy} onClick={login}>{busy?'Abrindo login…':'Entrar com Google'}</button><p className="fine">Os dados são acessíveis somente à conta autorizada da operação Ligou.</p></section>
      :<>
        <div className="commercial-title"><div><p className="kicker">Conversas que viram oportunidades</p><h1>Comercial</h1><p>Até 100 conversas recentes. Informações fornecidas pelos visitantes.</p></div><button className="primary" disabled={busy||loggingOut} onClick={refresh}>{busy?'Atualizando…':'Atualizar'}</button></div>
        <div className="commercial-grid">
          <aside className="lead-list" aria-label="Oportunidades">
            {!busy&&!leads.length&&<p className="empty">Nenhuma oportunidade disponível para esta conta.</p>}
            {leads.map(lead=><button key={lead.id} className={`lead-item ${selected?.id===lead.id?'selected':''}`} onClick={()=>setSelected(lead)} aria-pressed={selected?.id===lead.id}><span>{date(lead.createdAt)}</span><strong>{lead.company}</strong><span>{lead.name}</span><p>{lead.need||'Necessidade ainda não informada'}</p><small className={lead.canFollowUp?'consent yes':'consent'}>{lead.canFollowUp?'Retorno autorizado':'Sem autorização de retorno'}</small></button>)}
          </aside>
          <section className="lead-detail" aria-label="Detalhes da oportunidade">
            {selected?<>
              <p className="kicker">{selected.industry||'Negócio a conhecer'}</p><h2>{selected.company}</h2><p className="detail-name">{selected.name}{selected.region?` · ${selected.region}`:''}</p>
              <dl className="details">{[['Necessidade',selected.need],['Interesse no piloto',selected.interest],['Próximo passo',selected.nextStep],['Telefone',selected.phone],['E-mail',selected.email],['Website',selected.website],['Idiomas',selected.language],['Volume de ligações',selected.callVolume],['Ferramentas atuais',selected.tools]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value||'Não informado'}</dd></div>)}</dl>
              <div className="permission"><strong>{selected.canFollowUp?'Contato posterior autorizado':'Contato posterior não autorizado'}</strong><p>{selected.contactConfirmed?`${selected.confirmedChannel==='phone'?'O telefone':'O e-mail'} foi confirmado na conversa.`:'O contato ainda não foi confirmado na conversa.'} {selected.canFollowUp&&selected.consentChannel?`Canal autorizado: ${selected.consentChannel==='phone'?'telefone':'e-mail'}.`:''}</p></div>
              {selected.summary&&<><h3>Resumo</h3><p>{selected.summary}</p></>}
              <h3>Conversa</h3>{reading?<p role="status">Carregando conversa…</p>:transcriptError?<p className="commercial-error" role="alert">{transcriptError}</p>:transcript.length?<ol className="transcript">{transcript.map(item=><li key={item.id} className={item.role==='user'?'visitor':'ligou'}><div><strong>{item.role==='user'?'Visitante':'Ligou'}</strong>{item.context==='roleplay'&&<span> Demonstração</span>}</div><p>{item.text}</p></li>)}</ol>:<p>Não há transcrição disponível para esta conversa.</p>}
            </>:<p className="empty">Selecione uma oportunidade para ler a conversa.</p>}
          </section>
        </div>
      </>}
    </main>
  </>;
}
ReactDOM.createRoot(document.getElementById('commercial-root')).render(<App/>);
