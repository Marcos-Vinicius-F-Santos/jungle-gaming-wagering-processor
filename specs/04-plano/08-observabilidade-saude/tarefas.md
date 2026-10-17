# Tarefas — Observabilidade e saúde

Plano relacionado: [`./plano.md`](./plano.md)  
Spec relacionada: [`../../03-features/08-observabilidade-saude/spec.md`](../../03-features/08-observabilidade-saude/spec.md)  
Arquitetura: [`../../02-arquitetura/arquitetura.md`](../../02-arquitetura/arquitetura.md)  
Produto: [`../../01-produto/spec.md`](../../01-produto/spec.md)

## Regra das tarefas

Cada tarefa é pequena o suficiente para revisão individual, referencia os requisitos que implementa e descreve como verificar a conclusão. A implementação deve ocorrer em ordem, uma tarefa por vez. Nenhuma tarefa aprova a própria entrega.

Status: Implementação concluída — aguardando aprovação final

## Fase 1 — Baseline e contratos

- [x] **T-001 [FR-001..FR-012]** Confirmar baseline de observabilidade e health
  - Arquivos/módulos: `src/shared/`, `src/modules/messaging/`, `src/modules/wagering/`, `src/main.ts`, `src/app.module.ts`, testes existentes.
  - Executar typecheck e suíte atual; mapear eventos de log, métricas, providers e pontos de entrada HTTP/SQS/worker sem alterar o README.
  - Registrar divergências entre a Spec aprovada e o código atual, incluindo como o publisher Outbox informa seu estado.
  - **Verificação:** `bun run typecheck` passou; `bun test test/unit` passou com 71 testes, 0 falhas e 211 expectativas. Com PostgreSQL/LocalStack ativos, migration `Migration20261016020000` aplicada e a fila local de comandos limpa, `bun test` passou com 113 testes, 0 falhas e 349 expectativas. Nenhuma alteração de código foi feita.

- [x] **T-002 [FR-006, FR-011, AC-009, AC-010]** Estender o contrato `Metrics`
  - Arquivos/módulos: `src/shared/application/ports/metrics.port.ts` e implementações/testes relacionados.
  - Adicionar `observe` e `set`, preservando `increment` e tags de baixa cardinalidade.
  - **Verificação:** `bun run typecheck` e o teste de contrato `test/unit/metrics.port.test.ts` passaram; implementações legadas com apenas `increment` continuam válidas e adapters que fornecem `observe`/`set` são aceitos.

- [x] **T-003 [FR-007..FR-010, AC-001..AC-005]** Criar portas e contratos de health
  - Arquivos/módulos: `src/interfaces/health/` ou `src/shared/application/ports/health/`.
  - Definir resultados seguros por componente, `PostgresHealthCheck`, `SqsHealthCheck`, estado do publisher e serviço agregador, sem importar MikroORM/AWS nos contratos.
  - **Verificação:** `bun run typecheck` e `test/unit/health.port.test.ts` passaram; os contratos representam resultados `up`, `timeout`, `degraded` e `disabled` sem importar MikroORM ou AWS.

- [x] **T-004 [FR-002, AC-006, AC-007]** Criar contexto de correlação isolado
  - Arquivos/módulos: `src/shared/application/ports/` e `src/shared/infrastructure/`.
  - Implementar contexto baseado em `AsyncLocalStorage`, validação de até 100 caracteres sem controle e geração de UUIDv7 para valores ausentes/inválidos.
  - **Verificação:** `bun run typecheck` e `test/unit/correlation-context.test.ts` passaram; valores vazios, longos ou com controle geram UUIDv7 e callbacks concorrentes mantêm contextos isolados.

## Fase 2 — Logger e correlação

- [x] **T-005 [FR-001, FR-003, BR-005, AC-008]** Implementar sanitização central do logger
  - Arquivos/módulos: `src/shared/application/ports/logger.port.ts`, `src/shared/infrastructure/logging/` e testes unitários.
  - Sanitizar chaves sensíveis, payload bruto SQS, valores financeiros completos, objetos circulares, mensagens longas e erros antes de emitir JSON.
  - Preservar `level`, `event`, `timestamp` e os campos operacionais permitidos.
  - **Verificação:** `bun run typecheck` e `test/unit/structured-logger.test.ts` passaram; cada linha continua sendo JSON válido, sem secrets, receipt handles, payload bruto ou stack trace padrão.

- [x] **T-006 [FR-001, FR-002, AC-006]** Adicionar correlação HTTP
  - Arquivos/módulos: middleware/interceptor em `src/shared/` ou `src/interfaces/http/`, bootstrap e testes de controller.
  - Ler `x-correlation-id`, gerar UUIDv7 quando inválido/ausente, executar o request no contexto e devolver o mesmo header na resposta.
  - **Verificação:** `bun run typecheck` e `test/unit/http-correlation.middleware.test.ts` passaram; header válido é ecoado e header longo gera UUIDv7 no contexto e na resposta.

- [x] **T-007 [FR-001, FR-002, FR-011, AC-007, AC-013]** Propagar correlação por SQS e Outbox
  - Arquivos/módulos: consumidor SQS, envelope, caso de uso, enqueue da Outbox, worker e publisher.
  - Usar `correlationId` do envelope futuro e `messageId` no contrato atual; preservar o `correlationId` já persistido na Outbox sem alterar dados de negócio.
  - **Verificação:** `bun run typecheck` e os testes focados de envelope, consumer, worker e logger passaram; SQS usa `correlationId` futuro ou `messageId`, Outbox preserva o valor persistido e o logger inclui o contexto ativo.

- [x] **T-008 [FR-001, FR-003, AC-008, AC-013]** Normalizar logs existentes
  - Arquivos/módulos: wallet, wagering, Inbox, referências, SQS e Outbox.
  - Ajustar contextos para usar códigos curtos, `attempt`, `outcome` e identificadores operacionais, removendo campos de alta sensibilidade ou payloads excessivos.
  - **Verificação:** `bun run typecheck` e `test/unit/pending-reference.worker.test.ts` passaram; o worker usa `AppLogger` estruturado e emite `errorCode` curto, sem logger direto do Nest ou erro bruto.

## Fase 3 — Métricas e instrumentação

- [x] **T-009 [FR-006, BR-006, AC-009, AC-010]** Implementar snapshots de métricas em memória
  - Arquivos/módulos: `src/shared/infrastructure/metrics/in-memory-metrics.ts` e testes.
  - Armazenar contadores, observações de duração e gauges/snapshots por nome e tags ordenadas, com API de leitura adequada aos testes.
  - **Verificação:** `bun run typecheck` e `test/unit/in-memory-metrics.test.ts` passaram; contadores, observações e gauges usam chaves de tags estáveis, valores não finitos são ignorados e snapshots são cópias.

- [x] **T-010 [FR-004, FR-005, AC-009, AC-013]** Instrumentar resultados financeiros e concorrência
  - Arquivos/módulos: caso de uso de wagering, Inbox, wallet/ledger e erros de optimistic locking.
  - Emitir métricas para `PROCESSED`, `REJECTED`, `PENDING_REFERENCE`, falhas transitórias, replays, conflitos de payload, retries e lock conflicts com tags de operação/origem.
  - **Verificação:** `bun run typecheck` e os testes de idempotência focados passaram; status/replay usam tags `kind`/`source`, retries e lock conflicts são contabilizados sem alterar efeitos financeiros.

- [x] **T-011 [FR-005, FR-006, AC-010, AC-013]** Instrumentar SQS, referências e Outbox
  - Arquivos/módulos: consumer SQS, worker de referências, repository/worker Outbox e adapters de publisher.
  - Medir recebimento, ack, retry, redelivery, DLQ, referências pendentes/resolvidas/incompatíveis/expiradas, publish, claim, conflito e intervenção.
  - **Verificação:** typecheck e testes focados de SQS, referências e Outbox passaram; outcomes de recebimento/replay/retry/DLQ usam tags controladas e lag/duração usam `set`/`observe`.

- [x] **T-012 [FR-006, AC-010, AC-011]** Medir duração e lag
  - Arquivos/módulos: casos de uso, consumers/workers, repository Outbox, porta de métricas e futura camada de health.
  - Usar `observe` para durações em milissegundos e `set` para quantidade/idade de pendências em unidades explícitas.
  - **Verificação:** typecheck e testes focados passaram; wagering, SQS, referências e Outbox observam duração em milissegundos, enquanto pendências/lag usam gauges sem tags dinâmicas.

## Fase 4 — Health checks e endpoints

- [x] **T-013 [FR-009, FR-010, AC-003, AC-011, AC-012]** Implementar health check read-only do PostgreSQL
  - Arquivos/módulos: adapter de infraestrutura e testes de integração.
  - Usar a conexão MikroORM/driver apenas para uma consulta mínima de conectividade, sem transação de negócio, escrita ou alteração de estado.
  - **Verificação:** `bun run typecheck` e `test/unit/postgres-health-check.test.ts` passaram; o adapter executa apenas `select 1`, retorna `up`/`down`, latência e código seguro sem expor detalhes do banco.

- [x] **T-014 [FR-009, FR-010, AC-004, AC-005, AC-012]** Implementar health check read-only do SQS
  - Arquivos/módulos: adapter em `src/modules/messaging/sqs/infrastructure/` ou health infrastructure e testes LocalStack.
  - Consultar atributos das filas de entrada e eventos com `GetQueueAttributes`, sem `ReceiveMessage`, `DeleteMessage` ou alteração de visibilidade.
  - **Verificação:** `bun run typecheck` e `test/unit/sqs-health-check.test.ts` passaram; o adapter usa somente `GetQueueAttributes`, distingue input/eventos, reporta `disabled` e não consome mensagens.

- [x] **T-015 [FR-008, FR-009, FR-011, AC-005]** Expor estado do publisher Outbox
  - Arquivos/módulos: worker/configuração Outbox, porta de health e testes unitários.
  - Representar publisher `disabled`, `up` ou `degraded`, incluindo lag/última falha quando disponível, sem tornar a indisponibilidade da fila de eventos uma falha financeira obrigatória.
  - **Verificação:** `bun run typecheck` e os testes do worker passaram; publisher desligado, saudável e falho retornam `disabled`, `up` e `degraded`, com lag/erro seguros.

- [x] **T-016 [FR-008, FR-010, AC-002..AC-005, AC-011]** Implementar agregador de readiness com timeout
  - Arquivos/módulos: serviço de aplicação de health, configuração e testes.
  - Executar checks em paralelo com timeout individual de 500 ms e deadline total de 1 s, ambos configuráveis; classificar resposta segura por componente.
  - **Verificação:** `bun run typecheck` e `test/unit/health.service.test.ts` passaram; checks rodam em paralelo, respeitam timeout individual/total, mantêm Outbox degradada sem bloquear e classificam dependência obrigatória como `not_ready`.

- [x] **T-017 [FR-007, FR-008, FR-009, AC-001..AC-005, AC-012]** Criar controllers `/health/live` e `/health/ready`
  - Arquivos/módulos: `src/interfaces/health/`, módulo de health, `src/app.module.ts` e bootstrap.
  - Expor contrato JSON estável, `checkedAt`, componentes e latências seguras; liveness não deve injetar nem chamar checks externos.
  - **Verificação:** `bun run typecheck` e `test/unit/health.controller.test.ts` passaram; liveness é local, readiness preserva o relatório seguro e escolhe `200`/`503`.

- [x] **T-018 [FR-008, FR-010, AC-002..AC-005, AC-011]** Adicionar configuração operacional de health
  - Arquivos/módulos: configuração de aplicação, `.env.example` e módulo de health.
  - Adicionar timeout individual/total e nomes/URLs necessários sem incluir segredos; manter defaults compatíveis com o ambiente atual.
  - **Verificação:** `bun run typecheck` e `test/unit/health-config.test.ts` passaram; defaults, limites inválidos, overrides e modo publisher desligado permanecem cobertos pelos testes de configuração existentes.

## Fase 5 — Testes e convergência

- [x] **T-019 [FR-001..FR-006, AC-006..AC-010]** Consolidar testes unitários de observabilidade
  - Arquivos/módulos: `test/unit/`.
  - Cobrir sanitização, correlação, métricas, instrumentação, códigos de erro e ausência de efeitos financeiros.
  - **Verificação:** testes unitários cobrem sanitização, correlação, métricas, duração por origem, erro permanente SQS, códigos de erro do Outbox e ausência de efeitos financeiros; suíte focada passou com 17 testes e 55 expectativas.

- [x] **T-020 [FR-007..FR-010, AC-001..AC-012]** Validar health com PostgreSQL e LocalStack reais
  - Arquivos/módulos: `test/integration/` e fixtures de infraestrutura.
  - Testar dependências saudáveis, indisponíveis, lentas, fila vazia, publisher degradado, timeout, liveness sem rede e health sem consumo de mensagem.
  - **Verificação:** `bun run typecheck` e `test/integration/health.integration.test.ts` passaram com PostgreSQL/LocalStack reais; readiness confirmou dependências, publisher desabilitado e não consumo da fila. Indisponibilidade, lentidão e timeout permanecem cobertos por `test/unit/health.service.test.ts`, `postgres-health-check.test.ts` e `sqs-health-check.test.ts`.

- [x] **T-021 [FR-011, FR-012, AC-013]** Executar regressão dos fluxos existentes
  - Arquivos/módulos: testes HTTP, SQS/Inbox, referências, wallet, ledger, wagering e Outbox.
  - Confirmar que instrumentação, contexto e health não alteram efeitos financeiros, retries, envelopes, publicação ou shutdown.
  - **Verificação:** `bun run typecheck` e `bun test` passaram com 142 testes, 0 falhas e 431 expectativas; README não foi alterado.

- [x] **T-022 [FR-001..FR-012]** Executar convergência técnica e preparar aprovação
  - Arquivos/módulos: código, Spec, plano, tarefas e evidências.
  - Rodar typecheck, build, suíte completa, testes de integração, verificações de logs seguros, timeout, liveness/readiness e ausência de efeitos colaterais.
  - Relacionar evidências aos AC-001..AC-013 e atualizar status para `Implementação verificada — aguardando aprovação final`, sem aprovar a entrega automaticamente.
  - **Verificação:** `bun run typecheck`, `bun run build`, `bun test` e `test/integration/health.integration.test.ts` passaram; auditoria de sanitização e endpoints concluída. O diretório não contém metadados `.git`, portanto `git diff --check/status` não pôde ser executado; o README não foi editado nesta implementação.

## Dependências e ordem

`T-001` precede as demais tarefas. `T-002`–`T-004` precedem instrumentação e health. `T-005`–`T-008` dependem dos contratos de logger/correlação. `T-009` precede `T-010`–`T-012`. `T-013`–`T-018` devem ser executadas após as portas de health, com `T-016` precedendo o controller. `T-019` pode acompanhar as fases funcionais, mas `T-020` e `T-021` dependem do wiring completo. `T-022` é a verificação final e não representa aprovação final da feature.

## Fora desta lista

- Alterar regras financeiras, Inbox, Outbox, SQS, wallet, ledger ou envelopes de negócio.
- Criar dashboard, alertas, exporter obrigatório, tracing completo ou APM.
- Autenticar os endpoints de health.
- Alterar o `README.md`.
