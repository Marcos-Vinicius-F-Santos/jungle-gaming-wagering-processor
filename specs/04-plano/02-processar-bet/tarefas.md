# Tarefas — Processar BET com idempotência e optimistic locking

Plano relacionado: [`./plano.md`](./plano.md)
Spec relacionada: [`../../03-features/02-processar-bet/spec.md`](../../03-features/02-processar-bet/spec.md)
Status: Rascunho — aguardando aprovação

Escopo aprovado para planejamento: execução e verificação das fases 1 a 5. A fase 06 de deploy não existe por enquanto, pois o projeto não possui Git nem fluxo de deploy configurado.

## Regra das tarefas

Cada tarefa é pequena o suficiente para revisão isolada, referencia os requisitos funcionais que implementa e informa como verificar que ficou pronta. Não implementar tarefas futuras nesta rodada sem aprovação do plano.

## Fase 1 — Base

- [ ] **T-001 [FR-001, FR-005, FR-010]** Confirmar o módulo `wagering`, o caso de uso financeiro único e os limites com wallets existentes
  - Arquivos/módulos: `src/modules/wagering/`, `src/modules/wallets/`, `src/app.module.ts`
  - Verificação: documentar o ponto de entrada escolhido e confirmar que o domínio não importa NestJS, MikroORM, HTTP ou SQS; a regressão da feature de wallets continua executável.

- [ ] **T-002 [FR-006, FR-007, FR-008, FR-010]** Criar migration reversível para unicidade por provider e snapshot de replay
  - Arquivos/módulos: `src/infrastructure/database/migrations/`
  - Verificação: `up` substitui o índice global por unique parcial em `(provider_id, idempotency_key)`, preserva `(provider_id, external_transaction_id)`, cria campos de resultado e checks aprovados; `down` é testado em PostgreSQL real sem alterar dados.

- [ ] **T-003 [FR-001, FR-003, FR-005, FR-006, FR-008, FR-010]** Atualizar entidades MikroORM, mapeamentos e portas de repositório
  - Arquivos/módulos: `src/modules/wagering/infrastructure/persistence/`, `src/modules/wagering/application/ports/`, adapters de wallets
  - Verificação: entidades refletem o schema, `NUMERIC` permanece string, e os casos de uso dependem apenas de interfaces para buscar por idempotency key/transação externa e salvar o resultado.

- [ ] **T-004 [FR-006, FR-007]** Implementar canonicalização e SHA-256 do payload de negócio
  - Arquivos/módulos: `src/modules/wagering/application/` ou `src/shared/` conforme a fronteira definida pela arquitetura
  - Verificação: mesma entrada produz hash estável independentemente da ordem das chaves; header e metadados de transporte não entram; qualquer alteração em campo de negócio altera o hash.

## Fase 2 — Lógica principal

- [ ] **T-005 [FR-001, FR-004, FR-005, FR-008, FR-010]** Expandir `WagerTransaction` para `BET`, estados terminais e failure codes
  - Arquivos/módulos: `src/modules/wagering/domain/wager-transaction.ts` e tipos de erro do domínio
  - Verificação: `OPENING` continua funcionando; `BET` nasce em `PENDING`, pode terminar em `PROCESSED`, `REJECTED` ou `FAILED`, e não permite transição depois de estado terminal.

- [ ] **T-006 [FR-002, FR-003, FR-004, FR-009]** Implementar débito no aggregate `Wallet`
  - Arquivos/módulos: `src/modules/wallets/domain/wallet.ts`
  - Verificação: débito exige mesma moeda, valor positivo, saldo suficiente e produz o saldo posterior correto; saldo negativo é sempre rejeitado.

- [ ] **T-007 [FR-003, FR-005, FR-009]** Implementar update condicional da wallet por `version`
  - Arquivos/módulos: `src/modules/wallets/application/ports/wallet-repository.port.ts` e `src/modules/wallets/infrastructure/persistence/mikro-orm-wallet.repository.ts`
  - Verificação: o SQL usa a versão carregada na cláusula `WHERE`, retorna conflito quando nenhuma linha é afetada e incrementa a versão somente quando o saldo muda.

- [ ] **T-008 [FR-006, FR-007, FR-008, FR-010]** Implementar consultas de idempotência e transação externa
  - Arquivos/módulos: `src/modules/wagering/application/ports/wager-transaction-repository.port.ts` e `src/modules/wagering/infrastructure/persistence/mikro-orm-wager-transaction.repository.ts`
  - Verificação: é possível localizar por `(providerId, idempotencyKey)` e `(providerId, externalTransactionId)`, carregar payload hash/status/failure code e snapshot de resultado sem expor entidade ORM.

- [ ] **T-009 [FR-003, FR-005, FR-010]** Implementar o caminho de BET processada e ledger atômico
  - Arquivos/módulos: `src/modules/wagering/application/process-wager-transaction.use-case.ts`, repositórios e Unit of Work
  - Verificação: uma BET válida com saldo suficiente persiste `PROCESSED`, debita wallet, incrementa versão e cria exatamente um `DEBIT` balanceado na mesma transação SQL.

- [ ] **T-010 [FR-002, FR-004, FR-010]** Implementar rejeições auditáveis de negócio e wallet inexistente
  - Arquivos/módulos: caso de uso, `WagerTransaction` e mapeadores de failure code
  - Verificação: saldo insuficiente gera `REJECTED/INSUFFICIENT_FUNDS` sem ledger; wallet/player/moeda incompatíveis não alteram saldo; wallet inexistente retorna `404` sem persistir transação, saldo ou ledger.

- [ ] **T-011 [FR-006, FR-007, FR-008]** Implementar replay idempotente e conflitos determinísticos
  - Arquivos/módulos: caso de uso e repositório de transações
  - Verificação: mesma key e mesmo hash retornam o resultado original sem novo efeito; mesma key com hash diferente retorna conflito; transação externa duplicada segue a mesma regra e nunca cria segundo débito.

- [ ] **T-012 [FR-005, FR-009]** Implementar retry de optimistic locking com três tentativas totais
  - Arquivos/módulos: caso de uso, Unit of Work e erros de concorrência
  - Verificação: cada retry abre uma transação segura e recarrega a wallet; após três tentativas, retorna falha transitória sem débito/ledger duplicado; conflito não contorna constraints.

## Fase 3 — Interface

- [ ] **T-013 [FR-001, FR-002, FR-006, FR-010]** Criar DTO HTTP e validações do contrato
  - Arquivos/módulos: `src/modules/wagering/http/`
  - Verificação: exige `Idempotency-Key`, valida UUIDs, `kind = BET`, amount como string decimal positiva, moeda ISO-4217 normalizada para maiúsculas e limites de provider/external/round/game/key.

- [ ] **T-014 [FR-001, FR-003, FR-006, FR-010]** Implementar `POST /wagering/transactions`
  - Arquivos/módulos: controller, presenter e módulo HTTP de wagering
  - Verificação: controller chama somente o caso de uso, retorna o payload definido na Spec e não acessa banco diretamente; sucesso inicial retorna `201`.

- [ ] **T-015 [FR-002, FR-004, FR-006, FR-007, FR-008, FR-009]** Mapear erros e replay para os status HTTP aprovados
  - Arquivos/módulos: filtros/presenter de wagering e erros de aplicação
  - Verificação: testes de contrato confirmam `200` para replay, `400` para payload inválido, `404` para wallet inexistente, `409` para conflitos, `422` para rejeição de negócio e `503` para falha transitória.

- [ ] **T-016 [FR-003, FR-004, FR-006, FR-009, FR-010]** Adicionar observabilidade mínima do fluxo
  - Arquivos/módulos: logger/metrics adapters já existentes e caso de uso
  - Verificação: logs estruturados permitem correlacionar transaction, wallet e provider sem payload financeiro completo; retries, conflitos e replays podem ser contados sem alterar o resultado financeiro.

## Fase 4 — Testes

- [ ] **T-017 [FR-001, FR-002, FR-004, FR-006, FR-007, FR-008, FR-010]** Cobrir domínio, hash, idempotência e failure codes com testes unitários
  - Arquivos/módulos: `test/unit/` e testes do domínio de wagering
  - Verificação: cobrir BET válida, valor/moeda inválidos, estados terminais, hash estável, replay, conflito de payload e códigos de rejeição.

- [ ] **T-018 [FR-003, FR-004, FR-005, FR-010]** Testar migration, atomicidade e rollback com PostgreSQL real
  - Arquivos/módulos: `test/integration/`, Docker Compose e migration
  - Verificação: executar `up/down`, conferir constraints/índices, simular falha entre persistência da transação, débito e ledger, e confirmar ausência de registros parciais.

- [ ] **T-019 [FR-001, FR-002, FR-003, FR-004, FR-006, FR-007, FR-008]** Testar contrato HTTP de processamento
  - Arquivos/módulos: `test/integration/` ou `test/e2e/`
  - Verificação: confirmar `201`, `200`, `400`, `404`, `409`, `422` e `503`, incluindo replay com snapshot original e ausência de efeitos em conflitos/rejeições.

- [ ] **T-020 [FR-003, FR-005, FR-006, FR-009]** Testar concorrência real e regressão da feature anterior
  - Arquivos/módulos: testes de integração concorrente e suíte completa
  - Verificação: duas BETs concorrentes de `80.00` sobre saldo `100.00` produzem uma processada, uma rejeitada, saldo `20.00` e um débito; 50 reenvios paralelos geram um único débito; wallets distintas continuam paralelas; todos os testes anteriores passam.

## Fase 5 — Entrega e verificação

- [ ] **T-021 [FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-007, FR-008, FR-009, FR-010]** Executar convergência, documentar rollback e submeter para aprovação
  - Arquivos/módulos: `specs/03-features/02-processar-bet/spec.md`, `specs/04-plano/02-processar-bet/`, checklist/evidências de verificação e diff da implementação
  - Verificação: preencher checklist Spec ↔ Plano ↔ Código ↔ Testes, anexar evidências de `up/down`, testes concorrentes e regressão; o revisor técnico aprova antes de marcar a feature como concluída. Não há deploy nesta rodada.

## Adiado (fora do escopo desta rodada)

- [ ] Processar `WIN`, `LOSS`, `REFUND` e `ROLLBACK`.
- [ ] Referências fora de ordem, `PENDING_REFERENCE`, TTL e worker de reprocessamento.
- [ ] SQS, Inbox, DLQ, redelivery e shutdown de consumers.
- [ ] Transactional Outbox e eventos de integração.
- [ ] Consulta pública de transações e ledger paginado.
- [ ] Reconciliação.
- [ ] Autenticação.
- [ ] Teste de carga completo com três instâncias e métricas p50/p95/p99.
- [ ] Deploy e rollback de aplicação; o projeto ainda não possui Git nem fluxo de deploy.
