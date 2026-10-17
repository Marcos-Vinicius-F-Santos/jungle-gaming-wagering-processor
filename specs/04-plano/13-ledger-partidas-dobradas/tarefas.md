# Tarefas — Ledger de partidas dobradas

Plano relacionado: [`./plano.md`](./plano.md)  
Spec relacionada: [`../../03-features/13-ledger-partidas-dobradas/spec.md`](../../03-features/13-ledger-partidas-dobradas/spec.md)  
Arquitetura: [`../../../ARCHITECTURE.md`](../../../ARCHITECTURE.md)  
README: [`../../../README.md`](../../../README.md)  

Status: Implementação verificada — aguardando aprovação final  

## Regra das tarefas

Executar uma tarefa por vez, na ordem de dependência. Cada tarefa deve registrar arquivos alterados, comando de verificação e resultado. Não alterar regras financeiras, contrato HTTP, `ARCHITECTURE.md` ou `README.md` sem decisão explícita desta feature.

## Fase 1 — Baseline e contratos

- [x] **T-001 [FR-001..FR-011, AC-001..AC-010]** Confirmar baseline do ledger atual
  - Mapear entidades, migrations, repositories, Unit of Work, reconciliação e testes existentes.
  - Confirmar como `WalletLedgerEntry` representa cada efeito e quais históricos precisam de backfill.
  - **Verificação:** `bun run typecheck` passou; baseline confirmou `WalletLedgerEntry`/`wallet_ledger_entries` com unicidade `(wallet_id, transaction_id)`, `MikroOrmLedgerRepository`, `MikroOrmUnitOfWork`, reconciliação wallet/ledger e migrations MikroORM versionadas, sem alteração de regra financeira.
  - **Evidência:** `src/modules/wallets/domain/wallet-ledger-entry.ts`, `src/modules/wallets/infrastructure/persistence/entities/wallet-ledger-entry.entity.ts`, `src/modules/wallets/infrastructure/persistence/mikro-orm-ledger.repository.ts`, `src/shared/infrastructure/database/mikro-orm-unit-of-work.ts`, `src/modules/reconciliation/` e `src/infrastructure/database/migrations/`.

- [x] **T-002 [FR-001, FR-002, FR-007, FR-008]** Implementar contratos de domínio
  - Criar `LedgerAccount`, `Posting`, `JournalEntry`, direções, tipos de conta e erros de balanceamento.
  - Validar moeda única, valores positivos, ao menos um débito/crédito e soma exata.
  - **Verificação:** `bun run typecheck` passou; `bun test test/unit/double-entry-ledger.test.ts` passou com 3 testes e 13 expectativas, cobrindo contas wallet/sistema, journal balanceado, defensividade, moedas, valores, lados e IDs.
  - **Evidência:** `src/modules/ledger/domain/ledger-account.ts`, `src/modules/ledger/domain/posting.ts`, `src/modules/ledger/domain/journal-entry.ts` e `test/unit/double-entry-ledger.test.ts`.

- [x] **T-003 [FR-004, FR-005, FR-006]** Implementar política de contas e mapeamento de efeitos
  - Resolver contas por moeda e wallet sem estado apenas em memória.
  - Mapear `OPENING`, `BET`, `WIN`, `REFUND` e `ROLLBACK`; manter `LOSS` sem journal patrimonial.
  - **Verificação:** `bun run typecheck` passou; `bun test test/unit/ledger-policy.test.ts` passou com 3 testes e 14 expectativas, cobrindo chaves determinísticas por moeda/wallet, mapeamento, policy version, inversão exata e `LOSS` sem journal.
  - **Evidência:** `src/modules/ledger/domain/ledger-policy.ts` e `test/unit/ledger-policy.test.ts`.

## Fase 2 — Schema e persistência

- [x] **T-004 [FR-001, FR-002, FR-007, FR-008]** Criar migration de contas, journals e postings
  - Criar tabelas, FKs, índices, unicidades, `NUMERIC(19,2)`, moeda e checks de valores positivos.
  - Criar contas sistêmicas e estratégia de contas wallet sem duplicar `(wallet, currency)`.
  - **Verificação:** `bun run typecheck` passou; `bun run migration:up` aplicou `Migration20261016050000`, `bun run migration:down` reverteu e `bun run migration:up` reaplicou no PostgreSQL local do Docker.
  - **Evidência:** `src/infrastructure/database/migrations/Migration20261016050000.ts`; schema deixou as três tabelas, FKs, checks, índices e triggers append-only disponíveis após reaplicação.

- [x] **T-005 [FR-007, FR-008, AC-006]** Proteger append-only e balanceamento no banco
  - Impedir update/delete de journals e postings confirmados.
  - Implementar constraint trigger, função transacional ou equivalente para impedir commit desbalanceado.
  - **Verificação:** `bun run typecheck` passou; `bun test test/integration/double-entry-ledger.constraints.test.ts` passou com 2 testes e 4 expectativas, confirmando journal balanceado, rejeição no `COMMIT` de journal desbalanceado e bloqueio de `UPDATE`/`DELETE`.
  - **Evidência:** `src/infrastructure/database/migrations/Migration20261016060000.ts` e `test/integration/double-entry-ledger.constraints.test.ts`.

- [x] **T-006 [FR-001, FR-002, FR-007, FR-010]** Implementar portas e repositories
  - Persistir/consultar contas, journals e postings sem expor ORM ao domínio.
  - Garantir inserção do conjunto completo na Unit of Work e unicidade por `(transactionId, effectType)`.
  - **Verificação:** `bun run typecheck` passou; `bun test test/integration/double-entry-ledger.repository.test.ts` passou com 2 testes e 7 expectativas, confirmando persistência/rehydrate sem entidades ORM no domínio e rollback de inserção parcial.
  - **Evidência:** `src/modules/ledger/application/ports/double-entry-ledger-repository.port.ts`, entidades em `src/modules/ledger/infrastructure/persistence/entities/`, `src/modules/ledger/infrastructure/persistence/mikro-orm-double-entry-ledger.repository.ts`, configuração ORM e teste de integração.

## Fase 3 — Integração financeira

- [x] **T-007 [FR-002, FR-003, FR-008, FR-010]** Integrar builder contábil à Unit of Work
  - Criar journal/postings a partir do efeito financeiro já aplicado.
  - Persistir junto com wallet, transação, `WalletLedgerEntry` e Outbox.
  - **Verificação:** `bun run typecheck` passou; `bun test test/integration/ledger-effect-recorder.test.ts` passou com 2 testes e 6 expectativas, confirmando recorder orientado por política, resolução/criação de contas no contexto transacional e `LOSS` sem journal.
  - **Evidência:** `src/modules/ledger/application/ledger-effect-recorder.ts`, `src/modules/ledger/ledger.module.ts`, wiring em `src/modules/wallets/wallets.module.ts` e teste de integração.

- [x] **T-008 [FR-003, FR-004, FR-010, AC-002]** Integrar `OPENING`, `BET` e `WIN`
  - Aplicar o mapeamento aprovado sem alterar saldo, versão, status ou resposta.
  - Validar conta wallet e contrapartida na mesma moeda.
  - **Verificação:** `bun run typecheck` passou; testes focados `create-wallet.use-case`, `wagering.http` e `win-loss.http` passaram com 13 testes/41 expectativas; `bun test test/integration/double-entry-ledger.financial-flow.test.ts` passou com 1 teste/6 expectativas, confirmando `OPENING`, `BET` e `WIN` balanceados e saldo final compatível.
  - **Evidência:** `src/modules/wallets/application/create-wallet.use-case.ts`, `src/modules/wagering/application/process-wager-transaction.use-case.ts`, módulos `ledger` e `test/integration/double-entry-ledger.financial-flow.test.ts`.

- [x] **T-009 [FR-003, FR-006, FR-010, AC-004]** Integrar `REFUND` e `ROLLBACK`
  - Construir inversão exata dos postings da transação referenciada.
  - Impedir reversão incompatível, duplicada ou sem referência processada.
  - **Verificação:** `bun run typecheck` passou; `bun test test/integration/refund-rollback.http.test.ts` passou com 3 testes e 14 expectativas; a política unitária confirmou inversão exata e `REFUND` restrito a `BET`.
  - **Evidência:** `LedgerEffectRecorder.recordReversal`, busca de conta por ID no repository, integração em `processReversalEffect` e `test/integration/refund-rollback.http.test.ts`.

- [x] **T-010 [FR-005, AC-002]** Formalizar política de `LOSS`
  - Garantir ausência de `WalletLedgerEntry`, journal patrimonial e alteração de saldo.
  - Preservar transação, Outbox e status atuais conforme as regras existentes.
  - **Verificação:** `bun run typecheck` passou; `bun test test/integration/double-entry-ledger.financial-flow.test.ts` passou com 1 teste e 7 expectativas, confirmando `LOSS` processado, saldo inalterado e somente `OPENING`, `BET` e `WIN` na consulta contábil.
  - **Evidência:** `LedgerAccountPolicy`/`LedgerEffectRecorder` e `test/integration/double-entry-ledger.financial-flow.test.ts`.

- [x] **T-011 [FR-003, FR-007, AC-003, AC-005, AC-010]** Cobrir idempotência e concorrência contábil
  - Testar replay, payload conflict, retry optimistic-locking, redelivery SQS e três instâncias.
  - Garantir que cada efeito produz no máximo um journal e postings compatíveis.
  - **Verificação:** `bun run typecheck` passou; `bun test test/integration/double-entry-ledger.idempotency.test.ts` passou com 1 teste/3 expectativas, confirmando 50 replays com 1 journal/2 postings; `win-loss.concurrency` e `wagering.concurrency` passaram com 6 testes/27 expectativas.
  - **Evidência:** unicidade da migration, fluxo idempotente do use case e `test/integration/double-entry-ledger.idempotency.test.ts`.

## Fase 4 — Backfill e reconciliação

- [x] **T-012 [FR-009, AC-007]** Implementar backfill histórico
  - Criar contas wallet e `LEGACY_COUNTERPARTY` por moeda.
  - Converter ledger existente de forma determinística e reexecutável, sem alterar dados de negócio.
  - **Verificação:** `bun run typecheck` passou; `bun test test/integration/ledger-backfill.test.ts` passou com 1 teste e 6 expectativas, mantendo saldo, versão e `updated_at`, criando 1 journal/2 postings `legacy-v1` e convertendo zero registros na segunda execução.
  - **Evidência:** `src/modules/ledger/application/ledger-backfill.service.ts`, exportação em `src/modules/ledger/ledger.module.ts` e fixture de integração.

- [x] **T-013 [FR-008, FR-009, FR-011, AC-009]** Integrar reconciliação contábil
  - Verificar balanceamento, conta, moeda, vínculo de transação, duplicidade e divergência com saldo/ledger.
  - Expor códigos de divergência em consulta interna/relatório sem payload sensível.
  - **Verificação:** `bun run typecheck` passou; `bun test test/integration/ledger-reconciliation.test.ts` passou com 1 teste/7 expectativas, confirmando relatório consistente e classificação determinística de `WALLET_POSTING_BALANCE_DIFFERENCE` em fixture divergente.
  - **Evidência:** `src/modules/ledger/application/ledger-reconciliation.service.ts`, exportação em `src/modules/ledger/ledger.module.ts` e teste de integração.

## Fase 5 — Mensageria, falhas e regressão

- [x] **T-014 [FR-003, FR-010, AC-008, AC-010]** Validar integração HTTP/SQS/Inbox/Outbox
  - Confirmar mesma construção contábil para HTTP e SQS.
  - Testar ack após commit, Outbox no mesmo commit e redelivery sem novo journal.
  - **Verificação:** `bun run typecheck` passou; `create-wallet`, `wagering.http`, `win-loss.http` e `refund-rollback.http` passaram; `sqs.inbox.test.ts` passou com 1 teste/4 expectativas, confirmando Inbox `PROCESSED`, Outbox, `WalletLedgerEntry` e 2 postings do BET (journal + contrapartida).
  - **Evidência:** fluxo HTTP/SQS comum em `ProcessWagerTransactionUseCase`, `test/integration/sqs.inbox.test.ts` e regressões financeiras focadas.

- [x] **T-015 [FR-007, FR-009, FR-010, AC-008, AC-009]** Testar falhas atômicas e recuperação
  - Simular erro antes do commit, crash após commit, falha de publisher e restart.
  - Confirmar ausência de journal parcial e preservação do journal confirmado.
  - **Verificação:** `bun run typecheck` e 6 testes de atomicidade/recuperação passaram com 12 expectativas; `bun run test:resilience` passou em 2 rodadas, cobrindo 14 cenários, incluindo crash antes/depois do commit, lease recovery, SIGTERM, concorrência e falhas transient/poison.
  - **Evidência:** execução oficial pelo `test/resilience/run-resilience.ts`, que aplica os overrides Docker antes de cada cenário; nenhum journal parcial ou efeito financeiro duplicado foi observado.

- [x] **T-016 [FR-001..FR-011, AC-001..AC-010]** Executar regressão completa
  - Rodar typecheck, build, unitários, integração, resiliência e carga existente.
  - Confirmar contratos públicos, README, arquitetura e resultados das features anteriores.
  - **Verificação:** `bun run typecheck` e `bun run build` passaram; `bun run test:unit` passou com 176 testes/533 expectativas; `bun run test:integration` passou com 66 testes/264 expectativas; `bun run test:resilience` passou em 14 cenários por 2 rodadas; `bun run test:load` passou nos 4 cenários reais (`distributed-throughput`, `hot-wallet`, `replay-redelivery`, `outbox-pressure`).
  - **Evidência:** relatórios em `artifacts/load/load-01a1474d-904c-7732-a33b-7dc6048b8ab9.json` e `.md`; isolamento Docker documentado em `test/resilience/run-resilience.ts`, `docker-compose.resilience.yml` e `docker-compose.load.yml`. A verificação Git não foi aplicável porque o diretório de trabalho não possui metadados Git disponíveis.

- [x] **T-017 [FR-001..FR-011, AC-001..AC-010]** Auditar migration, backfill e dados gerados
  - Revisar schema, índices, append-only, contas legadas, journals e postings gerados.
  - Confirmar ausência de secrets, payloads desnecessários e registros fora do escopo.
  - **Verificação:** `bun run typecheck` passou; auditoria somente leitura no PostgreSQL isolado confirmou 3 tabelas de ledger, 11 índices, triggers de imutabilidade e balanceamento, 18 contas `ledger-v1`, 2.751 journals e 5.502 postings; invariantes `unbalanced`, divergência de moeda/conta, conta wallet ausente, journal processado ausente e chave com padrão de segredo ficaram em zero. `t017-ledger-audit-3` passou nos quatro cenários de carga após o seed de `OPENING` ser corrigido para inserir journal + dois postings na mesma transação. Os 8 fixtures antigos sem journal foram reparados de forma delimitada com o mesmo seed transacional; nenhum dado externo foi alterado.
  - **Evidência:** `test/load/seed-opening-ledger.ts`, os quatro cenários em `test/load/scenarios/`, `artifacts/load/t017-ledger-audit-3.json` e `.md`, migrations `Migration20261016050000`/`60000` e consultas de invariantes executadas contra o PostgreSQL isolado.

- [x] **T-018 [FR-001..FR-011, AC-001..AC-010]** Auditar convergência e preparar aprovação
  - Auditar Spec ↔ plano ↔ tarefas ↔ código ↔ migrations ↔ testes ↔ arquitetura.
  - Registrar comandos, resultados, limitações e arquivos alterados.
  - Atualizar Spec, plano e tarefas para `Implementação verificada — aguardando aprovação final`, sem aprovar automaticamente.
  - **Verificação:** `bun run typecheck` passou; `bun run test:unit` passou com 176 testes/533 expectativas; `bun run test:integration` passou com 66 testes/264 expectativas usando `DATABASE_URL`, `SQS_ENDPOINT`, `SQS_QUEUE_URL` e `OUTBOX_EVENTS_QUEUE_URL` do ambiente isolado; build, resiliência e carga permanecem verdes conforme T-016 e T-017. A checagem de convergência confirmou FR-001..FR-011 e AC-001..AC-010 cobertos, somente esta tarefa ficou pendente antes do fechamento e README/`ARCHITECTURE.md` permaneceram intactos.
  - **Evidência:** Spec, plano e tarefas atualizados para `Implementação verificada — aguardando aprovação final`; nenhum arquivo de README/arquitetura foi alterado. A aprovação final continua explicitamente pendente.

## Dependências e ordem

`T-001` precede todas as demais. `T-002` e `T-003` precedem schema e integração. `T-004`–`T-006` precedem T-007. `T-007` precede T-008–T-011. `T-012` depende do schema e das projeções. `T-013` depende de persistência e backfill. `T-014`–`T-015` dependem da integração financeira. `T-016`–`T-018` encerram a entrega.

## Fora da execução desta lista

- criar plano de contas regulatório ou regras fiscais;
- alterar semântica de `LOSS`, referências, retry, DLQ ou Outbox além do necessário para integrar os postings;
- criar endpoint público novo sem decisão posterior;
- apagar ou reescrever o ledger histórico;
- corrigir divergências automaticamente;
- alterar `README.md` ou `ARCHITECTURE.md` sem decisão explícita.
