# Checklist de Convergência — Processar BET

Status: Verificação executada — aguardando revisão e aprovação de Marcos.

Esta verificação cobre T-001 a T-021 da feature de processamento síncrono de `BET`. A fase 06 de deploy não faz parte desta rodada, conforme decisão aprovada.

## Documentos comparados

- Spec da feature: [`../03-features/02-processar-bet/spec.md`](../03-features/02-processar-bet/spec.md)
- Plano: [`../04-plano/02-processar-bet/plano.md`](../04-plano/02-processar-bet/plano.md)
- Tarefas: [`../04-plano/02-processar-bet/tarefas.md`](../04-plano/02-processar-bet/tarefas.md)
- Arquitetura: [`../02-arquitetura/arquitetura.md`](../02-arquitetura/arquitetura.md)

## Spec ↔ Plano ↔ Código ↔ Testes

| Área | Evidência | Resultado |
|---|---|---|
| Limites de módulo | `src/modules/wagering/wagering.module.ts`, `src/modules/wallets/wallets.module.ts` | Conforme |
| Migration e schema | `src/infrastructure/database/migrations/Migration20261015200000.ts`, `test/integration/wagering.atomicity.test.ts` | Conforme |
| Entidade e ports | `src/modules/wagering/infrastructure/persistence/`, `src/modules/wagering/application/ports/` | Conforme |
| Canonicalização/hash | `src/modules/wagering/application/canonical-payload-hasher.ts`, `test/unit/canonical-payload-hasher.test.ts` | Conforme |
| Domínio BET | `src/modules/wagering/domain/wager-transaction.ts`, `test/unit/wagering-domain.test.ts` | Conforme |
| Débito e optimistic locking | `src/modules/wallets/domain/wallet.ts`, `src/modules/wallets/application/ports/wallet-repository.port.ts` | Conforme |
| Caso de uso | `src/modules/wagering/application/process-wager-transaction.use-case.ts` | Conforme |
| Rejeições | `INSUFFICIENT_FUNDS`, `WALLET_MISMATCH`, wallet inexistente como `404` sem persistência | Conforme com decisão aprovada |
| Replay e conflitos | `test/unit/wagering-idempotency.test.ts`, `test/integration/wagering.http.test.ts` | Conforme |
| HTTP | `src/modules/wagering/http/`, `test/integration/wagering.http.test.ts` | Conforme |
| Observabilidade | eventos `wager.bet.processed`, `rejected`, `replay`, `conflict`, `retry` e `retry_exhausted` | Conforme |
| Atomicidade | `test/integration/wagering.atomicity.test.ts` | Conforme |
| Concorrência | `test/integration/wagering.concurrency.test.ts` | Conforme |
| Regressão | suíte completa existente de wallets | Conforme |

## Evidências executadas

- `bun run typecheck`: passou.
- `bun run build`: passou.
- `bun run test`: 46 testes passaram, 0 falharam, 123 expectativas.
- `bun run migration:down`: passou para `Migration20261015200000`.
- `bun run migration:up`: reaplicou `Migration20261015200000` com sucesso.
- Teste real de concorrência: duas BETs de `80.00` sobre `100.00` produziram uma `PROCESSED`, uma `REJECTED/INSUFFICIENT_FUNDS`, saldo `20.00` e um `DEBIT`.
- Teste real de idempotência: 50 reenvios paralelos produziram uma transação, um débito, uma resposta `201` e 49 respostas `200`.
- Teste real de rollback: falha forçada no ledger deixou saldo, versão, BET e ledger sem efeitos parciais.
- README preservado: 27.497 bytes; SHA-256 `47795FCE2FC38CAE5F1B91368EBAF80B7A2ED1FE147F36704B665FAF0613812E`.

## Divergências controladas

1. Wallet inexistente não é persistida como `REJECTED`: retorna `404` sem `WagerTransaction`, preservando a FK obrigatória. Essa alteração foi registrada e aprovada antes da implementação.
2. O lookup `findByIdempotencyKey`/`findByExternalTransactionId` foi preparado junto da atualização de entidade e adapter em T-003 e verificado formalmente em T-008; não houve mudança de comportamento fora do contrato.
3. Não foi criado adapter de métricas dedicado. A infraestrutura existente possui logger estruturado, então replay, conflito e retry são observáveis por eventos JSON sem ampliar escopo.
4. Não houve deploy, branch, commit ou rollback de aplicação: o projeto não possui Git nem fluxo de deploy configurado. A recuperação desta rodada cobre migration `down/up` e rollback transacional local.

## Fora desta rodada

- `WIN`, `LOSS`, `REFUND` e `ROLLBACK`.
- SQS, Inbox, DLQ, Outbox, referências fora de ordem e reconciliação.
- Autenticação.
- Teste de carga com três instâncias e relatório p50/p95/p99.
- Deploy de aplicação.

## Portão de aprovação

O checklist está preenchido e a verificação técnica foi executada. A feature permanece aguardando a revisão e aprovação de Marcos; este documento não marca tarefas nem a feature como concluídas automaticamente.
