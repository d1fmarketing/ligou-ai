const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function projectSalesLead(row) {
  const fields=row.fields && typeof row.fields==='object' ? row.fields : {};
  const text=(key,fallback='')=>typeof fields[key]?.value==='string'?fields[key].value:fallback;
  const confirmation=row.contact_confirmation;
  const confirmedChannel=['phone','email'].includes(confirmation?.channel)?confirmation.channel:'';
  const contactConfirmed=row.contact_confirmed===true && !!confirmedChannel && !!text(confirmedChannel) && confirmation.value===text(confirmedChannel);
  const consent=row.followup_consent_evidence;
  const canFollowUp=contactConfirmed && row.followup_consent===true && consent?.granted===true && consent.channel===confirmedChannel;
  return {
    id:row.session_id,company:text('company','Empresa não informada'),name:text('name','Nome não informado'),
    need:text('main_need'),industry:text('industry'),region:text('region'),website:text('website'),
    phone:text('phone'),email:text('email'),language:text('language'),callVolume:text('call_volume'),
    tools:text('current_tools'),interest:text('pilot_interest'),nextStep:text('next_step'),summary:text('summary'),
    contactConfirmed,confirmedChannel:contactConfirmed?confirmedChannel:'',canFollowUp,
    consentChannel:canFollowUp?consent.channel:'',
    updatedAt:row.updated_at,createdAt:row.created_at,
  };
}
export async function loadSalesLeads(client) {
  const {data,error}=await client.from('sales_leads').select('session_id,fields,contact_confirmed,contact_confirmation,followup_consent,followup_consent_evidence,created_at,updated_at').order('updated_at',{ascending:false}).limit(100);
  if(error||!Array.isArray(data))throw new Error('Não foi possível carregar as oportunidades. Confira sua conexão e o acesso desta conta.');
  return data.map(projectSalesLead);
}
export async function loadSalesTranscript(client,sessionId) {
  if(!UUID.test(sessionId||''))throw new Error('Conversa inválida.');
  const {data,error}=await client.from('sales_transcript_items').select('id,role,text,context,created_at').eq('session_id',sessionId).order('created_at',{ascending:true}).limit(500);
  if(error||!Array.isArray(data))throw new Error('Não foi possível carregar a conversa.');
  return data;
}
