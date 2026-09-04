import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {collectSqlText} from './local-website-interview-actual-schema.mjs';
import {createOnboardingAgenda,parseOnboardingAgenda} from '../../voice-controller/src/onboarding-agenda.ts';

test('psql UTF-8 chunk boundaries preserve exact duplicated question evidence',()=>{
  const binding={interviewId:'i',callId:'c',draftId:'d',draftHash:'a'.repeat(64),sourceResultId:'r',sourceResultHash:'b'.repeat(64)};
  const agenda=createOnboardingAgenda(binding,[{id:'area',source:'ambiguity',subject:'area',questionPt:'Qual é a área?',coverageRefs:['area.coverage'],relatedItemIds:[],blocking:true}]);
  const bytes=Buffer.from(JSON.stringify(agenda));
  const split=bytes.indexOf(Buffer.from('á'))+1;
  const stream=new PassThrough(),read=collectSqlText(stream);
  stream.write(bytes.subarray(0,split));stream.end(bytes.subarray(split));
  const decoded=JSON.parse(read());
  assert.equal(decoded.items[0].questionPt,'Qual é a área?');
  assert.deepEqual(parseOnboardingAgenda(decoded,binding),agenda);
});

test('several split multibyte codepoints remain byte-exact in SQL diagnostics',()=>{
  const original='São Rafael — aprovação confirmada 🔒';
  const bytes=Buffer.from(original),stream=new PassThrough(),read=collectSqlText(stream);
  for(const byte of bytes)stream.write(Buffer.from([byte]));stream.end();
  assert.equal(read(),original);
});
