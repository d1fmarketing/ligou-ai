import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectSalesLead, loadSalesLeads, loadSalesTranscript } from '../src/commercial/commercial-data.js';

test('a malformed field cannot become displayed company data or imply callback permission', () => {
  const lead=projectSalesLead({session_id:'test',fields:{company:{value:{hostile:'payload'}},name:{value:'Maria'},main_need:{value:'Organizar agenda'}},followup_consent:true,contact_confirmed:false});
  assert.equal(lead.company,'Empresa não informada');assert.equal(lead.name,'Maria');
  assert.equal(lead.canFollowUp,false);assert.equal(lead.need,'Organizar agenda');
});

test('confirmed contact and explicit permission are both required to display authorized follow-up',()=>{
  const base={session_id:'test',fields:{email:{value:'owner@example.com'}},contact_confirmed:true};
  assert.equal(projectSalesLead({...base,followup_consent:false}).canFollowUp,false);
  assert.equal(projectSalesLead({...base,followup_consent:true}).canFollowUp,true);
});

test('a denied database read surfaces failure instead of inventing an empty successful inbox',async()=>{
  const query={select(){return this;},order(){return this;},limit(){return Promise.resolve({data:null,error:{message:'denied'}});}};
  await assert.rejects(loadSalesLeads({from(){return query;}}),/Não foi possível carregar/);
});

test('invalid selection never queries a transcript',async()=>{
  let queried=false;
  await assert.rejects(loadSalesTranscript({from(){queried=true;}},'../../another'),/Conversa inválida/);
  assert.equal(queried,false);
});
