-- Seed: Rocha Plumbing (synthetic tenant — docs/fixtures/rocha-plumbing.md). No real data.
-- Rules seeded as status='aprovado' origem='edicao_manual' (fixture bootstrap; real tenants get these via onboarding interview).

insert into public.tenants (id, slug, name, vertical, status, languages, plan_minutes, timezone)
values ('a0000000-0000-4000-8000-000000000001', 'rocha-plumbing', 'Rocha Plumbing LLC', 'plumbing', 'active', '{en,es}', 400, 'America/Los_Angeles');

-- price rules: structured carries the negotiation band; agent may negotiate between min and target, never below min.
insert into public.rules (tenant_id, origem, escopo, status, category, text, structured) values
('a0000000-0000-4000-8000-000000000001','edicao_manual','servico','aprovado','preco',
 'Diagnostic visit (fee waived if a service is booked): $89–$129, 45 min.',
 '{"service_type":"plumbing_diagnostic","price_min":89,"price_target":129,"duration_min":45,"grant":"AZUL"}'),
('a0000000-0000-4000-8000-000000000001','edicao_manual','servico','aprovado','preco',
 'Drain cleaning (sink, shower drain): $149–$225, about 1 hour.',
 '{"service_type":"drain_cleaning","price_min":149,"price_target":225,"duration_min":60,"grant":"AZUL"}'),
('a0000000-0000-4000-8000-000000000001','edicao_manual','servico','aprovado','preco',
 'Water heater repair: $250–$450, about 2 hours.',
 '{"service_type":"water_heater_repair","price_min":250,"price_target":450,"duration_min":120,"grant":"AZUL"}'),
('a0000000-0000-4000-8000-000000000001','edicao_manual','servico','aprovado','preco',
 'Water heater installation (unit not included): $650–$950, about 4 hours. Estimates above $750 need team confirmation.',
 '{"service_type":"water_heater_install","price_min":650,"price_target":950,"duration_min":240,"grant":"AZUL","amarelo_above":750}'),
('a0000000-0000-4000-8000-000000000001','edicao_manual','servico','aprovado','preco',
 'Localized leak repair: $189–$320, about 1.5 hours.',
 '{"service_type":"leak_repair","price_min":189,"price_target":320,"duration_min":90,"grant":"AZUL"}'),
('a0000000-0000-4000-8000-000000000001','edicao_manual','servico','aprovado','preco',
 'Repipe estimate visit: free, about 1 hour.',
 '{"service_type":"repipe_estimate","price_min":0,"price_target":0,"duration_min":60,"grant":"AZUL"}'),
('a0000000-0000-4000-8000-000000000001','edicao_manual','servico','aprovado','preco',
 'After-hours emergency callout: +$150 on top of the service price. Always confirmed by the team first.',
 '{"service_type":"emergency_callout","surcharge":150,"grant":"AMARELO"}');

-- business profile rules
insert into public.rules (tenant_id, origem, escopo, status, category, text, structured) values
('a0000000-0000-4000-8000-000000000001','edicao_manual','localizacao','aprovado','area',
 'Service area: Orange County, CA — Anaheim, Santa Ana, Irvine, Orange, Tustin, Costa Mesa. Outside the area (e.g. Los Angeles, San Diego): politely decline and offer a generic referral.',
 '{"cities":["Anaheim","Santa Ana","Irvine","Orange","Tustin","Costa Mesa"],"outside_examples":["Los Angeles","San Diego"]}'),
('a0000000-0000-4000-8000-000000000001','edicao_manual','geral','aprovado','agenda',
 'Business hours: Monday–Saturday 08:00–18:00 (Pacific). Emergencies 24/7 with the emergency callout fee.',
 '{"days":"mon-sat","open":"08:00","close":"18:00","tz":"America/Los_Angeles"}'),
('a0000000-0000-4000-8000-000000000001','edicao_manual','geral','aprovado','negociacao',
 'Negotiation: you may negotiate between the minimum and target price of each service. Never below the minimum. Maximum autonomous discount: 10% off target, never below minimum. First-time customers may be offered the diagnostic at $89.',
 '{"max_discount_pct":10}'),
('a0000000-0000-4000-8000-000000000001','edicao_manual','geral','aprovado','emergencia',
 'Emergency handling: active flooding -> instruct shutting the main water valve, then offer emergency callout (team confirms). Gas or CO smell -> NEVER schedule casually; instruct leaving the property and calling 911/utility, then create an urgent case. Water near electrical panel -> instruct switching the breaker off only if safe, maximum urgency case. Sewage backup -> health priority, emergency callout case.',
 '{"classes":["common_leak","active_flooding","gas_co","electrical","sewage"]}');
