# Cost and Capacity Model

Status: **illustrative architecture model, not a forecast or price quote**. Provider rates and workload assumptions must be refreshed before a commercial decision.

## Unit-cost baseline

Official OpenAI documentation for `gpt-realtime-2.1` lists audio token rates of $32/M input and $64/M output. The Realtime cost guide describes approximately one user audio token per 100 ms and one assistant audio token per 50 ms.

Illustrative wall-clock minute with 45% caller speech and 35% agent speech:

```text
caller:    60s × 45% × 10 tokens/s = 270 input audio tokens
assistant: 60s × 35% × 20 tokens/s = 420 output audio tokens

caller audio cost:    270 / 1,000,000 × $32 = $0.00864
assistant audio cost: 420 / 1,000,000 × $64 = $0.02688
audio-only subtotal:                            $0.03552/min
```

This excludes accumulated text/context/reasoning, transcription, tools, carrier, phone number, recording/storage, AWS, monitoring, support, taxes, and failure/retry overhead. Actual provider usage events are authoritative.

At published starting inbound local SIP rates, the simple audio-plus-origination baseline is approximately:

- OpenAI audio + Twilio US local origination: `$0.03552 + $0.00340 = $0.03892/min`;
- OpenAI audio + Telnyx local inbound starting rate: `$0.03552 + $0.00320 = $0.03872/min`.

The difference is too small to select a carrier without all-in testing.

Sources: [OpenAI model](https://developers.openai.com/api/docs/models/gpt-realtime-2.1), [Realtime costs](https://developers.openai.com/api/docs/guides/realtime-costs), [Twilio SIP pricing](https://www.twilio.com/en-us/sip-trunking/pricing/us), [Telnyx SIP pricing](https://telnyx.com/pricing/elastic-sip).

## Scenario assumptions

| Scenario | Variable all-in per call minute | Fixed allocation per tenant/month | Interpretation |
|---|---:|---:|---|
| Low | $0.05 | $25 | Efficient calls, low context/tool/support burden |
| Base | $0.08 | $45 | Planning midpoint with carrier/model/infra/observability allowance |
| Stress | $0.15 | $75 | Longer context, failures, higher support/infra/provider burden |

Fixed allocation is not a dedicated always-on server. It is an accounting share of database, compute minimums, observability, number, backups, support tooling, and control plane.

## Monthly COGS and gross-margin sensitivity

### Base scenario: $0.08/min + $45 fixed

| Minutes/tenant | Illustrative COGS | GM at $299 | GM at $499 |
|---:|---:|---:|---:|
| 250 | $65 | 78.3% | 87.0% |
| 500 | $85 | 71.6% | 83.0% |
| 1,000 | $125 | 58.2% | 74.9% |
| 2,000 | $205 | 31.4% | 58.9% |

### 400-minute sensitivity

| Scenario | Illustrative COGS | GM at $299 | GM at $499 |
|---|---:|---:|---:|
| Low | $45 | 84.9% | 91.0% |
| Base | $77 | 74.2% | 84.6% |
| Stress | $135 | 54.8% | 72.9% |

These figures exclude acquisition, onboarding labor, general engineering, refunds, and payment fees. They are architecture sensitivity, not company unit economics.

## Capacity model

Illustrative assumptions:

- 22 service days/month;
- 10 service hours/day;
- 15% of a tenant’s daily minutes fall in the busiest hour;
- four-minute average call duration.

For 500 monthly minutes:

```text
busy-hour minutes/tenant = 500 / 22 × 15% = 3.41
busy-hour offered load    = 3.41 / 60 = 0.0568 Erlangs/tenant
busy-hour calls/tenant    = 3.41 / 4 = 0.85 calls/hour
```

| Tenants at 500 min | Busy-hour offered load | Busy-hour call starts | Initial concurrent-session planning band* |
|---:|---:|---:|---:|
| 10 | 0.57 | 8.5/hour | 3–5 |
| 50 | 2.84 | 42.6/hour | 7–11 |
| 100 | 5.68 | 85.2/hour | 12–18 |
| 500 | 28.41 | 426/hour | 45–70 |

\*A conservative engineering band, not a queueing guarantee. Real arrival distribution, call-duration tails, retry traffic, transfers, maintenance, provider caps, and target blocking probability must replace it.

## Capacity gates

Before the first real tenant:

- verify project/account voice model availability and limits;
- verify carrier CPS/concurrency, number, and SIP routing limits;
- set per-tenant and global spend/concurrency guards;
- test graceful overload and provider disconnect;
- confirm no single tenant can exhaust the global pool;
- instrument active sessions, offered/blocked calls, duration, usage, tool latency, and cost.

Before ten tenants:

- derive busy-hour distribution from actual traffic;
- run an Erlang/queueing model with target blocking/answer SLA;
- secure capacity confirmation where public rate limits are insufficient;
- test regional/adapter failover without duplicate actions;
- reconcile provider invoices against Ligou usage receipts.

## AWS cost posture

Fargate bills configured vCPU/memory/storage per second with a minimum duration; it does not make “one task per company forever” economical by itself. The proposed design uses shared stateless services and autoscaled call sessions, while tenant identity stays in data.

RDS cost will be stepwise rather than perfectly per-tenant. Database baseline, Multi-AZ, backup/storage, NAT/network, logs, WAF/load balancing, and idle minimums must be included in the spike. The observed target AWS account has no current ECS cluster or RDS instance in `us-east-1`, so there is no existing Ligou runtime cost to inherit.

Source: [AWS Fargate pricing](https://aws.amazon.com/fargate/pricing/).

## Economic stop conditions

- A provider cannot expose authoritative usage at call/session granularity.
- Unknown/failed actions cause unbounded repeat calls or support work.
- Capacity requires an unverified enterprise allocation before pilot volume.
- The base scenario cannot reach the approved gross-margin floor after measured support and infrastructure.
- Data/isolation requirements force a physical topology whose minimum cost is incompatible with pricing.

Those conditions trigger product/pricing or architecture review, not optimistic spreadsheet adjustment.
