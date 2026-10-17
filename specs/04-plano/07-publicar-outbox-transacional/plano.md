# Plano de Implementação — Publicar eventos da Transactional Outbox

Spec relacionada: [`../../03-features/07-publicar-outbox-transacional/spec.md`](../../03-features/07-publicar-outbox-transacional/spec.md)  
Arquitetura relacionada: [`../../02-arquitetura/arquitetura.md`](../../02-arquitetura/arquitetura.md)  
Produto relacionado: [`../../01-produto/spec.md`](../../01-produto/spec.md)  
Feature anterior: [`../06-processar-referencias-fora-de-ordem/plano.md`](../06-processar-referencias-fora-de-ordem/plano.md)  
Status: Implementação verificada — aguardando aprovação final

## 1. Resumo técnico

Completar o fluxo de Transactional Outbox já persistido no PostgreSQL. A implementação adicionará uma porta de `MessagePublisher`, seleção concorrente de eventos, lease persistente, publicação SQS depois do commit, retry com backoff, encaminhamento de falhas persistentes para a DLQ e um worker com shutdown seguro.

O registro original da Outbox será preservado mesmo quando uma mensagem atingir o limite de tentativas. Após a confirmação do envio para `wager-events-dlq.fifo`, ele ficará marcado como aguardando intervenção e deixará de ser selecionável automaticamente. Se a DLQ também estiver indisponível, o evento continuará pendente para nova tentativa e não será descartado.

O publish ocorrerá fora da Unit of Work financeira e não haverá transação distribuída entre PostgreSQL e SQS. A confirmação financeira continuará independente da disponibilidade do publisher. O comportamento aceito é at-least-once: um crash entre o envio ao SQS e a atualização de `published_at` pode produzir uma segunda mensagem com o mesmo `eventId`.

## 2. Decisões aplicadas

- Broker: AWS SQS via LocalStack em desenvolvimento e testes.
- Fila de eventos: `wager-events.fifo`.
- DLQ: `wager-events-dlq.fifo`.
- Deduplicação de transporte: `MessageDeduplicationId = eventId`.
- Ordenação de transporte: `MessageGroupId = aggregateId`.
- Claim: `FOR UPDATE SKIP LOCKED` para selecionar candidatos e lease persistente de 60 segundos para o trabalho fora da transação curta do banco.
- Lote padrão: 50 mensagens.
- Polling padrão: 1 segundo, configurável.
- Retry: `30s`, `1m`, `2m`, `4m` e `5m`.
- Após o quinto retry: publicar uma cópia na DLQ, marcar a linha original como aguardando intervenção e manter o registro para auditoria.
- `published_at`: somente após confirmação do SQS.
- Readiness financeiro: não será derrubado apenas porque o SQS de eventos está indisponível; a falha será exposta em logs e métricas do publisher.
- `OUTBOX_ENABLED=false` por padrão em desenvolvimento/testes unitários.
- Retenção: registros publicados por 30 dias; pendentes e aguardando intervenção não são removidos automaticamente.
- O `README.md` não será alterado.

## 3. Impacto no que já existe

| Componente/arquivo | Mudança planejada | Risco |
|---|---|---|
| `src/modules/messaging/outbox/domain/outbox-message.ts` | Adicionar reidratação, estado de claim, retry, falha e publicação sem alterar o envelope | Alto; qualquer mutação de payload ou `eventId` quebra idempotência |
| `src/modules/messaging/outbox/application/ports/outbox-repository.port.ts` | Adicionar claim, confirmação condicional, retry e encaminhamento para intervenção | Muito alto; contrato incompleto pode perder eventos entre instâncias |
| `src/modules/messaging/outbox/infrastructure/persistence/` | Mapear lease, diagnóstico e estado de intervenção; implementar queries com lock | Muito alto; stale claim pode bloquear ou duplicar trabalho |
| `src/infrastructure/database/migrations/` | Migration reversível para campos de claim/erro/intervenção e índices pendentes | Alto; schema precisa continuar compatível com mensagens já persistidas |
| `src/modules/messaging/sqs/` | Criar porta/adaptador de publicação e configuração da fila de saída | Alto; SDK SQS deve permanecer restrito à infraestrutura |
| `src/modules/messaging/outbox/` | Criar worker, polling, retry, DLQ e shutdown | Alto; falha de ciclo de vida não pode perder evento confirmado |
| `infra/localstack/`, `docker-compose.yml`, `.env.example` | Provisionar fila FIFO/DLQ e variáveis de saída | Médio; ambiente atual de entrada deve continuar reproduzível |
| métricas, logs e health | Instrumentar lag, tentativas, locks, sucesso, falhas e intervenção | Médio; ausência de diagnóstico dificulta recuperação operacional |
| `test/unit/`, `test/integration/` | Cobrir banco real, LocalStack, concorrência, retry e crash recovery | Alto; mocks isolados não comprovam as garantias principais |

## 4. Componentes e contratos

### Domínio

`OutboxMessage` continuará sendo agnóstico de NestJS, MikroORM e AWS. O domínio deverá conseguir:

- reidratar uma linha persistida sem modificar o envelope;
- verificar se está publicada, elegível, em lease ou aguardando intervenção;
- registrar nova tentativa e calcular o próximo horário aprovado;
- registrar falha permanente/intervenção;
- marcar publicação com timestamp somente após a confirmação externa.

### Portas

Criar uma porta `MessagePublisher` com operação equivalente a:

```ts
publish(message: PublishedMessage): Promise<void>;
publishToDeadLetter(message: PublishedMessage): Promise<void>;
```

A porta não deve expor `SendMessageCommand`, `SQSClient` ou detalhes do SDK.

Estender `OutboxRepository` com operações para:

- buscar e reservar lote devido;
- renovar/validar lease quando necessário;
- marcar publicado condicionalmente por `eventId` e claim;
- reagendar retry condicionalmente;
- marcar aguardando intervenção após DLQ confirmada;
- consultar lag e quantidade de pendências.

### Persistência

A migration deve adicionar, no mínimo, os campos necessários para claim e diagnóstico:

- `claimed_by`, nullable;
- `claimed_until`, nullable;
- `last_error_code`, nullable;
- `last_error_at`, nullable;
- `intervention_required`, boolean default `false`;
- `dead_lettered_at`, nullable.

Os índices devem continuar favorecendo mensagens com `published_at IS NULL`, `intervention_required = false` e `next_attempt_at <= now`, sem impedir a recuperação de linhas antigas.

### Transporte SQS

O adapter de saída deve enviar:

- `MessageBody` com `OutboxMessage.toJSON()` serializado;
- `MessageDeduplicationId` igual a `eventId`;
- `MessageGroupId` igual a `aggregateId`;
- atributos de evento para `eventId`, `eventType` e `version`.

O mesmo adapter não deve misturar operações de consumo de entrada com operações de publicação de eventos.

## 5. Sequência de implementação

### Fase 1 — Contratos e persistência

1. Confirmar o baseline da Outbox, do SQS existente e do ciclo de vida da aplicação.
2. Estender o domínio e as portas sem alterar o envelope persistido.
3. Criar e validar a migration reversível de claim, diagnóstico e intervenção.
4. Implementar repository MikroORM com seleção `SKIP LOCKED`, lease e updates condicionais.

### Fase 2 — Broker e configuração

1. Provisionar as filas FIFO de saída e DLQ no LocalStack.
2. Adicionar configuração validada e desligada por padrão.
3. Implementar adapter SQS atrás da porta `MessagePublisher`.
4. Conectar o módulo de Outbox sem tornar o domínio dependente do SDK.

### Fase 3 — Publisher e worker

1. Selecionar lote e atribuir lease persistente.
2. Publicar fora da transação curta do banco.
3. Marcar `published_at` somente após confirmação, com update condicional.
4. Reagendar falhas transitórias usando a política aprovada.
5. Após o quinto retry, enviar para DLQ; somente após confirmação marcar intervenção.
6. Implementar polling, drain, shutdown, logs e métricas.

### Fase 4 — Verificação

1. Cobrir domínio e contratos em testes unitários.
2. Validar migrations, locks, lease e updates condicionais em PostgreSQL real.
3. Validar publicação, FIFO, DLQ e falhas com LocalStack real.
4. Cobrir dois publishers, crash antes/depois do publish, restart, retry e regressão financeira.

### Fase 5 — Entrega

1. Executar typecheck, build e suíte completa.
2. Executar migration `up/down/up` em banco isolado.
3. Registrar evidências para todos os critérios de aceite.
4. Atualizar status de plano/tarefas para aguardando aprovação final, sem aprovar a entrega automaticamente.

## 6. Riscos e mitigação

| Risco | Severidade | Mitigação |
|---|---:|---|
| Dois publishers enviarem a mesma linha | Crítica | `SKIP LOCKED`, lease persistente, updates condicionais e teste com duas instâncias |
| Lease expirar durante publish | Alta | Permitir duplicata at-least-once, confirmar por `eventId` e nunca sobrescrever `published_at` |
| Evento ser marcado antes do envio | Crítica | Separar publish e update; teste de falha controlada antes da confirmação |
| Crash após publish e antes do update | Alta | Manter pendente, repetir com mesmo `eventId` e testar consumidor FIFO/deduplicação |
| Retry apagar ou alterar o evento | Crítica | Payload imutável, migration com diagnóstico separado e testes de hash/envelope |
| SQS indisponível por longo período | Alta | Backoff, métrica de lag, intervenção explícita e DLQ somente após confirmação |
| Falha ao enviar para a DLQ | Alta | Manter linha pendente, não marcar intervenção e tentar novamente |
| Publisher bloquear a API financeira | Alta | Worker separado, readiness financeiro independente e Outbox persistida antes do publish |
| Query de pendências degradar o banco | Média | Índice parcial, lote configurável e consulta por agenda/event_id |
| Shutdown abandonar publicação | Alta | Parar polling, aguardar in-flight e deixar lease expirar/ser recuperado |

## 7. Critérios de aprovação do plano

- Cada tarefa referencia FRs/ACs e possui verificação objetiva.
- A fila de eventos é separada da fila de comandos de entrada.
- O claim persiste no PostgreSQL e não depende somente de memória.
- O payload e o `eventId` permanecem imutáveis em retries.
- `published_at` só é marcado após confirmação do SQS.
- A DLQ não substitui nem apaga o registro original.
- O publisher não participa da Unit of Work financeira.
- Concorrência, crash, retry, restart e shutdown possuem testes reais.
- O README não é alterado e as features anteriores permanecem compatíveis.

## 8. Evidências da implementação

- `bun run typecheck` passou.
- `bun run build` passou.
- `bun test` passou com 113 testes, 0 falhas e 349 expectativas.
- Migration `Migration20261016020000` executou `down/up` com sucesso no PostgreSQL isolado.
- PostgreSQL real validou claim, lease, retry, confirmação condicional e dois publishers concorrentes.
- LocalStack real validou `wager-events.fifo`, `wager-events-dlq.fifo`, envelope FIFO, `eventId`, `aggregateId`, `published_at` e quinto retry para DLQ.
- A regressão completa de HTTP, SQS/Inbox, wallet, ledger, wagering e referências pendentes passou.
