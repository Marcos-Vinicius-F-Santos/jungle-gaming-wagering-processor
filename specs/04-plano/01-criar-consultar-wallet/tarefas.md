# Tarefas — Criar e consultar Wallet com saldo inicial

Plano relacionado: [`specs/04-plano/01-criar-consultar-wallet/plano.md`](./plano.md)
Spec relacionada: [`specs/03-features/01-criar-consultar-wallet/spec.md`](../../03-features/01-criar-consultar-wallet/spec.md)
Status: Concluído e aprovado em 2026-10-15

Escopo aprovado desta rodada: execução e verificação das fases 1 a 5. A fase 06 de deploy não existe por enquanto, pois o projeto não possui Git nem fluxo de deploy configurado; ela será definida em uma rodada futura.

## Regra das tarefas

Cada tarefa é pequena o suficiente para revisão isolada, referencia os requisitos funcionais que implementa e informa como verificar que ficou pronta. Não implementar tarefas futuras nesta rodada.

## Fase 1 — Base

- [x] **T-001 [FR-001, FR-005]** Confirmar bootstrap do módulo `wallets`, configuração do NestJS strict e MikroORM
  - Arquivos/módulos: `src/modules/wallets/`, configuração da aplicação e `app.module.ts`
  - Verificação: aplicação inicia com Bun e o módulo é carregado sem dependência de HTTP/SQS no domínio.

- [x] **T-002 [FR-001, FR-002, FR-003, FR-004, FR-008, FR-009]** Criar migration reversível para `wallets`, `wager_transactions` e `wallet_ledger_entries`
  - Arquivos/módulos: `src/migrations/` ou diretório de migrations definido pelo projeto
  - Verificação: migration `up` cria PKs, FKs, `NUMERIC(19,2)`, checks e uniques; migration `down` reverte em PostgreSQL real.

- [x] **T-003 [FR-001, FR-002, FR-005]** Criar portas de repositório, Unit of Work, `Clock` e gerador UUIDv7
  - Arquivos/módulos: `src/modules/wallets/application/`, `src/shared/` e adapters MikroORM
  - Verificação: casos de uso dependem de interfaces; nenhum domínio importa entidade ou decorator do ORM.

## Fase 2 — Lógica principal

- [x] **T-004 [FR-007]** Implementar `Money` com escala fixa, moeda e validações
  - Arquivos/módulos: `src/modules/wallets/domain/` ou shared domain definido na arquitetura
  - Verificação: testes rejeitam vazio, `NaN`, `Infinity`, notação científica, mais de duas casas, negativo e moeda inválida; operações preservam precisão.

- [x] **T-005 [FR-001, FR-003, FR-004, FR-009]** Implementar o aggregate `Wallet`
  - Arquivos/módulos: `src/modules/wallets/domain/`
  - Verificação: `open` inicia `version = 1`, impede saldo negativo e representa a unicidade de `(playerId, currency)` como regra persistida.

- [x] **T-006 [FR-002, FR-003, FR-008]** Implementar `WagerTransaction`/`OPENING` e `WalletLedgerEntry`
  - Arquivos/módulos: `src/modules/wagering/domain/` e `src/modules/wallets/domain/`
  - Verificação: saldo positivo gera um crédito balanceado; saldo zero não gera lançamento; ledger não possui transições mutáveis.

- [x] **T-007 [FR-001, FR-002, FR-003, FR-004, FR-008, FR-009]** Implementar `CreateWalletUseCase` com transação SQL única
  - Arquivos/módulos: `src/modules/wallets/application/`
  - Verificação: criação positiva persiste wallet + `OPENING` + ledger; falha intermediária faz rollback completo; conflito de unique não cria duplicata.

- [x] **T-008 [FR-005, FR-006]** Implementar `GetWalletUseCase` e DTO de leitura
  - Arquivos/módulos: `src/modules/wallets/application/` e mapeadores
  - Verificação: retorna saldo/version persistidos para wallet existente e resultado de não encontrado para ID ausente, sem expor entidade ORM.

## Fase 3 — Interface

- [x] **T-009 [FR-001, FR-007, FR-010]** Implementar DTO e validação de criação
  - Arquivos/módulos: `src/modules/wallets/http/`
  - Verificação: `playerId` UUID é aceito; valor monetário é string decimal; moeda ISO-4217 válida é normalizada para maiúsculas; entradas inválidas retornam erro de validação.

- [x] **T-010 [FR-001, FR-002, FR-003, FR-004, FR-008, FR-009]** Implementar `POST /wallets`
  - Arquivos/módulos: controller e presenter de wallets
  - Verificação: sucesso retorna `201`; duplicidade retorna `409`; falha transitória sem commit retorna `503`; nenhum controller acessa banco diretamente.

- [x] **T-011 [FR-005, FR-006]** Implementar `GET /wallets/:walletId`
  - Arquivos/módulos: controller e presenter de wallets
  - Verificação: sucesso retorna `200` no formato da Spec; wallet inexistente retorna `404`; consulta não altera estado.

- [x] **T-012 [FR-001, FR-005, FR-007]** Implementar logs estruturados mínimos do fluxo
  - Arquivos/módulos: adapter de observabilidade e casos de uso
  - Verificação: logs permitem correlacionar operação e wallet sem registrar payload financeiro completo ou segredo.

## Fase 4 — Testes

- [x] **T-013 [FR-007]** Cobrir `Money` e validação de moeda/UUID com testes unitários
  - Arquivos/módulos: testes do domínio e DTOs
  - Verificação: cobrir casos válidos, caixa baixa/mista, código ISO inválido, escala inválida e UUID inválido.

- [x] **T-014 [FR-001, FR-002, FR-003, FR-004, FR-008]** Cobrir Wallet, `OPENING` e ledger com testes unitários
  - Arquivos/módulos: testes de domínio
  - Verificação: confirmar version inicial, saldo zero, crédito inicial, aritmética do ledger e rejeição de saldo negativo.

- [x] **T-015 [FR-001, FR-002, FR-003, FR-004, FR-008]** Testar migrations e atomicidade com PostgreSQL real
  - Arquivos/módulos: testes de integração e Docker Compose
  - Verificação: executar `up/down`, confirmar constraints e simular falha antes do commit sem deixar registros parciais.

- [x] **T-016 [FR-001, FR-005, FR-006, FR-007]** Testar contrato HTTP de criação e consulta
  - Arquivos/módulos: testes de integração/e2e
  - Verificação: confirmar `201`, `200`, `400`, `404`, `409` e `503` conforme os cenários definidos.

- [x] **T-017 [FR-004, FR-009]** Testar criação concorrente real
  - Arquivos/módulos: teste de integração concorrente
  - Verificação: disparar requisições simultâneas para o mesmo player/moeda e confirmar uma única wallet, um único `OPENING` e um único ledger.

- [x] **T-018 [FR-001, FR-005]** Executar regressão mínima da aplicação
  - Arquivos/módulos: suíte completa disponível no projeto
  - Verificação: todos os testes existentes passam e não há comportamento anterior quebrado; registrar qualquer divergência.

## Fase 5 — Entrega

- [x] **T-019 [FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-007, FR-008, FR-009, FR-010]** Fazer revisão de convergência
  - Arquivos/módulos: `spec.md`, `plano.md`, `tarefas.md`, código e testes
  - Verificação: preencher o checklist de `specs/05-verificacao/checklist-convergencia.md` e apontar toda divergência.

- [x] **T-020 [FR-001, FR-008]** Documentar migration, rollback e evidências de verificação
  - Arquivos/módulos: documentação de deploy/verificação da feature
  - Verificação: outra pessoa consegue executar migration, rollback e roteiro de teste sem conhecimento implícito.

- [x] **T-021 [FR-001, FR-005]** Submeter a feature para revisão e aprovação
  - Arquivos/módulos: diff final da feature
  - Verificação: o revisor técnico revisa e aprova; a tarefa não é marcada como concluída automaticamente.

## Adiado (fora do escopo desta rodada)

- [ ] Processar `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`.
- [ ] Idempotência de transações de aposta e payload hash.
- [ ] Consumidor SQS, Inbox, Outbox e workers.
- [ ] Endpoint público paginado do ledger.
- [ ] Reconciliação.
- [ ] Autenticação.
- [ ] Teste de carga completo.
