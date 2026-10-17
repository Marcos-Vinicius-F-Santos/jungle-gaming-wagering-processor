# Tarefas — Publicar eventos da Transactional Outbox

Plano relacionado: [`./plano.md`](./plano.md)  
Spec relacionada: [`../../03-features/07-publicar-outbox-transacional/spec.md`](../../03-features/07-publicar-outbox-transacional/spec.md)  
Arquitetura: [`../../02-arquitetura/arquitetura.md`](../../02-arquitetura/arquitetura.md)  
Produto: [`../../01-produto/spec.md`](../../01-produto/spec.md)

## Regra das tarefas

Cada tarefa é pequena o suficiente para revisão individual, referencia os requisitos que implementa e descreve como verificar a conclusão. Nenhuma tarefa deve marcar a si própria como aprovada. A implementação deve ocorrer em ordem, uma tarefa por vez, respeitando as dependências.

Status: Implementação verificada — aguardando aprovação final da feature.

## Fase 1 — Baseline, domínio e schema

- [x] **T-001 [FR-001..FR-012]** Confirmar o baseline da Outbox e do ciclo de vida
  - Arquivos/módulos: `src/modules/messaging/outbox/`, `src/modules/messaging/sqs/`, bootstrap, migrations e testes existentes.
  - Revisar o contrato atual de `OutboxMessage`, o repository de enqueue, o `UnitOfWork`, o SQS de entrada e o padrão de logs/métricas.
  - Registrar qualquer divergência entre o schema existente e a Spec aprovada, sem alterar o README.
  - **Verificação:** baseline typecheck/testes focados passa e o relatório lista os pontos que serão alterados.

- [x] **T-002 [FR-003, FR-004, FR-005, FR-006, FR-008]** Estender o domínio `OutboxMessage`
  - Arquivos/módulos: `src/modules/messaging/outbox/domain/outbox-message.ts` e testes unitários.
  - Implementar reidratação, elegibilidade, lease, retry, falha/intervenção e publicação sem alterar `eventId`, payload, tipo, versão ou `occurredAt`.
  - Preservar o envelope JSON estável e valores monetários como strings.
  - **Verificação:** testes comprovam transições válidas, imutabilidade do payload, backoff `30/60/120/240/300` e ausência de marcação prematura.

- [x] **T-003 [FR-001, FR-004, FR-005, FR-006, FR-007]** Criar migration reversível de claim e diagnóstico
  - Arquivos/módulos: `src/infrastructure/database/migrations/`, entidade da Outbox.
  - Adicionar `claimed_by`, `claimed_until`, `last_error_code`, `last_error_at`, `intervention_required` e `dead_lettered_at`, com defaults, nulabilidade e índices necessários.
  - Preservar linhas existentes e compatibilidade com o índice de mensagens pendentes.
  - **Verificação:** migration `up/down/up` em PostgreSQL real confirma defaults, constraints, índices e reversibilidade.

- [x] **T-004 [FR-001, FR-004, FR-005, FR-006, FR-007]** Implementar entidade e reidratação MikroORM
  - Arquivos/módulos: `src/modules/messaging/outbox/infrastructure/persistence/entities/`, repository MikroORM.
  - Mapear os novos campos sem expor MikroORM ao domínio e garantir que datas sejam copiadas sem mutação acidental.
  - **Verificação:** teste de integração cria, carrega e atualiza mensagens antigas e novas sem alterar o envelope.

- [x] **T-005 [FR-001, FR-004, FR-005, FR-006, FR-007]** Estender a porta `OutboxRepository`
  - Arquivos/módulos: `src/modules/messaging/outbox/application/ports/outbox-repository.port.ts` e adapter PostgreSQL.
  - Definir contratos para claim em lote, atualização condicional de publicação, retry, intervenção/DLQ e métricas de lag.
  - O contrato deve representar conflito de claim sem depender de tipos MikroORM.
  - **Verificação:** typecheck comprova que a aplicação usa somente a porta e testes de contrato cobrem sucesso, linha ausente, claim expirado e concorrência.

## Fase 2 — Broker, configuração e wiring

- [x] **T-006 [FR-003, FR-007, FR-011]** Provisionar fila FIFO de eventos e DLQ
  - Arquivos/módulos: `infra/localstack/01-create-sqs-queues.sh`, políticas locais e `docker-compose.yml` somente se necessário.
  - Criar `wager-events.fifo` e `wager-events-dlq.fifo` com FIFO e deduplicação compatíveis, sem alterar as filas de entrada.
  - **Verificação:** LocalStack sobe de forma reproduzível e `list-queues/get-queue-attributes` confirma as filas e atributos esperados.

- [x] **T-007 [FR-003, FR-005, FR-007, FR-010]** Criar configuração da Outbox
  - Arquivos/módulos: portas/configuração de SQS, `.env.example` e módulo de Outbox.
  - Adicionar `OUTBOX_ENABLED`, URLs, publisher name, intervalo, lote, lease, backoff e retention com validação de limites.
  - Manter publisher desligado por padrão e não exigir SQS de eventos para o fluxo financeiro quando desabilitado.
  - **Verificação:** testes de configuração cobrem defaults, valores inválidos e ambiente habilitado/desabilitado; nenhum segredo é incluído.

- [x] **T-008 [FR-003, FR-007, FR-011]** Criar porta e adapter `MessagePublisher`
  - Arquivos/módulos: `src/modules/messaging/sqs/application/ports/`, `src/modules/messaging/sqs/infrastructure/`.
  - Implementar envio para a fila principal e para a DLQ, com `MessageBody`, `MessageDeduplicationId = eventId`, `MessageGroupId = aggregateId` e atributos de evento.
  - Manter o SDK AWS restrito ao adapter; o consumer de entrada não deve receber responsabilidades de publisher.
  - **Verificação:** testes do adapter/fake SQS confirmam o request completo, erros propagados e encerramento do `SQSClient`.

- [x] **T-009 [FR-002, FR-007, FR-012]** Conectar o publisher ao módulo sem alterar o fluxo financeiro
  - Arquivos/módulos: `src/modules/messaging/outbox/outbox.module.ts`, módulos de aplicação e bootstrap.
  - Registrar portas, adapter, repository e worker por injeção de dependência.
  - Garantir que a Unit of Work financeira apenas persista a Outbox e não injete o publisher.
  - **Verificação:** bootstrap com publisher desabilitado mantém HTTP/SQS de entrada funcionando; habilitado injeta todas as dependências corretamente.

## Fase 3 — Claim, publicação e retry

- [x] **T-010 [FR-001, FR-007, FR-008]** Implementar seleção concorrente e lease persistente
  - Arquivos/módulos: repository MikroORM e serviço de aplicação do publisher.
  - Selecionar somente `published_at IS NULL`, `intervention_required = false`, `next_attempt_at <= now` e lease livre/expirada.
  - Usar `FOR UPDATE SKIP LOCKED` para obter o lote e persistir `claimed_by`/`claimed_until` por evento antes de liberar a transação curta.
  - **Verificação:** duas instâncias não recebem o mesmo claim ativo; lease expirada torna a linha recuperável; mensagens de outros agregados continuam disponíveis.

- [x] **T-011 [FR-003, FR-004, FR-008]** Implementar publicação e confirmação condicional
  - Arquivos/módulos: caso de uso/serviço do publisher e repository.
  - Publicar o envelope fora da transação de claim e, após confirmação, executar update condicional por `eventId`, `published_at IS NULL` e claim válido.
  - Limpar lease quando marcar publicado e não reabrir uma mensagem já publicada.
  - **Verificação:** sucesso marca `published_at`; falha antes da confirmação não marca; publisher atrasado não sobrescreve publicação já confirmada.

- [x] **T-012 [FR-005, FR-006, FR-008]** Implementar retry, backoff e diagnóstico
  - Arquivos/módulos: domínio, serviço do publisher e repository.
  - Classificar timeout, rede, throttling, SQS indisponível e conflitos transitórios como retryáveis.
  - Incrementar `attempts`, salvar código/data de erro, limpar ou substituir lease e calcular o próximo horário sem alterar o envelope.
  - **Verificação:** testes com relógio confirmam os cinco intervalos, preservação de `pendingSince/occurredAt` e processamento de outras mensagens após uma falha.

- [x] **T-013 [FR-006, FR-008]** Implementar limite de tentativas, DLQ e intervenção
  - Arquivos/módulos: serviço do publisher, repository, adapter SQS e entidade.
  - Depois do quinto retry, publicar a cópia na `wager-events-dlq.fifo` com o mesmo `eventId`; somente após confirmação marcar `dead_lettered_at` e `intervention_required` na linha original.
  - Se o envio à DLQ falhar, manter a linha pendente e elegível para retry, sem marcar publicação/intervenção.
  - **Verificação:** teste real confirma cópia na DLQ, retenção da linha original e ausência de seleção automática após intervenção; falha na DLQ mantém recuperação possível.

- [x] **T-014 [FR-009, FR-010, FR-012]** Implementar worker, polling e shutdown
  - Arquivos/módulos: worker de Outbox, módulo e ciclo de vida NestJS.
  - Processar lote configurável, continuar após falha individual, parar novos claims em shutdown e aguardar operações em voo.
  - Não marcar evento como publicado durante drain sem confirmação externa.
  - **Verificação:** testes de ciclo de vida cobrem polling vazio, falha individual, `SIGTERM`, restart e recuperação após lease expirada.

- [x] **T-015 [FR-010, FR-012]** Implementar logs, métricas e outbox lag
  - Arquivos/módulos: worker, repository, portas de métricas/logger e health/readiness quando aplicável.
  - Registrar `eventId`, tipo, agregado, publisher, tentativa, outcome e erro sem payload financeiro completo ou segredo.
  - Emitir métricas para seleção, sucesso, retry, DLQ, intervenção, conflito, lag e duração.
  - **Verificação:** testes/inspeção confirmam campos estruturados, ausência de payload completo e que indisponibilidade do SQS não derruba o readiness financeiro.

## Fase 4 — Testes

- [x] **T-016 [FR-003, FR-004, FR-005, FR-006, FR-008]** Cobrir domínio e contratos em testes unitários
  - Arquivos/módulos: `test/unit/`.
  - Cobrir reidratação, envelope, imutabilidade, elegibilidade, lease, backoff, publicação, falha, intervenção e classificação de erros.
  - **Verificação:** suíte unitária passa sem PostgreSQL, LocalStack ou mocks que substituam a verificação de integração.

- [x] **T-017 [FR-001, FR-004, FR-005, FR-007]** Cobrir migration, claim e lease no PostgreSQL real
  - Arquivos/módulos: `test/integration/`, migrations e repository.
  - Testar seleção due, filtro de publicados/intervenção, `SKIP LOCKED`, lease expirada, update condicional e rollback.
  - **Verificação:** duas conexões reais não processam o mesmo claim ativo e o banco permanece consistente após falha.

- [x] **T-018 [FR-002, FR-003, FR-004, FR-011]** Cobrir publicação real no LocalStack
  - Arquivos/módulos: `test/integration/` e adapter SQS.
  - Persistir evento via fluxo financeiro, confirmar que não aparece antes do commit, publicar depois e validar body, atributos, group e deduplication id.
  - **Verificação:** mensagem real é recebida em `wager-events.fifo`, `published_at` é preenchido somente depois e o envelope permanece estável.

- [x] **T-019 [FR-005, FR-006, FR-008]** Cobrir retry, crash e recuperação
  - Arquivos/módulos: `test/integration/` com publisher controlável/falhas do LocalStack.
  - Simular falha antes do publish, depois do publish e antes do update de `published_at`; simular indisponibilidade temporária e restart.
  - **Verificação:** nenhum evento confirmado no banco é perdido; duplicata, quando ocorrer, usa o mesmo `eventId`; retry respeita backoff.

- [x] **T-020 [FR-007, FR-008]** Cobrir dois publishers concorrentes
  - Arquivos/módulos: `test/integration/` e duas instâncias do worker.
  - Disputar o mesmo lote e mensagens de agregados diferentes, incluindo lease expirada.
  - **Verificação:** não há perda, registro Outbox adicional ou `published_at` revertido; duplicidade observada é limitada ao contrato at-least-once.

- [x] **T-021 [FR-006, FR-008]** Cobrir limite de retries e DLQ
  - Arquivos/módulos: `test/integration/`, LocalStack e fixtures de eventos inválidos/transitoriamente falhos.
  - Executar cinco retries, enviar a cópia à DLQ, validar intervenção e testar falha no próprio envio à DLQ.
  - **Verificação:** a linha original é preservada, a DLQ recebe o evento somente após o limite e falha na DLQ não causa descarte.

- [x] **T-022 [FR-009, FR-010, FR-012]** Cobrir shutdown e regressão financeira
  - Arquivos/módulos: testes de ciclo de vida, `test/unit/` e `test/integration/` existentes.
  - Validar drain, publisher desligado, broker indisponível e processamento HTTP/SQS/referências pendentes durante a operação do worker.
  - **Verificação:** BET, WIN, LOSS, REFUND, ROLLBACK, Inbox, referências, wallet, ledger e Outbox continuam consistentes.

## Fase 5 — Entrega e verificação

- [x] **T-023 [FR-001..FR-012]** Executar convergência técnica e preparar aprovação
  - Arquivos/módulos: código, Spec, plano, tarefas e evidências de testes.
  - Rodar `bun run typecheck`, `bun run build`, `bun test`, migration `up/down/up`, LocalStack com as duas filas e os testes de concorrência/restart.
  - Relacionar evidências aos AC-001..AC-012, registrar limitações e atualizar somente a documentação de feature/plano/tarefas.
  - **Verificação:** todos os comandos definidos passam, nenhum AC fica sem evidência e o status final fica `Implementação verificada — aguardando aprovação final`.

## Dependências e ordem

`T-001` precede `T-002`–`T-005`. `T-003` precede `T-004` e `T-017`. `T-006`–`T-009` precedem o worker. `T-010`–`T-013` precedem `T-014` e os testes de recuperação. `T-016` pode acompanhar a implementação, mas `T-017`–`T-022` dependem das respectivas fases funcionais. `T-023` é a verificação final e não aprova a entrega automaticamente.

## Evidências finais

- Typecheck e build passaram.
- Suíte completa passou com 113 testes, 0 falhas e 349 expectativas; os testes específicos finais do worker passaram com 5/5.
- Migration `down/up` passou no PostgreSQL isolado.
- PostgreSQL real validou claim, lease, retry, confirmação condicional e concorrência.
- LocalStack real validou publicação FIFO, `published_at`, DLQ e preservação da linha original após o quinto retry.
- Nenhuma tarefa foi marcada como aprovação final; a revisão da entrega permanece pendente.

## Fora desta lista

- Consumidores de eventos de negócio e sua deduplicação interna.
- Exatamente uma entrega ou transação distribuída PostgreSQL/SQS.
- Mudança de regras financeiras, Inbox, API ou referências pendentes.
- Dashboard, tracing OpenTelemetry, autenticação, deploy e rollback de infraestrutura produtiva.
- Limpeza automática definitiva da Outbox e alteração do README.
