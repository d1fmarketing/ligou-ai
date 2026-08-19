# Agenda do cliente — como funciona de verdade

Pergunta do RJ (2026-08-19), ao ver a Isa mexendo em projeto GCP e service account:
**"Como que vai ser feito com o cliente? Vai ser toda essa bagunça que tá fazendo comigo?"**

Resposta curta: **não.** O cliente nunca vê projeto, service account, token ou console.

---

## O que o CLIENTE faz

### Caso A — ele já usa Google Calendar (a maioria)

No painel: botão **"Conectar Google Calendar"** → tela do Google *"Ligou quer acessar sua agenda"* →
**Permitir** → pronto. ~30 segundos, uma vez na vida. O mesmo fluxo de qualquer app que ele já conectou.

A partir daí o Ligou lê a agenda **que ele já usa** (com os jobs da equipe dele) e escreve nela. É isso que
ele quer — não um calendário paralelo que ele teria que olhar separado.

### Caso B — ele não usa agenda nenhuma (o cara de pavers com caderno)

**Ele não faz nada.** A Ligou cria a agenda dele no provisionamento e compartilha com o e-mail dele.
Zero setup. É o "Você não usa nenhum sistema de agenda? Sem problema, o Ligou cuida."

Isso segue a regra já fixada no plano: *sistema conectado é dono do domínio dele; sem sistema conectado,
o Ligou é a fonte.*

---

## O que a LIGOU faz (uma vez na vida, não por cliente)

O "trabalho de bastidor" que gerou a pergunta é **setup único do produto**:

1. Um projeto Google da Ligou;
2. Um **app OAuth chamado "Ligou"** — é o nome/logo que o cliente lê na tela de consentimento;
3. Uma service account que administra os calendários gerenciados (Caso B).

Feito uma vez, serve todos os clientes para sempre. Nenhum cliente repete nada disso.

---

## Detalhes do Google que afetam o negócio (verificados na doc oficial, 2026-08-19)

| Fato | Consequência para a Ligou |
|---|---|
| Agenda é **escopo sensível** | O app precisa de **verificação do Google** para ficar sem aviso na tela. Leva de dias a semanas. |
| App em modo **"Testing"** revoga o acesso do cliente **a cada 7 dias** | Inaceitável em produção — o cliente teria que reconectar toda semana. |
| App em **"Produção"** (mesmo com verificação pendente) → acesso **não expira** | Mas aparece *"o Google não verificou este app"* com um "Avançado → prosseguir". |
| Verificação exige domínio verificado, logo, política de privacidade e vídeo demo | Trabalho real, mas paralelo — não bloqueia o piloto. |

**Sequência correta:** publicar em Produção primeiro (mata a expiração de 7 dias) → rodar o piloto com a
telinha de aviso → submeter a verificação em paralelo → aviso some quando aprovar.

Regra de escopo: pedir o **mínimo** (`calendar.events` em vez de `calendar` cheio) — escopo largo aumenta
o atrito da tela e a demora da revisão.

Fontes: [verificação de escopo sensível](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification) ·
[audiência do app / modo Testing](https://support.google.com/cloud/answer/15549945)

---

## Estado atual do código

O adapter (`voice-controller/src/calendar.ts`) **já aceita os dois caminhos** e escolhe sozinho:

- `GOOGLE_SA_CLIENT_EMAIL` + `GOOGLE_SA_PRIVATE_KEY` → service account (Caso B, calendário gerenciado);
- `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + `GOOGLE_REFRESH_TOKEN` → OAuth (Caso A, agenda do cliente);
- nenhum dos dois → adapter falso persistido no Supabase (é o estado de hoje, que deixa o resto do fluxo
  funcionar e o agente ser honesto: *"não consigo confirmar o horário agora, a equipe confirma"*).

Ou seja: **ligar a agenda real é só popular credencial**, sem tocar na lógica de booking, receipts ou
idempotência — que já estão provados por teste.

## Estado: FUNCIONANDO (2026-08-19)

O calendário gerenciado (Caso B) está **no ar e provado em ligação real**: o agente ofereceu
*"Thursday, August 20 at 8:00 AM"* vindo do freeBusy real, o cliente aceitou, e o worker criou o evento
no Google (receipt `accepted`, read-back `2026-08-20T08:00:00-07:00`). A service account já existia; o
que faltava eram dois bugs nossos — variável de ambiente partida pela chave PEM multi-linha, e slots sem
fuso horário. Ambos corrigidos e cobertos por teste (`test/timezone.test.ts`).

### Caso A (agenda do próprio cliente): NO AR (2026-08-19)

O app OAuth **Ligou** existe, está **publicado em Production** (então o acesso do cliente não expira em 7
dias) e o fluxo inteiro foi verificado: o botão do painel gera a URL de consentimento com o client_id certo,
escopo mínimo `calendar.events`, `access_type=offline` + `prompt=consent`, e o Google já responde com a tela
"Escolha uma conta / para continuar em ...supabase.co" — que é exatamente o que o cliente final vê.

- Projeto: `ligou-mvp-68036` · Client: **Ligou Web** (Web application)
- Redirect: `https://ixpbqquvxirvuevjhmrq.supabase.co/functions/v1/google-callback`
- Credenciais: SSM (`/ligou/GOOGLE_OAUTH_CLIENT_ID`, `/ligou/GOOGLE_OAUTH_CLIENT_SECRET`) e secrets das
  Edge Functions. Nunca no repositório.

Enquanto o app não passa pela verificação do Google (escopo de agenda é "sensível"), o cliente vê uma tela
extra de "app não verificado" com um "Avançado → continuar". Isso é aceitável no piloto; a verificação
(domínio, logo, política de privacidade, vídeo) roda em paralelo e some com o aviso.

