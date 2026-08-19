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

### Caso A (agenda do próprio cliente): código 100% pronto, faltam 2 strings

Tudo está no ar e testado: botão **"Conectar Google Calendar"** no painel, Edge Functions `google-connect`
(gera o consentimento) e `google-callback` (troca o código por refresh token e guarda por tenant), tabela
`connector_accounts` com RLS que **não expõe o token nem ao dono**, e o adapter passou a **preferir a agenda
do cliente** quando existe, caindo na gerenciada quando não. Sem o app OAuth, o botão degrada honesto
(`oauth_app_not_configured`) e nada quebra.

**O único passo que o Google não deixa automatizar:** criar o OAuth Client "Web application". Não existe API
pública para isso — só o Console ([confirmado na doc](https://developers.google.com/identity/protocols/oauth2));
as vias programáticas (`gcloud iap oauth-clients`, `gcloud iam oauth-clients`) servem a IAP e workforce
federation, não a apps de consumidor.

**Estado (2026-08-19):** a Isa entrou no Console pelo navegador do RJ (conta `d1f.dmarketing`, projeto
Ligou MVP), abriu o formulário e preencheu o nome do app como **Ligou** — mas o Console é uma SPA pesada e
travou a automação (`script injection timed out`) no seletor de e-mail de suporte. Os cliques que faltam
são poucos e estão abaixo. Nada foi criado ainda.

RJ faz uma vez, no projeto **`ligou-mvp-68036`** (o mesmo onde já vive a service account que funciona):

1. Console → APIs & Services → **OAuth consent screen**: External, nome do app **Ligou**, e-mail de suporte,
   escopo `.../auth/calendar.events`, e **publicar em Production** (senão o acesso do cliente morre a cada 7 dias).
2. **Credentials → Create credentials → OAuth client ID → Web application**, com o redirect autorizado:
   `https://ixpbqquvxirvuevjhmrq.supabase.co/functions/v1/google-callback`
3. Mandar o **Client ID** e o **Client secret** para a Isa — ela grava nos secrets e o botão liga na hora.
