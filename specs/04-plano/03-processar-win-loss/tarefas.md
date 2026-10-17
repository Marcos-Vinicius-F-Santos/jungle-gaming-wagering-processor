# Tarefas — Processar WIN e LOSS

Plano relacionado: [`./plano.md`](./plano.md)
Spec relacionada: [`../../03-features/03-processar-win-loss/spec.md`](../../03-features/03-processar-win-loss/spec.md)

## Regra das tarefas

Cada tarefa é pequena o suficiente para revisão individual, referencia os requisitos que implementa e descreve como verificar a conclusão. Nenhuma tarefa deve marcar a si própria como aprovada.

## Fase 1 — Base

- [ ] **T-001 [FR-001, FR-002, FR-003, FR-006, FR-010]** Confirmar boundaries de wagering e contratos de referência
  - Arquivos/módulos: `src/modules/wagering/`, ports existentes e arquitetura
  - Verificação: confirmar que HTTP, worker futuro e BET usam o mesmo caso de uso; registrar qualquer divergência antes de codificar.

- [ ] **T-002 [FR-004, FR-006, FR-007, FR-008, FR-010]** Criar migration reversível para referência e pendência
  - Arquivos/módulos: `src/infrastructure/database/migrations/`
  - Verificação: `up/down/up` em PostgreSQL real; conferir colunas, checks, índices de pendências e preservação das uniques existentes.

- [ ] **T-003 [FR-006, FR-007, FR-008, FR-010]** Atualizar entidades, registros e ports de repositório
  - Arquivos/módulos: `src/modules/wagering/infrastructure/persistence/`, `src/modules/wagering/application/ports/`
  - Verificação: entidades e adapters persistem/reconstroem referência, snapshot e metadados de pendência sem quebrar `OPENING`/`BET`; a Outbox mantém envelope, payload e estado de publicação.

- [ ] **T-004 [FR-002, FR-004, FR-009]** Adicionar crédito seguro ao agregado Wallet
  - Arquivos/módulos: `src/modules/wallets/domain/wallet.ts`, ports/adapters de wallet
  - Verificação: crédito exige valor positivo e mesma moeda, incrementa version uma vez, preserva decimal exato e suporta update condicional.

## Fase 2 — Lógica principal

- [ ] **T-005 [FR-001, FR-006, FR-007, FR-008, FR-010]** Expandir command, domínio e hash para WIN/LOSS e referência opcional
  - Arquivos/módulos: command/use case, `WagerTransaction`, payload hasher
  - Verificação: `kind`, `referenceExternalTransactionId` e snapshot participam do contrato/hash apenas quando forem campos de negócio presentes.

- [ ] **T-006 [FR-006, FR-008, FR-010]** Implementar resolução e validação de referência
  - Arquivos/módulos: port/adapter de `WagerTransaction`, caso de uso
  - Verificação: lookup por provider + identificador externo; aceitar somente BET compatível com provider, player, wallet, moeda e rodada; conflito não altera saldo.

- [ ] **T-007 [FR-002, FR-004, FR-009, FR-010]** Implementar processamento de WIN com crédito e ledger CREDIT
  - Arquivos/módulos: `ProcessWagerTransactionUseCase`, `Wallet`, `WalletLedgerEntry`, repositories
  - Verificação: WIN válida persiste `PROCESSED`, saldo aumenta, version avança uma vez e existe exatamente um `CREDIT` balanceado na mesma transação SQL.

- [ ] **T-008 [FR-003, FR-007, FR-010]** Implementar processamento de LOSS sem efeito financeiro
  - Arquivos/módulos: `ProcessWagerTransactionUseCase`, entidade/adapter e resultado HTTP
  - Verificação: LOSS persiste `PROCESSED`, mantém saldo/version, não cria ledger e replay retorna snapshot de saldo inalterado.

- [ ] **T-009 [FR-006, FR-010]** Implementar estado PENDING_REFERENCE, backoff, TTL e expiração
  - Arquivos/módulos: domínio, repositório e worker/reprocessador
  - Verificação: referência ausente persiste pendência, agenda `30s/1m/2m/4m/7m`, nunca ultrapassa 15 minutos, enfileira o evento de pendência e expira como `REJECTED/REFERENCE_NOT_FOUND` com evento de rejeição.

- [ ] **T-010 [FR-002, FR-003, FR-006, FR-010]** Persistir eventos de integração na Outbox transacional
  - Arquivos/módulos: `src/modules/messaging/outbox/` ou módulo equivalente, Unit of Work e caso de uso
  - Verificação: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference` e `WalletBalanceChanged` quando aplicável são enfileirados na mesma transação SQL; rollback financeiro também remove os eventos.

- [ ] **T-011 [FR-007, FR-008, FR-009]** Reutilizar replay, conflitos e retry sem duplicar efeitos
  - Arquivos/módulos: caso de uso, errors e repositories
  - Verificação: replay de WIN/LOSS retorna resultado original; payload divergente retorna `409`; concorrência de WIN não duplica crédito ou ledger.

- [ ] **T-012 [FR-002, FR-003, FR-005, FR-009, FR-010]** Preservar atomicidade e observabilidade do fluxo
  - Arquivos/módulos: Unit of Work, logger e caso de uso
  - Verificação: falha em transação/wallet/ledger/Outbox faz rollback integral; logs correlacionam transaction, wallet, provider e eventId sem payload financeiro completo.

## Fase 3 — Interface

- [ ] **T-013 [FR-001, FR-005, FR-006, FR-010]** Atualizar DTO para WIN/LOSS e referência opcional
  - Arquivos/módulos: `src/modules/wagering/http/dto/`
  - Verificação: valida UUIDs, dinheiro string positivo, moeda ISO em maiúsculas, kinds permitidos, limites e referência opcional.

- [ ] **T-014 [FR-001, FR-003, FR-006, FR-007, FR-008]** Atualizar endpoint e presenter de respostas
  - Arquivos/módulos: `src/modules/wagering/http/`, `WageringModule`
  - Verificação: `201` inicial, `200` replay, `202` pending, `400`, `404`, `409`, `422` e `503` são mapeados sem acesso direto ao banco.

- [ ] **T-015 [FR-006, FR-010]** Registrar o worker/reprocessador de referências pendentes
  - Arquivos/módulos: módulo de wagering/messaging e bootstrap
  - Verificação: componente inicia com a aplicação, consulta pendências due usando `next_attempt_at`, respeita `pending_since`, não cria operação duplicada e reusa o caso de uso; publicação externa SQS não é criada nesta tarefa.

## Fase 4 — Testes

- [ ] **T-016 [FR-001, FR-002, FR-003, FR-004, FR-006, FR-010]** Cobrir domínio, crédito, LOSS e referência com testes unitários
  - Arquivos/módulos: `test/unit/`
  - Verificação: cobrir Money, `Wallet.credit`, direção CREDIT, LOSS sem ledger, compatibilidade de referência, estados terminais e failure codes.

- [ ] **T-017 [FR-002, FR-003, FR-005, FR-006, FR-010]** Testar migration, atomicidade e rollback no PostgreSQL real
  - Arquivos/módulos: `test/integration/`, migration
  - Verificação: constraints/índices, `up/down`, falha em crédito/ledger/Outbox e ausência de efeitos parciais; BET anterior continua íntegra.

- [ ] **T-018 [FR-001, FR-003, FR-006, FR-007, FR-008]** Testar contrato HTTP de WIN, LOSS e pendência
  - Arquivos/módulos: `test/integration/` ou `test/e2e/`
  - Verificação: confirmar `201`, `200`, `202`, `400`, `404`, `409`, `422` e `503`, incluindo snapshot de LOSS e referência inválida/ausente.

- [ ] **T-019 [FR-002, FR-003, FR-007, FR-009]** Testar concorrência real e replay paralelo
  - Arquivos/módulos: `test/integration/`
  - Verificação: duas WINs concorrentes geram dois créditos corretos; 50 reenvios da mesma WIN/LOSS geram um efeito; wallets distintas continuam paralelas.

- [ ] **T-020 [FR-006, FR-010]** Testar reprocessamento, TTL e expiração de referência
  - Arquivos/módulos: `test/integration/`, worker e PostgreSQL real
  - Verificação: referência que surge antes do TTL processa uma vez e gera eventos corretos; referência ausente expira como `REFERENCE_NOT_FOUND` com evento de rejeição; redelivery não reinicia o TTL.

## Fase 5 — Entrega e verificação

- [ ] **T-021 [FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-007, FR-008, FR-009, FR-010]** Executar convergência e submeter para aprovação
  - Arquivos/módulos: `specs/03-features/03-processar-win-loss/`, `specs/04-plano/03-processar-win-loss/`, checklist/evidências
  - Verificação: typecheck, build, suíte completa, migration `up/down`, concorrência, rollback e comparação Spec ↔ Plano ↔ Código ↔ Testes; não marcar como concluído sem aprovação de Marcos.

## Adiado (fora do escopo desta rodada)

- [ ] `REFUND` e `ROLLBACK`.
- [ ] SQS, Inbox, DLQ e redelivery de mensagens.
- [ ] Publicação externa da Outbox por SQS ou outro broker.
- [ ] Consulta pública de transações e ledger paginado.
- [ ] Reconciliação.
- [ ] Autenticação.
- [ ] Teste de carga com três instâncias e métricas p50/p95/p99.
- [ ] Deploy e rollback de aplicação; o projeto não possui Git nem fluxo de deploy.
