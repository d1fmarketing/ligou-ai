// Sanitized causal fixture from the first post-Test-10 human onboarding run.
// The production failure was not a provider timeout: an explicitly affirmative
// owner answer was emitted as a string for a boolean coverage field, then a
// non-advancing correction exhausted the directed-follow-up path.
export const TEST11_EMERGENCY_STALL = Object.freeze({
  callId: "916940b1-5387-46dc-94e6-2a625cb88b7b",
  ownerWords:
    "Pode sim, mas só em situação de risco, tipo vazamento incontrolável que pode causar dano grande fora do horário normal, só com aprovação explícita minha. Não tem taxa automática.",
  providerFact: {
    topic: "emergencia",
    field: "service.emergency_eligibility",
    subject: "conserto_vazamento",
    disposition: "answered",
    rule_text:
      "Elegível como emergência apenas em situação de risco, como vazamento incontrolável com potencial de causar dano grande.",
    structured: {
      value:
        "Elegível como emergência apenas em situação de risco, como vazamento incontrolável com potencial de causar dano grande.",
    },
  },
});
