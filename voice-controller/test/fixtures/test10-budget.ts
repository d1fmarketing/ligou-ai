// Exact Test 10 provider events were not retained. This sanitized multi-turn
// fixture proves threshold equivalence through the real response.done parser;
// it must never be described as a reconstruction of the provider sequence.
function responseDone(id: string, audioTokens: number) {
  return {
    type: "response.done",
    response: {
      id,
      status: "completed",
      usage: {
        input_tokens: 0,
        output_tokens: audioTokens,
        total_tokens: audioTokens,
        input_token_details: {
          text_tokens: 0,
          audio_tokens: 0,
          cached_tokens: 0,
          cached_tokens_details: { text_tokens: 0, audio_tokens: 0 },
        },
        output_token_details: { text_tokens: 0, audio_tokens: audioTokens },
      },
    },
  } as const;
}

export const TEST10_SYNTHETIC_THRESHOLD_EQUIVALENCE = Object.freeze({
  kind: "synthetic_threshold_equivalence",
  elapsedMs: 432_000,
  applicationTtsCostUsd: 0.001605,
  totalCostUsd: 1.520005,
  responseDoneEvents: [
    responseDone("resp-synthetic-threshold-01", 4_000),
    responseDone("resp-synthetic-threshold-02", 5_000),
    responseDone("resp-synthetic-threshold-03", 4_500),
    responseDone("resp-synthetic-threshold-04", 5_225),
    responseDone("resp-synthetic-threshold-05", 5_000),
  ],
} as const);
