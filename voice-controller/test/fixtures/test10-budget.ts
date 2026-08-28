// Sanitized causal budget fixture reconstructed from Test 10's durable timing
// and live-meter shape. The application opening contributes only its known TTS
// floor; Realtime spend enters through the actual response.done usage contract.
export const TEST10_CAUSAL_BUDGET_FIXTURE = Object.freeze({
  elapsedMs: 432_000,
  applicationTtsCostUsd: 0.001605,
  totalCostUsd: 1.520005,
  responseDone: {
    type: "response.done",
    response: {
      id: "resp-test-10-budget",
      status: "completed",
      usage: {
        input_tokens: 0,
        output_tokens: 23_725,
        total_tokens: 23_725,
        input_token_details: {
          text_tokens: 0,
          audio_tokens: 0,
          cached_tokens: 0,
          cached_tokens_details: { text_tokens: 0, audio_tokens: 0 },
        },
        output_token_details: { text_tokens: 0, audio_tokens: 23_725 },
      },
    },
  },
} as const);
