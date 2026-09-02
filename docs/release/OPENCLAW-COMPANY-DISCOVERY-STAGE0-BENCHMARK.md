# OpenClaw Company Discovery Stage 0 Benchmark

Status: **OPENCLAW_COMPANY_DISCOVERY_STAGE0_NO_GO**  
Benchmarked source: `11f628c2bb79b2b52d96b745dcef71c99d71efa3`  
Raw receipt: `ac7d917c5541138bfb09bfd54e393a29e92ad2cc009b02a605462c4fe6b813f5`

## Outcome

The OpenClaw runtime passed isolation, subscription, MCP, multi-architecture, cleanup, and security qualification. It did **not** win the Company Discovery workload.

| Metric | DirectModel | OpenClaw |
| --- | ---: | ---: |
| Successful / cleanup proved | 6/6 | 6/6 |
| Average quality | 64.34% | 53.56% |
| Real-public quality | 51.42% | 41.34% |
| Median latency | 34.8 s | 65.5 s |
| p95 observed latency | 80.9 s | 70.9 s |
| Subscription requests | 6 | 21 |
| Input tokens | 7,984 | 137,920 |
| Output tokens | 7,284 | 9,106 |
| Marginal API charge | $0.00 | $0.00 |

DirectModel won both corpus groups: 77.27% versus 65.78% on synthetic/hostile cases, and 51.42% versus 41.34% on reviewed real-public cases.

## Billing invariant

- Provider: `openai-codex`, model `gpt-5.6-sol`.
- Billing basis: `chatgpt_subscription`.
- `OPENAI_API_KEY` visible to the text process: **false**.
- Marginal API charge: **$0.00** for both adapters.

## Isolation and cleanup

- AMD64 benchmark: 12/12 valid attempts and 12/12 proved cleanup receipts.
- ARM64: cell/bridge topology, both MCP tools, deterministic result, and full cleanup passed in 9.0 s.
- Final bridge images: AMD64 `sha256:56ac0ffc…`; ARM64 `sha256:9800a025…`.
- ECR scan: complete with zero findings on both architectures.
- ARM64 point observation: cell 364 MiB / 19 PIDs; bridge 38.43 MiB / 9 PIDs.

## Saturation

Parallelism 2 produced one successful provider request and one pre-provider `subscription concurrency limit exceeded` rejection. Observed peak parallelism was 1; both leases cleaned up completely. Receipt: `1f11afe3da08c53e01b3086484757fa7de287e2618c3dec903366aa384534145`.

## Security review

Canonical scan `152cd839-8033-4658-a099-921425255753` covers the complete diff with eight reviewed surfaces and zero reportable findings. The native workbench publication failed before recovery; the same scan directory was sealed with the plugin finalizer and independently validated. Report hash: `030bfc7bef40736cc363aebb44c0a9c8dde151d67354b73ef1ef8b7b1539c872`.

## Product limitation

The current candidate contract can express descriptive facts, structured services/prices/durations, and emergency guidance. It cannot yet express territory, operating hours, guarantees, or booking restrictions as typed executable claims. This alone prevents Stage 0 approval against the requested product contract.

## Decision

`OPENCLAW_COMPANY_DISCOVERY_STAGE0_NO_GO`

OpenClaw remains technically viable as an ephemeral worker, but it is lower-quality and substantially heavier than DirectModel for this workload. No paid tenant or Stage 1 capability is enabled.

One next action: Keep the OpenClaw adapter disabled and run internal Company Discovery on DirectModel while extending the Ligou claim contract for territory, hours, guarantees, and booking restrictions before any new OpenClaw audition.
