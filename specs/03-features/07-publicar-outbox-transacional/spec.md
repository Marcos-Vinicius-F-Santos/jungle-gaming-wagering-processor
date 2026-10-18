# Spec da Feature — Publicar eventos da Transactional Outbox

Status: Aprovada em 2026-10-16
Projeto: Distributed Wagering Processor  
Onde vive no código: `src/modules/messaging/outbox/`, publisher SQS e worker de Outbox  
Spec do produto: [`../../01-produto/spec.md`](../../01-produto/spec.md)  
Arquitetura: [`../../02-arquitetura/arquitetura.md`](../../02-arquitetura/arquitetura.md)  
Feature anterior: [`../06-processar-referencias-fora-de-ordem/spec.md`](../06-processar-referencias-fora-de-ordem/spec.md)

> Esta feature completa a segunda metade da Transactional Outbox. A transação financeira continuará apenas persistindo o evento; um worker separado será responsável por publicá-lo depois do commit.

## 1. Objetivo

Publicar no broker os eventos de integração confirmados na Outbox sem perder eventos depois de um commit, mesmo com crash do processo, indisponibilidade temporária do SQS, múltiplas instâncias e concorrência entre publishers.

O publisher deve selecionar somente mensagens elegíveis, proteger a seleção com lock persistente, publicar o envelope serializado, marcar `published_at` somente depois da confirmação do broker e reagendar falhas transitórias com backoff. Se o processo cair entre a publicação e a marcação, o evento poderá ser publicado novamente; consumidores devem usar `eventId` para idempotência.

Esta feature não altera regras financeiras, não cria um segundo fluxo de negócio e não promete entrega exatamente uma vez. A garantia é: eventos confirmados na mesma Unit of Work financeira não são removidos ou perdidos por falhas do publisher, e duplicatas são limitadas ao comportamento at-least-once do broker.

## 2. Como funciona hoje

O sistema já possui:

- `OutboxMessage` com `eventId`, `aggregateId`, `eventType`, `version`, `payload`, `attempts`, `nextAttemptAt`, `occurredAt` e `publishedAt`;
- eventos mínimos `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged` e `WagerTransactionPendingReference`;
- persistência da Outbox na mesma Unit of Work da transação financeira;
- tabela `outbox_messages` com chave única por `event_id`, campos de retry, `published_at` e índice para pendências;
- adapter SQS para receber, apagar e alterar a visibilidade de mensagens de entrada;
- portas de observabilidade para logs estruturados, métricas e relógio;
- retenção definida para registros publicados e nenhuma remoção automática de pendências.

Ainda não existe:

- contrato de `MessagePublisher` para publicação de eventos;
- método de repository para selecionar/lockar mensagens vencidas;
- atualização persistente de tentativa, backoff e `published_at`;
- worker de Outbox com polling e shutdown seguro;
- configuração e fila de saída de eventos no LocalStack;
- teste real com dois publishers concorrentes, falha do broker e crash entre publicação e confirmação.

## 3. Requisitos funcionais

### FR-001 — Selecionar eventos pendentes

O publisher deve buscar mensagens cujo `published_at IS NULL` e `next_attempt_at <= now`, ordenadas por `next_attempt_at` e `event_id`, em lote configurável.

A seleção deve usar `FOR UPDATE SKIP LOCKED` ou mecanismo persistente equivalente, de forma que dois publishers não processem simultaneamente a mesma linha durante a mesma janela de claim. Mensagens já publicadas ou ainda fora da agenda não podem ser selecionadas.

### FR-002 — Publicar somente depois do commit

O worker deve operar somente sobre registros já confirmados no PostgreSQL. Nenhum publish pode ser disparado dentro da Unit of Work financeira que grava wallet, ledger, transação, Inbox e Outbox.

### FR-003 — Publicar o envelope estável

O publisher deve enviar o JSON produzido pelo `OutboxMessage.toJSON()`, preservando:

- `eventId`;
- `eventType`;
- `aggregateId`;
- `correlationId`;
- `causationId`, quando existir;
- `occurredAt` em ISO-8601;
- `version`;
- `data` com valores monetários como `MoneyProps`, nunca instâncias de `Money`.

O `eventId` deve ser propagado como identificador de deduplicação do evento. A mensagem enviada não pode incluir payload financeiro completo em logs, mas o payload do evento deve permanecer íntegro no broker.

### FR-004 — Confirmar publicação somente após sucesso

Depois que o adapter do broker confirmar a publicação, o publisher deve marcar `published_at` na Outbox. Se a publicação falhar, `published_at` deve continuar nulo.

A atualização de `published_at` deve ser condicionada a `published_at IS NULL`, para que um publisher atrasado não reverta ou reabra uma mensagem já confirmada por outro processo.

### FR-005 — Reagendar falhas transitórias

Falhas transitórias do broker ou do PostgreSQL devem incrementar `attempts`, calcular `next_attempt_at` com backoff e manter a mensagem pendente. O retry não pode alterar o payload, o `eventId`, o `occurredAt` ou qualquer dado financeiro.

O backoff padrão sugerido é `30s`, `1m`, `2m`, `4m` e `5m`, alinhado à política de falhas transitórias SQS já aprovada. Nenhuma tentativa pode apagar o evento ou marcar publicação sem confirmação.

### FR-006 — Tratar falhas permanentes sem perda

Uma falha de configuração, envelope inválido ou contrato incompatível deve ser registrada como falha permanente e impedir o loop de falhar silenciosamente. O registro da Outbox deve continuar auditável e não pode ser removido automaticamente.

O comportamento operacional para falhas permanentes — manter pendente para intervenção ou encaminhar uma cópia para uma DLQ de eventos — depende da decisão aprovada na seção de perguntas abertas. Em qualquer opção, a linha original não pode ser considerada publicada sem confirmação do destino definido.

### FR-007 — Suportar concorrência entre publishers

Múltiplas instâncias devem poder executar o worker simultaneamente. Cada evento deve ser processado por no máximo um publisher dentro do claim ativo, sem bloquear indefinidamente eventos de outras wallets ou agregados.

Se houver crash após o claim e antes da confirmação, o evento deve voltar a ser elegível por uma estratégia persistente de retry ou timeout de claim. Nenhum lock em memória pode ser a única proteção contra perda.

### FR-008 — Tolerar crash entre publish e marcação

Se o processo publicar o evento e morrer antes de atualizar `published_at`, outra tentativa poderá publicar o mesmo `eventId`. Isso é permitido e deve ser coberto por teste.

O publisher não deve tentar compensar a duplicata removendo o evento, alterando seu identificador ou usando uma transação que englobe o PostgreSQL e o SQS, pois o broker não participa da Unit of Work SQL.

### FR-009 — Executar shutdown seguro

Em `SIGTERM` ou `OnModuleDestroy`, o worker deve parar de buscar novos eventos, aguardar publicações em andamento dentro de um limite seguro e deixar eventos não confirmados disponíveis para recuperação posterior.

O shutdown não pode marcar como publicado um evento que não recebeu confirmação do broker.

### FR-010 — Instrumentar operação

O publisher deve registrar logs estruturados sem payload financeiro completo, incluindo quando aplicável `eventId`, `eventType`, `aggregateId`, `attempt`, `publisherName`, `outcome` e código de erro.

Deve emitir métricas para, no mínimo:

- eventos selecionados;
- eventos publicados;
- falhas transitórias;
- falhas permanentes;
- duplicatas possíveis por crash/retry;
- conflitos de claim/lock;
- quantidade de pendências;
- idade do evento mais antigo e outbox lag;
- duração da publicação;
- eventos aguardando intervenção.

### FR-011 — Preservar os eventos existentes

Os quatro eventos mínimos já definidos devem ser publicados sem alteração de tipo, versão ou semântica. `WalletBalanceChanged` deve continuar sendo emitido somente quando o saldo muda, e `WagerTransactionPendingReference` somente quando a operação entra em pendência.

### FR-012 — Não alterar o fluxo financeiro

Falha ou lentidão do publisher não pode bloquear a confirmação da transação financeira depois que a Outbox foi persistida. A API, o consumidor SQS de entrada e o worker de referências devem continuar funcionando com o publisher desligado ou com o broker de eventos indisponível.

## 4. Regras de negócio e operação

### BR-001 — Outbox é fonte persistente

O PostgreSQL é a fonte de verdade dos eventos pendentes. Memória local, fila interna, timer ou estado de um processo não substituem `outbox_messages`.

### BR-002 — At-least-once

A entrega externa é at-least-once. Uma duplicata do mesmo evento pode ocorrer quando houver crash depois do publish e antes de `published_at`. O identificador estável para deduplicação é `eventId`.

### BR-003 — Nunca marcar antes do publish

Não é permitido preencher `published_at` antes da confirmação do SQS. Também não é permitido tratar a seleção/claim como publicação concluída.

### BR-004 — Ordem de processamento

O publisher deve respeitar a ordem de elegibilidade (`next_attempt_at`, depois `event_id`) dentro de cada lote, mas a feature não promete ordenação global de eventos entre instâncias, agregados ou retries.

Se a fila de saída for FIFO, o `MessageGroupId` e a política de ordenação devem ser definidos explicitamente e não podem ser usados como substituto da idempotência persistente.

### BR-005 — Retenção

Eventos publicados devem permanecer retidos pelo período configurado de 30 dias. Eventos pendentes ou aguardando intervenção não devem ser removidos automaticamente.

### BR-006 — Payload imutável

Depois do commit financeiro, o payload, tipo, versão, `eventId` e `occurredAt` do evento não podem ser reescritos para permitir uma nova tentativa.

### BR-007 — Classificação de falhas

Falhas de rede, timeout, throttling, indisponibilidade do SQS e conflitos transientes do PostgreSQL são retryáveis. Falhas de validação do envelope, configuração inválida ou contrato não suportado são permanentes e exigem observabilidade explícita.

### BR-008 — Isolamento do claim

O lock usado para selecionar mensagens deve ser curto e não deve ser mantido durante uma operação longa de rede quando isso puder bloquear outros publishers. Se o desenho liberar o lock antes do publish, deverá existir claim/lease persistente com expiração e atualização condicional por `eventId`.

## 5. Contrato do evento de saída

O destino externo sugerido para esta feature é uma fila SQS de eventos, separada da fila de entrada:

- `wager-events.fifo`;
- `wager-events-dlq.fifo`, caso a decisão de DLQ seja aprovada.

O contrato lógico enviado é:

```ts
interface PublishedIntegrationEvent {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: Record<string, unknown>;
}
```

Parâmetros de transporte sugeridos:

- `MessageBody`: `JSON.stringify(evento)`;
- `MessageDeduplicationId`: `eventId`, quando o destino FIFO estiver habilitado;
- `MessageGroupId`: grupo configurável, inicialmente por `aggregateId` ou por `walletId` quando o envelope permitir essa informação;
- atributos de mensagem: `eventType`, `eventVersion` e `eventId`, sem duplicar regras no consumidor.

O uso de FIFO e a escolha exata do `MessageGroupId` são sugestões de transporte. O requisito obrigatório é que o evento seja reconhecível e deduplicável por `eventId`.

## 6. Configuração proposta

As variáveis abaixo são propostas e devem ser confirmadas no plano:

```text
OUTBOX_ENABLED=false
OUTBOX_PUBLISHER_NAME=wager-event-publisher-v1
OUTBOX_EVENTS_QUEUE_URL=http://localhost:4566/000000000000/wager-events.fifo
OUTBOX_EVENTS_DLQ_URL=http://localhost:4566/000000000000/wager-events-dlq.fifo
OUTBOX_POLL_INTERVAL_MS=1000
OUTBOX_BATCH_SIZE=50
OUTBOX_CLAIM_TIMEOUT_SECONDS=60
OUTBOX_RETRY_BACKOFF_SECONDS=30,60,120,240,300
OUTBOX_PUBLISHED_RETENTION_DAYS=30
```

`OUTBOX_ENABLED=false` deve permitir executar testes financeiros e o consumidor de entrada sem publicar eventos. Em ambientes com publisher habilitado, fila e configuração ausentes devem falhar de forma explícita no readiness ou no startup, conforme a decisão operacional aprovada.

## 7. Critérios de aceite

### AC-001 — Publicação após commit

Dado um evento persistido e confirmado na Outbox, quando o worker estiver habilitado, então ele deve publicar o envelope no SQS e marcar `published_at` somente após a confirmação do broker.

### AC-002 — Evento não publicado antes do commit

Dado que a Unit of Work financeira falhe ou sofra rollback, então nenhum evento correspondente deve aparecer no SQS e nenhum registro persistido deve ficar marcado como publicado.

### AC-003 — Crash antes do publish

Dado que o PostgreSQL confirme o evento e o processo morra antes de publicar, quando outra instância iniciar, então ela deve selecionar a linha pendente e publicar o evento sem exigir reprocessamento da transação financeira.

### AC-004 — Crash depois do publish

Dado que o SQS confirme o publish e o processo morra antes de `published_at`, quando o evento for tentado novamente, então o mesmo `eventId` poderá ser enviado novamente, sem criar outro evento na Outbox ou alterar o payload.

### AC-005 — Dois publishers

Dado que dois publishers selecionem a mesma Outbox simultaneamente, então apenas um deve manter o claim ativo por vez e não deve haver perda do evento. O teste deve validar que os registros publicados e os eventos observados no broker são compatíveis com at-least-once.

### AC-006 — Falha transitória e backoff

Dado que o SQS esteja indisponível, quando o publisher tentar enviar, então `published_at` deve permanecer nulo, `attempts` deve aumentar, `next_attempt_at` deve respeitar o backoff aprovado e o worker deve continuar processando outras mensagens.

### AC-007 — Falha permanente

Dado um envelope ou configuração inválida, quando o publisher detectar a falha, então ela deve ser registrada com `eventId` e código estável, a mensagem não deve ser marcada como publicada e o comportamento definido para intervenção/DLQ deve ser aplicado.

### AC-008 — Payload estável

Dado qualquer um dos quatro eventos mínimos, quando for publicado, então o JSON recebido deve ser igual ao payload da Outbox, conter `MoneyProps` em strings e preservar tipo, versão e identificadores de correlação.

### AC-009 — Shutdown

Dado que o processo receba `SIGTERM` durante o polling ou uma publicação, então ele deve parar de aceitar novos lotes, aguardar o trabalho em voo dentro do limite definido e deixar não confirmados para retry posterior.

### AC-010 — Retenção e pendência

Dado um evento publicado há menos de 30 dias ou um evento ainda pendente, quando qualquer rotina de limpeza for executada, então o registro não deve ser removido fora da política configurada; pendentes nunca devem ser removidos automaticamente.

### AC-011 — Métricas e logs

Dado um ciclo de sucesso, retry, lock concorrente e falha permanente, então logs estruturados e métricas devem permitir identificar o evento, o publisher, a tentativa, a idade e o resultado sem expor payload financeiro completo.

### AC-012 — Regressão financeira

Dado que o publisher esteja desligado, indisponível ou reiniciando, quando uma transação HTTP, SQS ou referência pendente for processada, então o efeito financeiro e a persistência atômica da Outbox devem permanecer iguais aos fluxos aprovados anteriores.

## 8. Casos de erro e edge cases

- nenhuma mensagem pendente → o worker aguarda o próximo polling sem erro;
- evento com `published_at` preenchido → nunca selecionar novamente;
- evento fora de `next_attempt_at` → permanecer pendente até a agenda;
- falha do SQS durante um lote → reagendar somente os itens não confirmados;
- sucesso no SQS e falha no `UPDATE published_at` → repetir com o mesmo `eventId` e registrar possível duplicata;
- dois publishers atualizando a mesma linha → a atualização condicional permite somente uma confirmação;
- processo cai depois do claim e antes do publish → a lease/timeout aprovada devolve o evento à fila de trabalho;
- PostgreSQL reinicia → eventos confirmados permanecem recuperáveis pela tabela;
- SQS reinicia → eventos ficam pendentes e seguem o backoff;
- payload JSON não serializável ou incompatível → falha permanente auditável, sem marcar publicado;
- `eventId` repetido na Outbox → constraint única mantém um único registro;
- evento de `LOSS` sem mudança de saldo → publicar `WagerTransactionProcessed`, sem `WalletBalanceChanged`;
- referência pendente → publicar `WagerTransactionPendingReference` uma vez na entrada da pendência;
- limpeza/retention executada com evento pendente → não apagar a linha;
- publisher desligado em ambiente de desenvolvimento → não impedir as demais funcionalidades quando `OUTBOX_ENABLED=false`;
- fila de saída ausente com publisher habilitado → falhar de forma explícita e observável, sem descartar eventos.

## 9. Fora de escopo desta feature

- Alterar regras financeiras, idempotência de transações, Inbox ou referências fora de ordem.
- Criar novos eventos de domínio além dos quatro eventos mínimos já aprovados.
- Implementar consumidores de eventos de negócio ou suas deduplicações internas.
- Garantir exatamente uma entrega ou transação distribuída entre PostgreSQL e SQS.
- Reprocessar financeiramente uma transação porque a publicação falhou.
- Criar dashboard, tracing OpenTelemetry ou sistema completo de alertas.
- Limpeza automática definitiva da Outbox; somente a retenção e a proteção de pendências são contratadas.
- Teste de carga completo com três instâncias; a feature deve cobrir concorrência e recuperação focadas no publisher.
- Alterar o `README.md`.

## 10. Suposições, perguntas abertas e sugestões

### Decisões já definidas pelo produto e pela arquitetura

- [x] A Outbox é gravada na mesma transação financeira e publicada somente depois do commit.
- [x] O publisher deve tolerar crash entre publicação e `published_at`.
- [x] Consumidores devem deduplicar por `eventId`; exatamente uma entrega não é requisito.
- [x] O SQS/LocalStack é o broker de integração adotado pelo projeto.
- [x] Os eventos mínimos e seus momentos de emissão já estão definidos.
- [x] Falhas transitórias devem usar retry/backoff e não podem causar perda do evento.
- [x] Outbox publicada tem retenção configurável de 30 dias; pendências não são removidas automaticamente.
- [x] Dois publishers e reinício fazem parte da verificação obrigatória.

### Sugestões para aprovação antes do plano

- [x] **Fila de saída:** criar `wager-events.fifo` e `wager-events-dlq.fifo`, separadas da fila de entrada. Isso torna o teste local explícito e evita misturar comandos de entrada com eventos de integração.
- [x] **Deduplicação de transporte:** usar `eventId` como `MessageDeduplicationId` e manter a deduplicação de negócio por `eventId` no consumidor. A FIFO reduz duplicatas no intervalo do SQS, mas não substitui a idempotência.
- [x] **Message group:** usar `aggregateId` como `MessageGroupId` para preservar ordem por agregado sem serializar todo o sistema. Se a análise do payload mostrar que eventos de wallet exigem outra ordem, registrar uma decisão antes da implementação.
- [x] **Claim:** usar lease persistente com `claimed_until` e `claimed_by`, além de `FOR UPDATE SKIP LOCKED`, porque o publish ocorre fora da transação curta do banco. A lease sugerida é de 60 segundos e deve expirar sem intervenção manual.
- [x] **Retry:** reutilizar `30s`, `1m`, `2m`, `4m` e `5m`; após o quinto retry, manter pendente com `waiting_intervention` ou enviar uma cópia à DLQ sem remover o registro original. Sugere-se manter a linha original para auditoria e recuperação.
- [x] **Habilitação:** manter `OUTBOX_ENABLED=false` por padrão em desenvolvimento/testes unitários e habilitar explicitamente nos testes de integração com LocalStack.
- [x] **Readiness:** considerar o publisher separado do readiness financeiro: SQS de eventos indisponível deve gerar alerta e métrica, mas não tornar a API financeira indisponível quando a persistência SQL continua saudável.

## 11. Definition of Done desta feature

- [x] Esta Spec foi revisada e aprovada.
- [x] Fila de saída, DLQ, group, lease e política de retry foram aprovados.
- [x] O contrato `MessagePublisher` está atrás de uma porta de aplicação.
- [x] O repository seleciona eventos com proteção concorrente persistente.
- [x] O publisher envia o envelope estável e usa `eventId` como identificador de deduplicação.
- [x] `published_at` só é preenchido depois da confirmação do broker.
- [x] Falhas transitórias mantêm o evento pendente e respeitam o backoff.
- [x] Crash antes e depois do publish está coberto por falhas controladas e recuperação por retry.
- [x] Dois publishers concorrentes não perdem eventos nem criam registros adicionais na Outbox.
- [x] Shutdown, logs, métricas e outbox lag estão verificados.
- [x] Testes com PostgreSQL e LocalStack reais passam, incluindo retry e DLQ.
- [x] Fluxos financeiros HTTP, SQS de entrada e referências pendentes permanecem aprovados.
- [x] O plano e as tarefas foram criados depois da aprovação formal desta Spec.
