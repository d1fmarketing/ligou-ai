# ADR-011: Telephony Provider

- Status: **Experimental**
- Date: 2026-08-17

## Context

Twilio and Telnyx can both supply inbound SIP foundations. Starting list price does not reveal number portability, support, webhook correctness, transfer behavior, media quality, capacity, or all-in cost.

## Experiment decision

Run the same inbound US-number/SIP/voice-provider test through Twilio and Telnyx where commercially feasible. Select only after the hard gates pass.

## Hard gates

- signed webhook validation and replay protection;
- called-number-to-tenant binding;
- 8 kHz call quality, DTMF/hangup, interruption;
- SIP setup/recovery and provider disconnect;
- transfer path required by future escalation without enabling it in pilot;
- number ownership/portability and exit path;
- concurrency/CPS/capacity confirmation;
- normalized usage/billing reconciliation;
- support and incident-response fit.

## Consequences

- Carrier remains replaceable behind a TelephonyAdapter.
- Initial scope is inbound only.
- A small per-minute difference is not decisive.

## No decision yet

Neither Twilio nor Telnyx is accepted by this ADR.
