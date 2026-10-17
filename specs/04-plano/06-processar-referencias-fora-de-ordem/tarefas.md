# Tarefas — Processar referências fora de ordem

Plano relacionado: [`./plano.md`](./plano.md)  
Spec relacionada: [`../../03-features/06-processar-referencias-fora-de-ordem/spec.md`](../../03-features/06-processar-referencias-fora-de-ordem/spec.md)

## Regra das tarefas

Cada tarefa é pequena o suficiente para revisão individual, referencia os requisitos que implementa e descreve como verificar a conclusão. Nenhuma tarefa deve marcar a si própria como aprovada. A implementação deve ocorrer em ordem, uma tarefa por vez, respeitando as dependências.

## Fase 1 — Base e contrato

- [x] **T-001 [FR-001..FR-011]** Confirmar o baseline da implementação existente
  - Arquivos/módulos: `src/modules/wagering/`, `src/modules/messaging/outbox/`, migrations e testes existentes
  - Verificação: typecheck passou e os testes unitários focados passaram. Foram registradas as divergências: seleção sem lock persistente, referência não terminal classificada como incompatível e worker sujeito a candidato stale. O teste de integração HTTP ficou bloqueado por `EACCES` do ambiente ao abrir listener local.

- [x] **T-002 [FR-003, FR-008, FR-010]** Definir e implementar o contrato de seleção concorrente
  - Arquivos/módulos: `src/modules/wagering/application/ports/wager-transaction-repository.port.ts`, repository MikroORM
  - Verificação: o contrato permite selecionar pendências vencidas em lote e reconsultar/bloquear uma pendência por id dentro da Unit of Work, sem expor MikroORM ao domínio.

- [x] **T-003 [FR-002, FR-003, FR-007, FR-008]** Validar migration, constraints e índice de pendências
  - Arquivos/módulos: `src/infrastructure/database/migrations/`, entidades de `WagerTransaction`
  - Verificação: executar `up/down/up` em PostgreSQL real e confirmar consistência de `pending_since`, `next_attempt_at`, `pending_attempts`, status, índice due e uniques existentes; criar migration nova somente se uma lacuna for comprovada.

- [x] **T-004 [FR-003, FR-007, FR-010]** Preservar a política de backoff e TTL
  - Arquivos/módulos: `src/modules/wagering/application/reference-pending-policy.ts`, domínio de `WagerTransaction`
  - Verificação: testes com relógio confirmam `30s/1m/2m/4m/7m`, limite de 15 minutos, ausência de agenda além do TTL e manutenção de `pendingSince` em retries/restart.

## Fase 2 — Reprocessamento seguro

- [x] **T-005 [FR-003, FR-008, FR-009]** Implementar seleção `FOR UPDATE SKIP LOCKED` e lock por id
  - Arquivos/módulos: `src/modules/wagering/infrastructure/persistence/mikro-orm-wager-transaction.repository.ts`, Unit of Work
  - Verificação: duas execuções concorrentes não recebem a mesma linha bloqueada para processamento efetivo; wallets diferentes continuam podendo ser processadas em paralelo.

- [x] **T-006 [FR-004, FR-005, FR-008, FR-009]** Reconsultar a pendência dentro da Unit of Work
  - Arquivos/módulos: `src/modules/wagering/application/process-wager-transaction.use-case.ts`
  - Verificação: o caso de uso ignora candidato stale, não reprocessa estado terminal/reagendado e usa somente a linha bloqueada e atual para decidir o efeito.

- [x] **T-007 [FR-001, FR-006, FR-007]** Ajustar validação de referências não terminais e incompatíveis
  - Arquivos/módulos: `src/modules/wagering/application/wager-reference.validator.ts`, erros e domínio
  - Verificação: referência ausente ou não terminal permanece/retorna à pendência; referência terminal diferente de `PROCESSED`, contexto incompatível ou kind inválido gera `REFERENCE_NOT_COMPATIBLE` sem saldo/ledger.

- [x] **T-008 [FR-004, FR-005, FR-006, FR-007]** Garantir transições atômicas de sucesso, rejeição e expiração
  - Arquivos/módulos: `ProcessWagerTransactionUseCase`, `WagerTransaction`, repositories e Unit of Work
  - Verificação: sucesso vincula a referência e produz o efeito correto; incompatibilidade e expiração limpam a agenda; falha em qualquer persistência reverte a Unit of Work inteira.

- [x] **T-009 [FR-002, FR-005, FR-007, FR-008, FR-009]** Evitar duplicidade de eventos Outbox
  - Arquivos/módulos: `src/modules/messaging/outbox/`, caso de uso e repositório
  - Verificação: entrada na pendência gera um único `WagerTransactionPendingReference`; reprocessamento concorrente gera no máximo um conjunto de eventos de sucesso/rejeição; retries não criam eventos extras.

- [x] **T-010 [FR-004, FR-005, FR-006, FR-009]** Preservar efeitos financeiros e idempotência do caso de uso
  - Arquivos/módulos: `ProcessWagerTransactionUseCase`, wallet, ledger e repositories
  - Verificação: WIN/REFUND/ROLLBACK resolvidos usam as regras existentes, criam no máximo um ledger por transação, atualizam wallet atomicamente e replay/conflict continuam consistentes.

## Fase 3 — Worker e operação

- [x] **T-011 [FR-003, FR-004, FR-007, FR-008, FR-010]** Ajustar o worker para agenda persistida, lote e shutdown
  - Arquivos/módulos: `src/modules/wagering/application/pending-reference.worker.ts`, módulo de wagering e bootstrap
  - Verificação: polling configurável de 1 segundo, lote padrão 50, retomada após restart, parada de novas leituras no shutdown e conclusão/abandono seguro das execuções em voo.

- [x] **T-012 [FR-003, FR-006, FR-007, FR-010]** Classificar falhas transitórias e de negócio no reprocessamento
  - Arquivos/módulos: worker, caso de uso, erros e policy
  - Verificação: lock/banco indisponível mantém retry sem rejeição; regra incompatível ou TTL expirado é terminal; nenhuma falha transitória confirma estado financeiro parcial.

- [x] **T-013 [FR-011]** Adicionar logs estruturados e métricas do ciclo de pendência
  - Arquivos/módulos: portas de métricas/logger e worker/caso de uso
  - Verificação: registrar entrada, tentativa, sucesso, incompatibilidade, expiração, lock/retry e idade/quantidade due sem payload financeiro, receipt handle ou segredo.

- [x] **T-014 [FR-010, FR-011]** Verificar a integração com SQS/Inbox sem duplicar responsabilidades
  - Arquivos/módulos: consumer SQS, Inbox, worker e testes de integração
  - Verificação: mensagem SQS recebe ack após persistência inicial da pendência; o worker resolve pelo banco sem depender do broker; redelivery não reinicia TTL nem cria novo efeito.

## Fase 4 — Testes

- [x] **T-015 [FR-002, FR-003, FR-006, FR-007]** Cobrir domínio, policy e validator em testes unitários
  - Arquivos/módulos: `test/unit/`
  - Verificação: cobrir estados, limpeza de agenda, backoff, TTL, referência ausente, não terminal, incompatível, failure codes e transições terminais.

- [x] **T-016 [FR-003, FR-008, FR-009]** Cobrir repository e locks no PostgreSQL real
  - Arquivos/módulos: `test/integration/`, repository e migrations
  - Verificação: candidatos due são selecionados corretamente, `SKIP LOCKED` evita seleção duplicada, filtros de status/agenda são respeitados e rollback libera a pendência.

- [x] **T-017 [FR-004, FR-005, FR-006, FR-007]** Cobrir resolução, expiração e atomicidade financeira
  - Arquivos/módulos: `test/integration/`, fixtures de wagering e Outbox
  - Verificação: referência que chega antes do TTL processa uma vez; referência incompatível rejeita; expiração gera `REFERENCE_NOT_FOUND`; falha em wallet/ledger/Outbox não deixa estado parcial.

- [x] **T-018 [FR-008, FR-009, FR-011]** Cobrir concorrência entre workers e eventos
  - Arquivos/módulos: `test/integration/`
  - Verificação: duas instâncias concorrentes produzem no máximo uma transição financeira e um conjunto de eventos; wallets distintas mantêm paralelismo; métricas/logs não duplicam contadores indevidamente.

- [x] **T-019 [FR-009, FR-010]** Cobrir replay, redelivery e restart
  - Arquivos/módulos: testes HTTP, SQS/Inbox e worker
  - Verificação: replay pendente/terminal retorna o estado original, payload conflitante retorna conflito, crash antes/depois do commit é recuperável e restart preserva `pendingSince`.

- [x] **T-020 [FR-010]** Executar regressão dos fluxos financeiros e HTTP/SQS
  - Arquivos/módulos: suíte existente de `test/unit/` e `test/integration/`
  - Verificação: BET, WIN, LOSS, REFUND, ROLLBACK, wallet, ledger, Outbox, Inbox, SQS e contratos HTTP permanecem passando sem mudança não especificada.

## Fase 5 — Entrega e verificação

- [x] **T-021 [FR-001..FR-011]** Executar convergência e submeter a feature para aprovação
  - Arquivos/módulos: Spec, plano, tarefas, código e checklist de verificação
  - Verificação: typecheck, build, suíte completa (99 testes, 0 falhas), migration `up/down/up`, testes concorrentes e integração SQS/PostgreSQL passaram. A implementação está pronta para aprovação final; a aprovação da entrega permanece pendente.

## Adiado (fora do escopo desta rodada)

- [ ] Publicador externo da Outbox e consumers de eventos.
- [ ] Novo endpoint ou alteração de contrato público não prevista na Spec.
- [ ] Reconciliação, autenticação e deploy.
- [ ] Limpeza automática de registros e retention job.
- [ ] Teste de carga completo com três instâncias e métricas p50/p95/p99.
- [ ] Alteração do `README.md`.
