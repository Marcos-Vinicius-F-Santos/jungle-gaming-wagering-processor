# Tarefas — Reconciliação financeira da wallet

Plano relacionado: [`./plano.md`](./plano.md)  
Spec relacionada: [`../../03-features/10-reconciliacao-financeira/spec.md`](../../03-features/10-reconciliacao-financeira/spec.md)  
Arquitetura: [`../../02-arquitetura/arquitetura.md`](../../02-arquitetura/arquitetura.md)  
Produto: [`../../01-produto/spec.md`](../../01-produto/spec.md)

## Regra das tarefas

Cada tarefa é pequena o suficiente para revisão individual, referencia requisitos da Spec e descreve sua verificação. A implementação deve ocorrer em ordem, uma tarefa por vez. Nenhuma tarefa aprova a própria entrega.

Status: Rascunho — aguardando aprovação formal do plano e tarefas

## Fase 1 — Baseline e contratos

- [x] **T-001 [FR-001..FR-010, AC-001..AC-013]** Confirmar o baseline do schema e dos ports existentes
  - Arquivos/módulos: `src/modules/wallets/`, `src/shared/domain/money.ts`, migrations, módulos e testes atuais.
  - Registrar entidades, constraints, ordem cronológica disponível, comportamento de `WalletLedgerEntry`, métricas/logger e ausência de módulo de reconciliação; confirmar que nenhuma migration nova é necessária.
  - **Verificação:** `bun run typecheck` passou; `bun test` passou após repetir isoladamente o único cenário inicialmente flakey do publisher SQS (`171 testes, 0 falhas, 556 expectativas` na suíte final de baseline; teste isolado do publisher também passou). Checklist registrou os limites e o `README.md` permaneceu inalterado.

- [x] **T-002 [FR-007, BR-003, AC-004..AC-008]** Criar read models, port de snapshot e códigos de issue
  - Arquivos/módulos: `src/modules/reconciliation/application/ports/`, tipos da aplicação e testes de contrato.
  - Definir `ReconciliationSnapshot`, `ReconciliationLedgerEntrySnapshot`, `ReconciliationQueryRepository`, `ReconciliationIssueCode` e o resultado imutável, mantendo `difference` como decimal assinado exato separado de `Money`.
  - **Verificação:** `bun run typecheck` e `bun test test/unit/reconciliation-contracts.test.ts` passaram; contrato cobre snapshot raw imutável, resultado com diferença negativa, port sem escrita e seis códigos estáveis.

## Fase 2 — Cálculo e validação da reconciliação

- [x] **T-003 [FR-004..FR-006, BR-002, BR-003]** Implementar o calculador exato da reconciliação
  - Arquivos/módulos: `src/modules/reconciliation/application/`, componente puro de cálculo e testes unitários.
  - Somar créditos, subtrair débitos a partir de zero, calcular saldo final e `difference = calculatedBalance - storedBalance`, sem `number`, `float` ou `double`.
  - **Verificação:** `bun run typecheck` e `bun test test/unit/reconciliation-calculator.test.ts` passaram; 2 testes cobriram reconstrução por crédito/débito, ledger vazio, diferença negativa, zero e duas casas decimais sem ponto flutuante.

- [x] **T-004 [FR-005, FR-007, AC-005..AC-008]** Validar aritmética, moeda e cadeia do ledger
  - Arquivos/módulos: calculador e catálogo de issues.
  - Detectar `LEDGER_ENTRY_UNBALANCED`, `LEDGER_CHAIN_BROKEN`, `LEDGER_INITIAL_BALANCE_INVALID`, `LEDGER_NEGATIVE_BALANCE` e `LEDGER_CURRENCY_MISMATCH`; deduplicar e ordenar issues de forma determinística.
  - **Verificação:** `bun run typecheck` e `bun test test/unit/reconciliation-calculator.test.ts` passaram; 5 testes cobriram lançamento desbalanceado, cadeia quebrada, saldo inicial inválido, saldo negativo, moeda incompatível, deduplicação e ordenação determinística dos seis códigos.

- [x] **T-005 [FR-007, AC-001..AC-008]** Criar mapper do resultado de reconciliação
  - Arquivos/módulos: aplicação/HTTP de reconciliation e testes unitários.
  - Mapear saldos como objetos com amount/currency, diferença assinada com duas casas, `checkedEntries`, `consistent` e `issues`, sem expor IDs individuais ou campos de infraestrutura.
  - **Verificação:** `bun run typecheck` e `bun test test/unit/reconciliation-response.mapper.test.ts` passaram; o mapper preserva diferença negativa, lista issues sem alias mutável e não expõe campos internos.

## Fase 3 — Snapshot PostgreSQL e aplicação

- [x] **T-006 [FR-003, BR-001, BR-006, AC-009..AC-011]** Implementar query raw de snapshot da wallet e ledger
  - Arquivos/módulos: `src/modules/reconciliation/infrastructure/persistence/` e adapter MikroORM.
  - Ler somente as colunas necessárias de `wallets` e `wallet_ledger_entries`, retornar `null` para wallet ausente e preservar strings decimais sem reidratar `WalletLedgerEntry` para executar regras financeiras.
  - **Verificação:** `bun run typecheck` e `bun test test/unit/reconciliation-query.repository.test.ts` passaram; 2 testes confirmaram snapshot raw, escopo da wallet, ausência de leitura do ledger quando a wallet não existe e adapter sem `persist`/`flush`.

- [x] **T-007 [FR-003, BR-001, BR-006, AC-009]** Garantir snapshot `READ ONLY` com isolamento consistente
  - Arquivos/módulos: adapter de snapshot, infraestrutura de banco e testes de integração.
  - Executar a leitura em transação PostgreSQL `READ ONLY` com `REPEATABLE READ`, sem lock de escrita, ou implementar equivalente explicitamente testado.
  - **Verificação:** `bun run typecheck` e `bun test test/integration/reconciliation-snapshot.test.ts` passaram com PostgreSQL real; o adapter usa `EntityManager.transactional` com `IsolationLevel.REPEATABLE_READ` e `readOnly: true`, lê wallet/ledger juntos e retorna `null` sem escrita para wallet ausente.

- [x] **T-008 [FR-002, FR-006, FR-008..FR-010]** Criar o caso de uso `ReconcileWalletUseCase`
  - Arquivos/módulos: `src/modules/reconciliation/application/` e erros de aplicação.
  - Validar identificador, solicitar um snapshot, mapear ausência para `WalletNotFoundError`, executar cálculo, tratar divergência como resultado e infraestrutura como falha indisponível.
  - **Verificação:** `bun run typecheck` e `bun test test/unit/reconcile-wallet.use-case.test.ts` passaram; 3 testes confirmaram snapshot único, validação antes da query, wallet ausente e falha de repository mapeadas com segurança.

- [x] **T-009 [FR-009, BR-004, AC-012]** Instrumentar reconciliação com logs e métricas
  - Arquivos/módulos: caso de uso, porta de métricas e logger existentes.
  - Emitir `wallet_reconciliations_total`, `wallet_reconciliation_entries_checked_total` e `wallet_reconciliation_duration_ms` com outcomes controlados; registrar divergências com correlação e IDs apenas em logs.
  - **Verificação:** `bun run typecheck` e `bun test test/unit/reconciliation-metrics.test.ts test/unit/reconcile-wallet.use-case.test.ts` passaram; 6 testes confirmaram outcomes controlados, duração, contagem de entradas, log de divergência, ausência de IDs nas tags e tolerância à falha de métricas.

- [x] **T-010 [FR-001, FR-002, FR-008, FR-010]** Registrar o módulo de reconciliação
  - Arquivos/módulos: `src/modules/reconciliation/reconciliation.module.ts`, `src/app/` e providers de infraestrutura.
  - Registrar port, adapter, calculador, caso de uso, logger/métricas e controller sem alterar providers ou fluxos de `wallets`/`wagering`.
  - **Verificação:** `bun run typecheck` e `bun test test/integration/reconciliation-snapshot.test.ts` passaram com `AppModule`; o token de snapshot foi resolvido pelo módulo e o adapter real foi usado sem dependência circular.

## Fase 4 — Interface HTTP e testes de contrato

- [x] **T-011 [FR-001, FR-002, FR-007, FR-010]** Expor `POST /wallets/:walletId/reconciliation`
  - Arquivos/módulos: `src/modules/reconciliation/http/` e controller/module wiring.
  - Usar `ParseUUIDPipe`, aceitar request sem corpo, retornar o read model e mapear `WALLET_NOT_FOUND` para 404 e `RECONCILIATION_UNAVAILABLE` para 503.
  - **Verificação:** `bun run typecheck` e `bun test test/unit/reconciliation.controller.test.ts` passaram; 2 testes confirmaram resultado divergente compatível com 200, mapeamento de 400/404/503 e controller sem acesso ao banco.

- [x] **T-012 [FR-007, FR-010, BR-004]** Validar contrato HTTP e erros seguros
  - Arquivos/módulos: testes unitários/HTTP e mappers de erro.
  - Confirmar `issues`, diferença negativa, códigos estáveis, ausência de SQL/stack trace/segredos e preservação do correlation ID existente.
  - **Verificação:** `bun run typecheck` e `bun test test/integration/reconciliation.http.test.ts test/unit/reconciliation.controller.test.ts` passaram; 4 testes confirmaram JSON estável, diferença/fields seguros, correlation ID, 400, 404 e ausência de detalhes internos.

## Fase 5 — Integração, concorrência e ausência de efeitos colaterais

- [x] **T-013 [AC-001..AC-004, AC-008]** Testar reconciliação consistente e divergente com PostgreSQL real
  - Arquivos/módulos: `test/integration/reconciliation.test.ts` e fixtures existentes.
  - Criar wallet zero, wallet com `OPENING` e operações válidas; provocar divergência controlada no saldo materializado dentro das regras do banco; validar saldo calculado, diferença, `checkedEntries`, `issues` e status HTTP.
  - **Verificação:** `bun run typecheck` e `bun test test/integration/reconciliation.test.ts` passaram; 2 testes confirmaram wallet vazia, `OPENING` + `BET`, precisão do saldo e divergência controlada em 200 lógico sem autocorreção.

- [x] **T-014 [AC-005..AC-008]** Testar classificação de cadeia e moeda
  - Arquivos/módulos: testes unitários do calculador e integração de leitura raw.
  - Cobrir lançamento aritmeticamente inconsistente, cadeia quebrada, primeiro saldo diferente de zero, saldo negativo e moeda incompatível, usando fixture segura para não alterar constraints permanentes.
  - **Verificação:** `bun run typecheck` e `bun test test/unit/reconciliation-calculator.test.ts test/unit/reconciliation-query.repository.test.ts` passaram; 7 testes cobriram aritmética, cadeia, saldo inicial, saldo negativo, moeda incompatível, ordenação raw e ausência de wallet. Constraints do PostgreSQL continuam impedindo corrupção aritmética persistida.

- [x] **T-015 [AC-009]** Testar snapshot durante processamento concorrente
  - Arquivos/módulos: `test/integration/` com PostgreSQL real e fluxo financeiro existente.
  - Executar reconciliação enquanto uma operação financeira disputa a mesma wallet e confirmar que o resultado pertence integralmente ao estado antes ou depois do commit observado.
  - **Verificação:** `bun run typecheck` e `bun test test/integration/reconciliation.test.ts` passaram; 3 testes confirmaram que a reconciliação permanece consistente antes/depois de commit concorrente, sem diferença impossível ou lançamento duplicado.

- [x] **T-016 [AC-010, AC-013]** Validar ausência de efeitos colaterais e regressão
  - Arquivos/módulos: testes de integração de leitura, wallet, wagering, Inbox, Outbox, SQS e health.
  - Capturar saldo, versões, ledger, transações, Inbox e Outbox antes/depois de reconciliações consistentes, divergentes e indisponíveis; executar a regressão completa.
  - **Verificação:** `bun run typecheck` e regressão focada com 7 testes/35 expectativas passaram (`read-no-side-effects`, HTTP queries, health, SQS Inbox e Outbox repository); snapshots financeiros permaneceram iguais e fluxos anteriores continuaram passando.

## Fase 6 — Convergência e entrega

- [ ] **T-017 [FR-001..FR-010, AC-001..AC-013]** Executar verificação técnica final
  - Arquivos/módulos: código, Spec, plano, tarefas e testes.
  - Rodar typecheck, build, testes unitários, integração real, auditoria de logs/métricas, validação de isolamento e confirmação de que não houve migration ou alteração do README.
  - **Verificação prevista:** `bun run typecheck`, `bun run build`, suíte focada, suíte completa e checks de schema passam; evidências ficam registradas sem afirmar aprovação final.

- [ ] **T-018 [FR-001..FR-010]** Preparar aprovação da feature
  - Arquivos/módulos: Spec, plano e tarefas.
  - Preencher checklist Spec ↔ Plano ↔ Código ↔ Testes, registrar evidências e atualizar os três documentos para `Implementação verificada — aguardando aprovação final`, sem marcar aprovação automaticamente.
  - **Verificação prevista:** todos os critérios verificáveis estão associados a evidência; entrega aguarda revisão explícita do usuário.

## Dependências e ordem

`T-001` precede todas as demais. `T-002`–`T-005` precedem o adapter e o caso de uso. `T-006` precede `T-007`; `T-007` precede `T-008` e `T-015`. `T-009` pode ser implementada após `T-008`. `T-010` precede `T-011`. `T-011` precede `T-012`–`T-016`. `T-013` e `T-014` dependem do wiring completo. `T-015` e `T-016` dependem do snapshot e do endpoint. `T-017` e `T-018` são finais e não aprovam a entrega sozinhos.

## Fora desta lista

- Corrigir saldo, inserir lançamento compensatório ou alterar o ledger.
- Alterar regras financeiras, transações, Inbox, Outbox, SQS, workers ou health.
- Criar reconciliação em lote, agendamento, dashboard, exportação, alertas ou APM.
- Implementar autenticação artesanal.
- Criar migration sem necessidade comprovada pelo schema.
- Alterar o `README.md`.
