# Tarefas — Consultas de ledger e transações

Plano relacionado: [`./plano.md`](./plano.md)  
Spec relacionada: [`../../03-features/09-consultas-ledger-transacoes/spec.md`](../../03-features/09-consultas-ledger-transacoes/spec.md)  
Arquitetura: [`../../02-arquitetura/arquitetura.md`](../../02-arquitetura/arquitetura.md)  
Produto: [`../../01-produto/spec.md`](../../01-produto/spec.md)

## Regra das tarefas

Cada tarefa é pequena o suficiente para revisão individual, referencia requisitos da Spec e descreve sua verificação. A implementação deve ocorrer em ordem, uma tarefa por vez. Nenhuma tarefa aprova a própria entrega.

Status: Implementação verificada — aguardando aprovação final

## Fase 1 — Baseline, contratos e cursor

- [x] **T-001 [FR-001..FR-009, AC-001..AC-015]** Confirmar baseline das consultas existentes
  - Arquivos/módulos: `src/modules/wallets/`, `src/modules/wagering/`, migrations e testes atuais.
  - Mapear o comportamento atual de `GET /wallets/:walletId`, repositories, entidades, constraints e ordem da leitura existente do ledger sem alterar o README.
  - **Verificação:** `bun run typecheck` e `bun test` passaram com 142 testes, 0 falhas e 431 expectativas; baseline registrou os gaps de query, o retorno restrito a `OPENING` e a ausência de índice composto do ledger.

- [ ] **T-002 [FR-003, FR-006, FR-007, BR-005]** Definir read models e ports de consulta
  - Arquivos/módulos: `src/modules/wallets/application/ports/`, `src/modules/wagering/application/ports/` e tipos de aplicação.
  - Criar DTOs/read models imutáveis para ledger e transações, sem `payloadHash`, payload bruto ou `idempotencyKey` por padrão; separar ports de query dos ports de escrita.
  - **Verificação:** typecheck e testes de contrato confirmam campos, datas seguras, valores monetários string e cobertura de todos os kinds/status.

- [x] **T-003 [FR-002, BR-003, BR-004, AC-004..AC-007]** Implementar codec e validação do cursor
  - Arquivos/módulos: `src/modules/wallets/application/` ou `src/shared/application/`, testes unitários.
  - Codificar/decodificar `(createdAt, id)` em Base64URL, validar UTC/UUID, limitar tamanho e rejeitar cursor incompatível com a wallet consultada.
  - **Verificação:** `bun run typecheck` e `bun test test/unit/ledger-cursor.codec.test.ts` passaram; 3 testes e 9 expectativas cobrem round-trip, timestamp, cursor adulterado, cursor de outra wallet e formatos inválidos.

- [x] **T-004 [FR-002, AC-006, AC-007]** Implementar validação de paginação HTTP
  - Arquivos/módulos: DTO/query parser de wallets, testes unitários.
  - Aplicar `limit=50`, aceitar `1..100` e retornar erro seguro para zero, negativo, decimal, texto ou valor acima do máximo.
  - **Verificação:** `bun run typecheck` e `bun test test/unit/ledger-query.dto.test.ts` passaram; 3 testes e 11 expectativas cobrem default, limites válidos e inputs inválidos.

## Fase 2 — Persistência de leitura

- [x] **T-005 [FR-001, FR-002, AC-004..AC-007]** Criar índice reversível de paginação do ledger
  - Arquivos/módulos: `src/infrastructure/database/migrations/`.
  - Criar e reverter o índice `(wallet_id, created_at DESC, id DESC)` sem alterar constraints existentes.
  - **Verificação:** `bun run typecheck`, `bun run migration:up` e `bun test test/integration/ledger-pagination-index.test.ts` passaram; migration aplicada e 1 teste com 2 expectativas confirmou o índice no PostgreSQL.

- [x] **T-006 [FR-001..FR-003, FR-007, BR-001..BR-005]** Implementar query paginada do ledger
  - Arquivos/módulos: port de query do ledger e `MikroOrmLedgerRepository` ou adapter de leitura separado.
  - Buscar `limit + 1`, aplicar wallet/cursor, ordenar por `created_at DESC, id DESC`, mapear campos exatos e não executar escrita.
  - **Verificação:** `bun run typecheck` e `bun test test/integration/ledger-query.test.ts` passaram; 1 teste com 9 expectativas confirmou `limit + 1`, duas páginas sem repetição/salto, escopo por wallet e dinheiro como string.

- [x] **T-007 [FR-004..FR-006, FR-008, AC-008..AC-011]** Implementar query de transações
  - Arquivos/módulos: port de query e adapter MikroORM de `wager_transactions`.
  - Consultar por ID e por `(providerId, externalTransactionId)`, retornando `OPENING`, todos os kinds/status, referências, falhas e saldo resultante sem reidratação financeira.
  - **Verificação:** `bun run typecheck` e `bun test test/integration/wager-transaction-query.test.ts` passaram; 1 teste com 9 expectativas confirmou `OPENING`, `BET`, consulta pelas duas identidades, escopo do provider e ausência de campos secretos.

- [x] **T-008 [FR-008, BR-006, BR-007]** Criar mappers de resposta segura
  - Arquivos/módulos: aplicação/HTTP de wallets e wagering.
  - Converter datas para ISO UTC, manter valores como strings, omitir hash/payload/idempotency key e preservar `null`/ausência conforme contrato.
  - **Verificação:** `bun run typecheck` e `bun test test/unit/query-response-mappers.test.ts` passaram; 2 testes e 8 expectativas confirmaram precisão, ISO UTC, campos opcionais e ausência de detalhes internos.

## Fase 3 — Casos de uso e HTTP

- [x] **T-009 [FR-001, FR-002, FR-007, AC-001..AC-007]** Criar caso de uso de consulta do ledger
  - Arquivos/módulos: `src/modules/wallets/application/`.
  - Validar wallet existente, cursor e limit; chamar somente o port de leitura; gerar `nextCursor` quando houver próxima página.
  - **Verificação:** `bun run typecheck` e `bun test test/unit/list-ledger.use-case.test.ts` passaram; 4 testes e 10 expectativas cobriram next cursor, página vazia, limite inválido e cursor incompatível sem executar query.

- [x] **T-010 [FR-004..FR-006, FR-007, AC-008..AC-011]** Criar casos de uso de consulta de transação
  - Arquivos/módulos: `src/modules/wagering/application/`.
  - Expor consultas por ID e provider/external ID, mapear ausência para erro de aplicação e não chamar o caso de uso financeiro.
  - **Verificação:** `bun run typecheck` e `bun test test/unit/get-wager-transaction.use-case.test.ts` passaram; 3 testes e 7 expectativas confirmaram equivalência entre consultas, 404 seguro, provider incorreto e rejeição de input sem query.

- [x] **T-011 [FR-001..FR-003, BR-003, AC-001..AC-007]** Expor `GET /wallets/:walletId/ledger`
  - Arquivos/módulos: `src/modules/wallets/http/`, módulo de wallets e testes de controller.
  - Adicionar query params `cursor`/`limit`, resposta com `walletId`, `items` e `nextCursor`, `ParseUUIDPipe` e mapeamento de 400/404/503.
  - **Verificação:** `bun run typecheck` e `bun test test/unit/wallets.controller.test.ts test/unit/wallets-ledger.controller.test.ts` passaram; 3 testes e 9 expectativas confirmaram contrato JSON, status e ausência de acesso direto ao banco.

- [x] **T-012 [FR-004..FR-006, AC-008..AC-013]** Expor consultas de transação
  - Arquivos/módulos: controller/módulo de wagering e testes HTTP/unitários.
  - Adicionar `GET /wagering/transactions/:transactionId` e `GET /providers/:providerId/wagering/transactions/:externalTransactionId` com read model comum.
  - **Verificação:** `bun run typecheck`, `bun test test/unit/wagering-transaction-query.controller.test.ts test/unit/wagering.controller.test.ts` e `bun test test/integration/query.http.test.ts` passaram; 5 testes e 23 expectativas confirmaram 200, 400, 404, 503, provider escopado e ausência de segredo.

- [x] **T-013 [FR-009, AC-013, AC-015]** Instrumentar consultas
  - Arquivos/módulos: casos de uso de leitura, porta de métricas e logger estruturado.
  - Emitir `read_queries_total` e `read_query_duration_ms` com `operation`/`outcome`, mantendo IDs fora das tags e correlação nos logs.
  - **Verificação:** `bun run typecheck` e `bun test test/unit/query-metrics.test.ts test/unit/list-ledger.use-case.test.ts test/unit/get-wager-transaction.use-case.test.ts` passaram; 10 testes e 25 expectativas confirmaram outcomes, tags sem IDs e tolerância a falha de métricas.

## Fase 4 — Verificação de integração e regressão

- [x] **T-014 [AC-001..AC-007, AC-012]** Testar ledger com PostgreSQL real
  - Arquivos/módulos: `test/integration/`.
  - Criar wallet/lançamentos por fluxos existentes, consultar múltiplas páginas, timestamps iguais, cursor final, wallet vazia e wallet inexistente.
  - **Verificação:** `bun test test/integration/ledger-query.test.ts test/integration/ledger-pagination-index.test.ts` passou; 2 testes e 14 expectativas confirmaram PostgreSQL, ordenação/paginação, escopo, índice, wallet vazia e wallet inexistente.

- [x] **T-015 [AC-008..AC-013]** Testar transações com PostgreSQL real
  - Arquivos/módulos: `test/integration/`.
  - Consultar transações de todos os kinds/status e pelo provider/external ID, incluindo `OPENING`, pendência, rejeição e replay.
  - **Verificação:** `bun test test/integration/wager-transaction-query.test.ts` passou; 1 teste e 24 expectativas confirmaram os seis kinds, cinco estados relevantes, equivalência dos lookups, provider escopado e ausência de segredos.

- [x] **T-016 [AC-012, AC-014]** Validar ausência de efeitos colaterais
  - Arquivos/módulos: integração de leitura e queries de snapshot.
  - Capturar saldo, versão, ledger, transações, Inbox e Outbox antes/depois das consultas, incluindo falha de leitura e paginação.
  - **Verificação:** `bun test test/integration/read-no-side-effects.test.ts` passou; 1 teste confirmou snapshots iguais de saldo/versão, ledger, transações, Inbox e Outbox após consultas.

- [x] **T-017 [AC-014]** Executar regressão dos fluxos existentes
  - Arquivos/módulos: testes HTTP, wagering, wallet, SQS/Inbox, referências, Outbox e health.
  - Confirmar que os novos ports, índice, módulos e controllers não alteram processamento, envelopes, retries, shutdown ou health.
  - **Verificação:** `bun run typecheck` e `bun test` passaram; 170 testes, 0 falhas e 544 expectativas, sem alteração do README.

## Fase 5 — Convergência e entrega

- [x] **T-018 [FR-001..FR-009, AC-001..AC-015]** Executar verificação técnica final
  - Arquivos/módulos: código, migration, testes, Spec, plano e tarefas.
  - Rodar typecheck, build, unitários, integração real, auditoria de logs/DTOs/cursor e validação do índice.
  - **Verificação:** `bun run typecheck`, `bun run build`, ciclo `bun run migration:down`/`bun run migration:up` e `bun test` passaram; suíte final com 171 testes, 0 falhas e 558 expectativas, incluindo PostgreSQL, LocalStack, HTTP e validação do índice.

- [x] **T-019 [FR-001..FR-009]** Preparar aprovação da feature
  - Arquivos/módulos: documentação da feature e evidências finais.
  - Atualizar status da Spec, plano e tarefas para implementação verificada aguardando aprovação, sem marcar aprovação automaticamente.
  - **Verificação:** checklist Spec ↔ Plano ↔ Código ↔ Testes preenchido; status dos três documentos atualizado para implementação verificada aguardando aprovação; README não alterado; entrega aguarda revisão do usuário.

## Dependências e ordem

`T-001` precede todas as demais. `T-002`–`T-004` precedem os adapters e casos de uso. `T-005` precede `T-006` e `T-014`. `T-006`–`T-008` precedem `T-009`–`T-012`. `T-013` pode ser implementada após os casos de uso. `T-014`–`T-016` dependem do wiring HTTP completo. `T-017` depende da integração. `T-018` e `T-019` são finais e não aprovam a entrega sozinhos.

## Fora desta lista

- Alterar regras financeiras ou contratos de escrita.
- Criar reconciliação, filtros avançados, exportação, cache ou dashboard.
- Alterar Inbox, Outbox, SQS, workers ou health além da instrumentação de leitura.
- Implementar autenticação artesanal.
- Alterar o `README.md`.
