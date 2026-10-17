# Plano de Implementação — Processar WIN e LOSS

Spec relacionada: [`../../03-features/03-processar-win-loss/spec.md`](../../03-features/03-processar-win-loss/spec.md)
Arquitetura relacionada: [`../../02-arquitetura/arquitetura.md`](../../02-arquitetura/arquitetura.md)
Status: Implementação verificada e aprovada por Marcos em 2026-10-16; deploy permanece fora desta rodada

Escopo desta rodada: fases 1 a 5. A fase 06 de deploy não existe por enquanto, pois o projeto não possui Git nem fluxo de deploy configurado.

## 1. Resumo técnico

Estender o caso de uso `ProcessWagerTransaction` e o endpoint existente para aceitar `WIN` e `LOSS`, preservando o processamento de `BET`. `WIN` usará o agregado `Wallet` para crédito atômico, optimistic locking e um lançamento `CREDIT`; `LOSS` persistirá somente a transação auditável, sem alterar saldo ou ledger. Ambos os fluxos enfileirarão os eventos exigidos na Outbox transacional mínima.

A referência de `WIN` será opcional. Quando informada, será resolvida por `(providerId, referenceExternalTransactionId)` e validada contra provider, player, wallet, moeda, rodada e `BET` compatível. Referência ausente seguirá o ciclo `PENDING_REFERENCE` com TTL de 15 minutos e backoff aprovado.

Idempotência, hash canônico, replay, conflitos, Outbox e transações SQL serão reutilizados ou estendidos a partir da feature de `BET`. Nenhum controller acessará o banco diretamente e nenhuma regra financeira será criada fora do caso de uso. SQS, Inbox, DLQ e redelivery continuam fora desta rodada.

## 2. Impacto no que já existe

| Componente/arquivo | Mudança | Risco |
|---|---|---|
| `src/modules/wagering/domain/wager-transaction.ts` | Suportar referência externa, `PENDING_REFERENCE`, `WIN`, `LOSS` e snapshots de replay sem quebrar `BET`/`OPENING` | Alto; estados terminais e transições incorretas podem gerar efeito duplicado |
| `src/modules/wallets/domain/wallet.ts` | Adicionar `credit` com moeda, decimal exato, versionamento e timestamp | Alto; crédito concorrente pode causar lost update |
| `src/modules/wagering/application/process-wager-transaction.use-case.ts` | Separar fluxo de débito, crédito e operação sem efeito financeiro | Alto; regressão pode alterar BET ou criar ledger para LOSS |
| `src/modules/wagering/http/dto/process-wager-transaction.dto.ts` | Aceitar `WIN`/`LOSS` e referência opcional | Médio; validação incompleta pode permitir payload incompatível |
| `src/modules/wagering/http/wagering.controller.ts` | Mapear `202` para pendência e respostas de `LOSS` | Médio; status inconsistente quebra consumidores |
| `WagerTransactionEntity` e migration | Persistir referência e metadados de pendência | Alto; schema, entidade e domínio precisam permanecer alinhados |
| `WagerTransactionRepository` | Buscar referência e localizar pendências vencidas/due | Alto; consulta incorreta pode reprocessar ou duplicar transações |
| `OutboxMessage` e porta de Outbox | Persistir eventos de processamento, rejeição, pendência e mudança de saldo na mesma transação | Alto; evento perdido ou publicado fora da transação quebra a arquitetura |
| wallets, ledger e BET existentes | Nenhuma mudança contratual intencional | Alto; regressão financeira exige suíte completa e concorrência real |

## 3. Componentes novos

- Portas e adapter para resolução de referência de `WagerTransaction`.
- Entidade, porta e persistência mínima de `OutboxMessage`, com envelope e versionamento dos eventos exigidos.
- Campos de domínio/persistência para `referenceExternalTransactionId`, primeira pendência, próxima tentativa e contador de tentativas, se confirmados pela implementação.
- Serviço/worker de reprocessamento de referências pendentes, isolado atrás de porta de aplicação e sem duplicar a operação original.
- Presenter/resultado de `LOSS` com snapshot de saldo inalterado e resultado `PENDING_REFERENCE`.
- Testes unitários, de integração PostgreSQL, HTTP e concorrência específicos de `WIN`/`LOSS`.

O worker não criará um segundo caso de uso financeiro: ele localizará a transação pendente e reutilizará `ProcessWagerTransaction` após a referência estar disponível.

## 4. Mudança de dados/banco

Criar uma migration nova e reversível, sem editar migrations aplicadas, para:

- adicionar `reference_external_transaction_id` nullable, com limite compatível com `external_transaction_id`;
- adicionar metadados de pendência necessários para preservar o primeiro instante, o próximo vencimento e as tentativas;
- manter `PENDING_REFERENCE` dentro dos statuses aceitos;
- criar checks de tamanho e consistência dos campos novos;
- manter as uniques `(provider_id, external_transaction_id)` e `(provider_id, idempotency_key)`;
- preservar o snapshot de saldo usado no replay;
- adicionar índices para localizar pendências due sem alterar a unicidade financeira.
- criar ou estender a tabela de Outbox necessária para persistir `eventId`, `eventType`, `aggregateId`, payload, tentativas e datas de publicação, sem incluir Inbox ou integração SQS;

O rollback deve remover somente os campos, checks e índices criados por esta migration. O ciclo local será `migration:up`, `migration:down` e `migration:up`, seguido de testes de integridade.

## 5. Sequência de implementação

### Fase 1 — Base

1. Confirmar boundaries do módulo wagering e os contratos de referência.
2. Criar migration reversível para referência e ciclo de pendência.
3. Atualizar entidade MikroORM, registros e ports de repositório.
4. Criar a persistência e porta mínima da Outbox.
5. Adicionar `Wallet.credit` e invariantes de crédito.

### Fase 2 — Lógica principal

1. Expandir command, domínio e payload hash para `WIN`, `LOSS` e referência opcional.
2. Implementar resolução e validação de referência por provider/transação externa.
3. Implementar `WIN` com crédito, optimistic locking, ledger `CREDIT` e eventos Outbox.
4. Implementar `LOSS` como transação processada sem saldo ou ledger, com evento Outbox.
5. Implementar `PENDING_REFERENCE`, evento Outbox, backoff, TTL e expiração auditável.
6. Reutilizar replay, conflitos, unicidade e retry sem duplicar efeitos.
7. Adicionar logs estruturados para crédito, LOSS, pendência, expiração, replay, conflito e enfileiramento Outbox.

### Fase 3 — Interface

1. Atualizar DTO e validações para `WIN`, `LOSS` e referência opcional.
2. Atualizar controller/presenter para `201`, `200`, `202`, `400`, `404`, `409`, `422` e `503`.
3. Registrar o worker/reprocessador de referências pendentes usando estado persistido; o publisher externo da Outbox fica adiado junto com SQS.

### Fase 4 — Testes

1. Testar domínio, crédito, LOSS, referência, estados e hash.
2. Testar migration, constraints, Outbox, atomicidade e rollback em PostgreSQL real.
3. Testar contrato HTTP, replay, conflitos e `202 PENDING_REFERENCE`.
4. Testar concorrência de créditos, 50 replays e regressão de BET/wallet.
5. Testar backoff, TTL, reprocessamento e expiração sem crédito parcial.

### Fase 5 — Entrega e verificação

1. Executar typecheck, build e suíte completa.
2. Executar ciclo `migration:down/up` e registrar evidências.
3. Preencher checklist Spec ↔ Plano ↔ Código ↔ Testes, incluindo os quatro eventos exigidos e sua atomicidade.
4. Submeter para revisão e aprovação de Marcos.

Não haverá deploy nesta rodada por ausência de Git e de fluxo de deploy configurado.

## 6. Riscos

| Risco | Chance | Impacto | Como mitigar |
|---|---|---|---|
| `Wallet.credit` alterar BET ou permitir moeda incompatível | Média | Muito alto: saldo e ledger incorretos | Método isolado no agregado, testes de moeda/saldo/version e regressão completa |
| LOSS criar ledger ou alterar version por compartilhar fluxo com WIN | Média | Alto: efeito financeiro indevido | Branch explícito no caso de uso, teste de saldo/version/ledger antes e depois |
| Referência externa resolver transação de outro player/wallet/rodada | Média | Muito alto: crédito indevido | Consulta por provider, validações de compatibilidade e testes negativos |
| `PENDING_REFERENCE` ser reprocessada mais de uma vez | Média | Muito alto: crédito duplicado | Idempotência persistente, estado terminal, mesma transação original e concorrência real |
| TTL ser reiniciado em redelivery ou retry | Média | Alto: pendência eterna e diagnóstico incorreto | Persistir primeiro instante, limitar agenda ao TTL e testar expiração |
| Outbox ser gravada fora da transação financeira | Média | Muito alto: evento perdido ou inconsistente | Usar a mesma Unit of Work, testar rollback e não publicar diretamente no controller |
| Migration divergir da entidade ou impedir rollback | Baixa | Alto: indisponibilidade e perda de compatibilidade | Migration nova, checks explícitos, ciclo up/down/up em PostgreSQL real |
| Resposta de LOSS devolver saldo não determinístico | Média | Médio: replay inconsistente | Persistir snapshot de saldo inalterado e testar replay após outra operação |

## 7. Decisões incorporadas

- A Outbox transacional mínima faz parte desta feature porque o README exige atomicidade entre transação, saldo, ledger e evento de integração.
- `WagerTransactionPendingReference` será enfileirado ao persistir uma pendência.
- `WagerTransactionRejected` será enfileirado atomicamente na expiração ou em rejeições de negócio desta feature.
- `WagerTransactionProcessed` será enfileirado para `WIN` e `LOSS` processadas.
- `WalletBalanceChanged` será enfileirado somente para `WIN`, quando o saldo mudar.
- A publicação externa por SQS, Inbox, DLQ e redelivery permanece fora desta rodada.
- O worker de referências pendentes usará os campos persistidos de agenda, tentativas e `pending_since`; não haverá scheduler apenas em memória.

As demais decisões funcionais da Spec foram respondidas e registradas. A implementação foi verificada e aprovada por Marcos em 2026-10-16; não há deploy nesta rodada.
