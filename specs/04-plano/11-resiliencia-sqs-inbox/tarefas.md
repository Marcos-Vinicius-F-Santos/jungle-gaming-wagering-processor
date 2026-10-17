# Tarefas — Resiliência operacional do processamento SQS/Inbox

Plano relacionado: [`./plano.md`](./plano.md)  
Spec relacionada: [`../../03-features/11-resiliencia-sqs-inbox/spec.md`](../../03-features/11-resiliencia-sqs-inbox/spec.md)  
Arquitetura: [`../../02-arquitetura/arquitetura.md`](../../02-arquitetura/arquitetura.md)  
Produto: [`../../01-produto/spec.md`](../../01-produto/spec.md)  

Status: Implementação verificada — aguardando aprovação final  

## Regra das tarefas

Executar uma tarefa por vez, na ordem de dependência. Cada tarefa deve registrar arquivos alterados, comando de verificação e resultado. Não alterar regras financeiras, contrato HTTP ou `README.md` sem uma decisão explícita fora deste escopo.

## Fase 1 — Baseline e contratos

- [x] **T-001 [FR-001..FR-011, AC-001..AC-010]** Confirmar o baseline do consumer, Inbox e ambiente local
  - Mapear `SqsWagerTransactionConsumer`, `MessageConsumer`, `InboxRepository`, `UnitOfWork`, `SQS_CONFIG`, Docker Compose e migrations existentes.
  - Registrar os pontos atuais de ack, retry, `PROCESSING`, `PROCESSED`, shutdown e in-flight.
  - **Verificação:** `bun run typecheck` passou; `bun test test/unit/sqs-consumer.test.ts test/integration/sqs.inbox.test.ts test/integration/wagering.atomicity.test.ts` passou com 7 testes e 27 expectativas; nenhum comportamento financeiro foi alterado.

- [x] **T-002 [FR-002, FR-005, BR-001..BR-005]** Definir o contrato de claim/lease do Inbox
  - Criar read/write models e resultado explícito para `CLAIMED`, `PROCESSED`, `IN_FLIGHT`, `PAYLOAD_CONFLICT` e estados equivalentes necessários.
  - Definir duração da lease, renovação, expiração e comportamento de tentativa concorrente.
  - **Verificação:** `bun run typecheck` e `bun test test/unit/inbox-claim.contracts.test.ts` passaram com 3 testes e 6 expectativas; o contrato não expõe MikroORM ao consumer.

- [x] **T-003 [FR-002, FR-005, FR-006]** Definir o contrato de ciclo de vida do consumer
  - Formalizar estados de polling, drain, in-flight, stopped e redelivery.
  - Definir quando novas mensagens deixam de ser iniciadas e quando o processo pode encerrar.
  - **Verificação:** `bun run typecheck` e `bun test test/unit/consumer-lifecycle.test.ts` passaram com 2 testes e 7 expectativas; o contrato cobre drain, bloqueio de novas mensagens e encerramento sem tarefas em voo.

## Fase 2 — Persistência e recuperação do Inbox

- [x] **T-004 [FR-002, FR-005, FR-006]** Criar migration reversível de lease do Inbox, se necessária
  - Adicionar somente os campos necessários para claim/lease, como `claimed_by`, `lease_until` e `processing_started_at`.
  - Preservar a chave `(consumer_name, message_id)`, payload hash, tentativas e diagnóstico existentes.
  - **Verificação:** `bun run migration:up`, `bun run migration:down`, `bun run migration:up` passaram no PostgreSQL real; `bun run typecheck` passou; a migration criou o índice de recuperação de leases.

- [x] **T-005 [FR-002, FR-005, BR-001..BR-005]** Atualizar entidade, domínio, port e repository do Inbox
  - Implementar claim condicional, renovação, expiração e liberação segura.
  - Diferenciar lease ativa, lease expirada, Inbox processado e conflito de payload.
  - **Verificação:** `bun run typecheck` passou; `bun test test/unit/inbox-message.test.ts test/integration/inbox.claim.test.ts` passou com 5 testes e 21 expectativas; claim, lease ativa/expirada, reclaim, corrida entre dois managers e conflito de payload foram validados.

- [x] **T-006 [FR-003, FR-004, FR-005, FR-009]** Garantir transições atômicas de falha e recuperação
  - Confirmar rollback completo antes do commit.
  - Permitir nova tentativa depois da expiração sem reaplicar resultado terminal.
  - **Verificação:** `bun test test/integration/inbox.claim.test.ts test/integration/wagering.atomicity.test.ts` passou com 4 testes e 12 expectativas; claim/reclaim concorrente e rollback financeiro foram confirmados sem efeitos parciais.

## Fase 3 — Consumer e injeção de falhas

- [x] **T-007 [FR-002, FR-004, FR-008]** Integrar o claim/lease ao fluxo do consumer
  - Reutilizar `ProcessWagerTransactionUseCase` e preservar a Unit of Work financeira.
  - Impedir que uma lease ativa seja processada por outra instância.
  - Manter replay terminal sem novo efeito e conflito de payload sem chamada financeira.
  - **Verificação:** `bun run typecheck` passou; `bun test test/unit/sqs-consumer.test.ts test/unit/inbox-claim.contracts.test.ts test/unit/consumer-lifecycle.test.ts` passou com 9 testes e 31 expectativas; `bun test test/integration/sqs.inbox.test.ts test/integration/inbox.claim.test.ts` passou com 3 testes e 11 expectativas; o wiring real do claim/lease e o fluxo financeiro SQS passaram.

- [x] **T-008 [FR-003, FR-004, FR-007, FR-008]** Criar fault injection somente para testes
  - Implementar pontos configuráveis antes do commit, depois do commit antes do ack e durante shutdown.
  - Encerrar ou bloquear somente processos do harness; provider desabilitado por padrão.
  - **Verificação:** `bun run typecheck` e `bun test test/unit/sqs-fault-injection.test.ts test/unit/sqs-consumer.test.ts` passaram com 6 testes e 22 expectativas; checkpoints são desabilitados por padrão, não têm rota HTTP e o crash pós-commit é propagado.

- [x] **T-009 [FR-004, FR-006, FR-007]** Ajustar ack, redelivery e shutdown
  - Garantir ack somente após commit.
  - Parar novas leituras em `SIGTERM`, aguardar in-flight dentro do limite e devolver visibilidade quando necessário.
  - **Verificação:** `bun run typecheck` e `bun test test/unit/sqs-consumer.test.ts` passaram com 5 testes e 21 expectativas; o teste de drain confirma bloqueio de novas mensagens, devolução durante shutdown e espera por in-flight; a integração SQS/Inbox anterior confirmou ack após commit.

- [x] **T-010 [FR-008, FR-011]** Preservar classificação, retry e DLQ
  - Confirmar resultados de negócio, manter falhas transitórias sem ack e preservar encaminhamento de permanentes.
  - Não alterar backoff, limite de tentativas ou TTL de referências.
  - **Verificação:** `bun test test/unit/sqs-consumer.test.ts test/unit/sqs-fault-injection.test.ts test/integration/sqs.inbox.test.ts` passou com 8 testes e 29 expectativas; retry, conflito de payload, envelope permanente, ack e fluxo real SQS/Inbox permaneceram compatíveis.

## Fase 4 — Orquestração de três instâncias

- [x] **T-011 [FR-001, FR-006, FR-010]** Criar composição Docker de resiliência
  - Adicionar composição ou override dedicado com PostgreSQL, LocalStack e três serviços de aplicação independentes.
  - Configurar healthchecks, filas, banco compartilhado, consumerName comum e identificação da instância.
  - **Verificação:** `docker compose -f docker-compose.resilience.yml config` passou; `docker compose -f docker-compose.resilience.yml up -d --build` construiu a imagem, executou migrações e iniciou os três processos; `docker compose ... ps` confirmou `resilience-app-1/2/3` como `running healthy`; `/health/live` respondeu `200 {"status":"ok"}`.
  - **Evidência:** `docker-compose.resilience.yml`, `Dockerfile.resilience`, `src/infrastructure/database/mikro-orm.migrations.config.ts`, `src/app.module.ts` e `package.json`.

- [x] **T-012 [FR-001, FR-002, FR-005, FR-009]** Criar harness de cenários com dados isolados
  - Gerar IDs por execução, enviar mensagens, consultar banco e validar Inbox, transações, ledger e Outbox.
  - Evitar consumo de mensagens de execuções anteriores e produzir diagnóstico por cenário.
  - **Verificação:** `bun run typecheck` passou; `bun run test:resilience` passou com 1 teste, 12 expectativas e duas execuções consecutivas com wallet `90.00`, um ledger, uma transação, Inbox `PROCESSED` e dois eventos Outbox por execução.
  - **Evidência:** `test/resilience/resilience.harness.test.ts`, `test/resilience/pg.d.ts`, `package.json` e portas de diagnóstico em `docker-compose.resilience.yml`.

- [x] **T-013 [FR-001, FR-002, FR-009, AC-001, AC-002, AC-009]** Testar concorrência entre três instâncias
  - Entregar a mesma mensagem e mensagens de wallets iguais/diferentes em paralelo.
  - Confirmar um único efeito na wallet compartilhada e paralelismo permitido nas demais.
  - **Verificação:** `bun test test/resilience/resilience.concurrency.test.ts` passou com 1 teste e 11 expectativas; a duplicata terminou com uma transação/ledger e saldo `90.00`, duas wallets distintas também terminaram com saldo `90.00`, e a fila foi drenada.
  - **Evidência:** `test/resilience/resilience.concurrency.test.ts` e `docker-compose.resilience.yml` (`SQS_MAX_NUMBER_OF_MESSAGES=1`).

## Fase 5 — Crash, restart e shutdown

- [x] **T-014 [FR-003, AC-003]** Testar crash antes do commit
  - Injetar encerramento antes da confirmação da Unit of Work.
  - Confirmar ausência de efeito parcial e processamento completo pela instância seguinte.
  - **Verificação:** `bun run typecheck` passou; com `docker-compose.resilience.before-commit.yml`, `resilience-app-1` foi encerrada antes do commit e `resilience-app-2/3` permaneceram saudáveis; `bun test test/resilience/resilience.crash-before-commit.test.ts` passou com 1 teste e 4 expectativas, saldo final `90.00`, uma transação, um ledger e Inbox `PROCESSED`.
  - **Evidência:** `docker-compose.resilience.before-commit.yml`, `test/resilience/resilience.crash-before-commit.test.ts` e `SQS_TEST_FAULT_ACTION=KILL` em `sqs-fault-injection.port.ts`.

- [x] **T-015 [FR-004, AC-004]** Testar crash depois do commit e antes do ack
  - Bloquear o intervalo entre commit e `DeleteMessage` e encerrar a instância.
  - Aguardar redelivery e confirmar replay seguro sem segundo efeito.
  - **Verificação:** com `docker-compose.resilience.after-commit.yml`, `bun test test/resilience/resilience.crash-after-commit.test.ts` passou com 1 teste e 5 expectativas; app-1 foi encerrada após o commit, a composição base foi restaurada, e o resultado final manteve saldo `90.00`, uma transação, um ledger e dois eventos Outbox.
  - **Evidência:** `docker-compose.resilience.after-commit.yml`, `test/resilience/resilience.crash-after-commit.test.ts` e `SQS_TEST_FAULT_ACTION=KILL` em `sqs-fault-injection.port.ts`.

- [x] **T-016 [FR-005, FR-006, AC-005]** Testar lease abandonada e reinício
  - Deixar uma mensagem em estado recuperável, encerrar a instância e aguardar expiração.
  - Reiniciar outra instância e confirmar retomada segura.
  - **Verificação:** com `docker-compose.resilience.lease-recovery.yml`, `bun test test/resilience/resilience.lease-recovery.test.ts` passou com 1 teste e 5 expectativas; após a lease expirar e a composição base reiniciar, `attempts >= 2`, Inbox `PROCESSED`, saldo `90.00`, uma transação e um ledger.
  - **Evidência:** `docker-compose.resilience.lease-recovery.yml` e `test/resilience/resilience.lease-recovery.test.ts`.

- [x] **T-017 [FR-007, AC-006]** Testar `SIGTERM` durante mensagem em voo
  - Iniciar processamento lento, enviar `SIGTERM` e observar drain.
  - Confirmar que mensagens não iniciadas não são aceitas e que mensagens incompletas ficam para redelivery.
  - **Verificação:** com `docker-compose.resilience.sigterm.yml`, `bun test test/resilience/resilience.sigterm.test.ts` passou com 1 teste e 4 expectativas; após SIGTERM e drain/redelivery, saldo `70.00`, três transações, três lançamentos e três Inbox `PROCESSED`; composição base restaurada.
  - **Evidência:** `docker-compose.resilience.sigterm.yml` e `test/resilience/resilience.sigterm.test.ts`.

- [x] **T-018 [FR-008, AC-007, AC-008]** Testar falha transitória e permanente em processo real
  - Simular indisponibilidade transitória e envelope/poison message inválido.
  - Confirmar visibilidade, backoff, limite de tentativas, DLQ e ausência de efeito financeiro indevido.
  - **Verificação:** com `docker-compose.resilience.failures.yml`, `bun test test/resilience/resilience.failures.test.ts` passou com 1 teste e 7 expectativas; a mensagem válida recuperou após PostgreSQL indisponível, e a poison terminou `FAILED_PERMANENT`, sem efeito financeiro, na DLQ.
  - **Evidência:** `docker-compose.resilience.failures.yml` e `test/resilience/resilience.failures.test.ts`.

## Fase 6 — Observabilidade, regressão e comando

- [x] **T-019 [FR-011]** Instrumentar diagnóstico de resiliência
  - Adicionar logs e métricas controladas para claim, replay, redelivery, crash, restart, shutdown, retry e DLQ.
  - Evitar IDs como tags de alta cardinalidade e payload financeiro nos logs.
  - **Verificação:** `bun run typecheck` e `bun test test/unit/sqs-consumer.test.ts` passaram com 6 testes e 27 expectativas; foram validados contadores agregáveis para claim/replay/redelivery/lifecycle, logs operacionais sem payload financeiro e tags sem IDs de mensagem.
  - **Evidência:** `src/modules/messaging/sqs/application/sqs-wager-transaction.consumer.ts` e `test/unit/sqs-consumer.test.ts`.

- [x] **T-020 [FR-009, FR-010, AC-009, AC-010]** Implementar `bun run test:resilience`
  - Registrar o script, o harness e a ordem de subida/limpeza dos serviços.
  - Emitir resumo por cenário, duração, resultado, mensagens e invariantes finais.
  - **Verificação:** `bun run typecheck` passou; `bun run test:resilience` executou duas rodadas isoladas, sete cenários por rodada, 14/14 aprovados, emitiu resumo com duração/status por cenário e terminou com código 0 após limpeza Docker.
  - **Evidência:** `test/resilience/run-resilience.ts`, `package.json`, os overrides `docker-compose.resilience.*.yml` e os testes em `test/resilience/`.

- [x] **T-021 [FR-001..FR-011]** Executar regressão financeira e HTTP
  - Rodar testes de wallet, BET, WIN, LOSS, REFUND, ROLLBACK, referências pendentes, consultas, Outbox, health e reconciliação.
  - Confirmar que nenhuma regra financeira foi alterada.
  - **Verificação:** `bun run typecheck`, `bun run build`, `bun run test:unit` (150 testes, 435 expectativas) e `bun run test:integration` (56 testes, 224 expectativas) passaram com código 0. A primeira execução de integração revelou descoberta duplicada de entidades; a configuração foi corrigida e a repetição passou sem falhas.
  - **Evidência:** `src/app.module.ts`, `package.json`, `test/unit/` e `test/integration/`.

- [x] **T-022 [FR-001..FR-011, AC-001..AC-010]** Executar convergência e preparar aprovação
  - Auditar Spec ↔ plano ↔ tarefas ↔ código ↔ testes.
  - Registrar comandos, ambiente, resultados, limitações e ausência de alteração do README.
  - Atualizar os documentos para `Implementação verificada — aguardando aprovação final`, sem aprovar automaticamente.
  - **Verificação:** FR-001..FR-011 e AC-001..AC-010 estão cobertos por tarefas, código e testes; `bun run typecheck`, `bun run build`, `bun run test:unit`, `bun run test:integration` e `bun run test:resilience` passaram. O comando de resiliência executou 14/14 cenários nas duas rodadas. A limitação prevista de teste de carga p50/p95/p99 permanece fora desta lista. O `README.md` não foi alterado nesta implementação.
  - **Evidência:** `spec.md`, `plano.md`, este arquivo, `src/`, `test/`, `docker-compose.resilience.yml` e `test/resilience/run-resilience.ts`.

## Dependências e ordem

`T-001` precede todas as demais. `T-002` e `T-003` precedem `T-004`–`T-010`. `T-005` e `T-006` precedem os cenários concorrentes. `T-008` precede `T-014` e `T-015`. `T-011` e `T-012` precedem `T-013`–`T-018`. `T-019` pode ocorrer em paralelo após o contrato do consumer. `T-020` depende do harness. `T-021` e `T-022` são finais.

## Fora da execução desta lista

- Implementar teste de carga completo com aquecimento, duração de dois minutos e relatório p50/p95/p99.
- Alterar regras financeiras ou contratos HTTP.
- Implementar autenticação.
- Criar dashboard ou deploy de produção.
- Apagar dados fora dos identificadores criados pelo harness.
