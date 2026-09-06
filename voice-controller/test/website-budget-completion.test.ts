import { afterEach, expect, test } from "bun:test";
import { reconcileBudgetReservations } from "../src/budget.ts";
import { _setClient } from "../src/rules.ts";

const uuid = (n:number) => `${String(n).padStart(8,"0")}-1111-4111-8111-111111111111`;
function candidate(n:number, overrides:Record<string,unknown>={}) {
  return { ownerId:uuid(100), requestId:uuid(200+n), interviewId:uuid(n), callId:uuid(n), tenantId:uuid(300),
    state:"closing", callStatus:"ended", providerTerminationReason:"agent_ended_session", approvalReceiptId:uuid(400+n), canComplete:true, ...overrides };
}
function harness(rows:ReturnType<typeof candidate>[], conflictCall?:string) {
  const completed=new Set<string>(), calls:Array<{name:string,args:any}>=[];
  _setClient({
    rpc:async(name:string,args:any)=>{
      calls.push({name,args});
      if(name==="claim_budget_reconciliation")return {data:null,error:null};
      if(name==="list_website_interview_terminal_candidates")return {data:rows.filter(row=>!completed.has(row.callId)).slice(0,args.p_limit),error:null};
      if(name==="record_website_interview_completion"){
        completed.add(args.p_call);
        return args.p_call===conflictCall ? {data:null,error:{message:"interview_completion_conflict"}} :
          {data:{receiptId:uuid(900),outcome:args.p_outcome,callId:args.p_call},error:null};
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    from(){throw new Error("terminal candidate RPC owns the read-only eligibility scan");},
  } as any);
  return {calls,completed,records:()=>calls.filter(x=>x.name==="record_website_interview_completion")};
}
afterEach(()=>_setClient(null));

test("four stale terminal interviews get unfinished receipts once, unblocking next complete candidate",async()=>{
  const rows=[1,2,3,4].map(n=>candidate(n,{canComplete:false}));rows.push(candidate(5));
  const h=harness(rows);
  expect(await reconcileBudgetReservations()).toBe(0);
  expect(h.records().map(x=>[x.args.p_call,x.args.p_outcome])).toEqual([1,2,3,4].map(n=>[uuid(n),"unfinished"]));
  expect(rows.slice(0,4).every(row=>row.state==="closing")).toBe(true);
  await reconcileBudgetReservations();
  expect(h.records().at(-1)?.args).toEqual({p_owner:uuid(100),p_call:uuid(5),p_request:uuid(205),p_outcome:"complete",p_approval:uuid(405)});
  await reconcileBudgetReservations();
  expect(h.records()).toHaveLength(5);
  expect(h.calls.filter(x=>x.name==="list_website_interview_terminal_candidates").every(x=>x.args.p_limit===4)).toBe(true);
});

test("manual, error, killed and incomplete interviews can never infer complete",async()=>{
  for(const overrides of [
    {state:"unfinished",canComplete:false,approvalReceiptId:null},
    {state:"reviewing",canComplete:false},
    {providerTerminationReason:"caller_hung_up",canComplete:true},
    {callStatus:"error",canComplete:true},
    {callStatus:"killed_budget",canComplete:true},
    {callStatus:"killed_deadline",canComplete:true},
    {approvalReceiptId:null,canComplete:true},
  ]) {
    const h=harness([candidate(1,overrides)]);await reconcileBudgetReservations();
    expect(h.records()).toHaveLength(1);
    expect(h.records()[0]!.args.p_outcome).toBe("unfinished");
    expect(h.records()[0]!.args.p_approval).toBe(overrides.approvalReceiptId===null?null:uuid(401));
  }
});

test("completion conflict does not retry mutation and next scan excludes the existing receipt",async()=>{
  const h=harness([candidate(1)],uuid(1));await reconcileBudgetReservations();await reconcileBudgetReservations();
  expect(h.records()).toHaveLength(1);
});

test("malformed or nonterminal candidate is rejected without a completion mutation",async()=>{
  for(const overrides of [{ownerId:"bad"},{callStatus:"active"},{canComplete:"true"},{state:"complete"},{approvalReceiptId:"not-a-receipt"}]) {
    const h=harness([candidate(1,overrides)]);await reconcileBudgetReservations();expect(h.records()).toHaveLength(0);
  }
});
