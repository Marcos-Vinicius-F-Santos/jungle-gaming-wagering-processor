# Spec da Feature — Processar REFUND e ROLLBACK

Status: Rascunho — aguardando revisão e aprovação
Projeto: Distributed Wagering Processor
Onde vive no código: `src/modules/wagering/`, portas/adapters de wallet, ledger, persistência, Outbox e HTTP
Spec do produto: [`../../01-produto/spec.md`](../../01-produto/spec.md)
Arquitetura: [`../../02-arquitetura/arquitetura.md`](../../02-arquitetura/arquitetura.md)
Feature anterior: [`../03-processar-win-loss/spec.md`](../03-processar-win-loss/spec.md)

## 1. Objetivo

Adicionar o processamento síncrono das operações `REFUND` e `ROLLBACK` ao mesmo caso de uso financeiro que já processa `BET`, `WIN` e `LOSS`.

`REFUND` deve reverter integralmente uma `BET` processada, creditando a wallet uma única vez. `ROLLBACK` deve aplicar a inversão da operação processada referenciada, também uma única vez, preservando saldo, ledger, idempotência, concorrência e rastreabilidade.

As operações devem continuar atômicas no PostgreSQL. A transação, a alteração da wallet, o lançamento imutável do ledger e os eventos da Outbox devem confirmar ou reverter juntos. A publicação externa por SQS, Inbox, DLQ e redelivery permanece fora desta fatia, conforme as features anteriores.

## 2. Como funciona hoje

O endpoint `POST /wagering/transactions` aceita `BET`, `WIN` e `LOSS` e chama o caso de uso único `ProcessWagerTransaction`. O fluxo atual valida wallet, player, moeda, valor, identificador externo e `Idempotency-Key`, calcula `payloadHash` com JSON canônico, usa optimistic locking com três tentativas totais e persiste a transação, o saldo, o ledger quando aplicável e a Outbox na mesma transação SQL.

`BET` gera `DEBIT`, `WIN` gera `CREDIT`, e `LOSS` permanece auditável sem alterar saldo, versão ou ledger. `WIN` já pode aguardar uma referência ausente como `PENDING_REFERENCE`, usando TTL de 15 minutos e o worker persistente de reprocessamento.

Esta feature amplia os kinds aceitos pelo mesmo endpoint e caso de uso. A criação/consulta de wallet, `BET`, `WIN` e `LOSS` existentes devem preservar seu comportamento.

## 3. Requisitos funcionais

### FR-001 — Submeter REFUND ou ROLLBACK

QUANDO o cliente enviar `POST /wagering/transactions` com `Idempotency-Key`, provider, transação externa, player, wallet, rodada, jogo, dinheiro e `kind` igual a `REFUND` ou `ROLLBACK`

O SISTEMA DEVE aceitar a operação para processamento síncrono pelo mesmo caso de uso financeiro de wagering, exigindo `referenceExternalTransactionId`.

### FR-002 — Processar REFUND de BET

QUANDO um `REFUND` possuir uma referência válida para uma `BET` `PROCESSED`, compatível com provider, player, wallet, moeda, rodada e valor

O SISTEMA DEVE persistir o `REFUND` como `PROCESSED`, creditar integralmente a wallet, incrementar sua `version` uma vez, criar exatamente um lançamento `CREDIT` balanceado e enfileirar os eventos exigidos na Outbox, na mesma transação SQL.

### FR-003 — Processar ROLLBACK da transação referenciada

QUANDO um `ROLLBACK` possuir uma referência válida para uma transação `BET`, `WIN` ou `REFUND` `PROCESSED`, compatível com provider, player, wallet, moeda, rodada e valor

O SISTEMA DEVE aplicar a direção inversa da transação referenciada, persistir o `ROLLBACK` como `PROCESSED`, criar exatamente um lançamento correspondente no ledger e enfileirar os eventos exigidos na Outbox, na mesma transação SQL.

Para a direção da inversão:

- referência `BET` (`DEBIT`) → `ROLLBACK` gera `CREDIT`;
- referência `WIN` (`CREDIT`) → `ROLLBACK` gera `DEBIT`;
- referência `REFUND` (`CREDIT`) → `ROLLBACK` gera `DEBIT`.

### FR-004 — Rejeitar referência incompatível

QUANDO a referência não existir, não estiver `PROCESSED`, for de outro provider, player, wallet, moeda, rodada, kind permitido ou possuir valor diferente

O SISTEMA DEVE rejeitar ou manter a operação pendente conforme a referência esteja incompatível ou ausente, sem alterar saldo e sem criar lançamento indevido no ledger.

Uma referência incompatível disponível deve resultar em rejeição de negócio auditável. Uma referência ainda ausente deve seguir FR-005.

### FR-005 — Persistir referência fora de ordem

QUANDO um `REFUND` ou `ROLLBACK` possuir uma referência externa ainda não disponível

O SISTEMA DEVE persistir a operação como `PENDING_REFERENCE`, enfileirar `WagerTransactionPendingReference` na Outbox e disponibilizá-la para reprocessamento posterior, sem aplicar efeito financeiro.

O worker deve usar o mesmo caso de uso e a mesma operação persistida, sem criar uma nova transação financeira.

### FR-006 — Expirar pendência

QUANDO uma operação `PENDING_REFERENCE` exceder o TTL de 15 minutos desde a primeira pendência

O SISTEMA DEVE torná-la `REJECTED` com `failureCode = REFERENCE_NOT_FOUND`, enfileirar `WagerTransactionRejected` na Outbox e manter a operação, sem alterar saldo ou ledger.

### FR-007 — Impedir reversão duplicada

QUANDO uma nova operação tentar reverter novamente a mesma transação com o mesmo tipo de reversão

O SISTEMA DEVE rejeitar o conflito sem novo efeito financeiro, preservando a transação de reversão original, o saldo e o ledger.

O replay da mesma operação, com a mesma `Idempotency-Key` e payload de negócio, deve retornar o resultado persistido originalmente sem criar uma segunda reversão.

### FR-008 — Rejeitar conflito de idempotência ou transação externa

QUANDO uma requisição reutilizar uma `Idempotency-Key` ou um identificador externo existente com payload de negócio diferente

O SISTEMA DEVE retornar conflito explícito sem alterar a operação original, o saldo ou o ledger.

### FR-009 — Rejeitar rollback que produziria saldo negativo

QUANDO a inversão de uma referência `CREDIT` não puder ser aplicada porque produziria saldo negativo

O SISTEMA DEVE rejeitar a operação com `failureCode = REVERSAL_NEGATIVE_BALANCE`, persistir a rejeição de forma auditável, enfileirar `WagerTransactionRejected` e não alterar saldo, versão ou ledger.

### FR-010 — Proteger concorrência de reversões

QUANDO duas ou mais operações de `REFUND` ou `ROLLBACK` disputarem a mesma wallet simultaneamente

O SISTEMA DEVE usar optimistic locking condicionado pela versão anterior e até três tentativas totais, sem lost update, crédito/débito duplicado ou mais de um ledger para a mesma operação.

### FR-011 — Manter rastreabilidade e eventos

QUANDO uma operação de `REFUND` ou `ROLLBACK` for processada, rejeitada ou ficar pendente

O SISTEMA DEVE manter uma `WagerTransaction` auditável com referência externa e interna quando resolvida, provider, identificador externo, idempotency key, payload hash, wallet, player, rodada, jogo, valor, moeda, kind, status e `failureCode` quando aplicável.

Os eventos devem ser persistidos na Outbox transacional:

- `WagerTransactionProcessed` para reversões processadas;
- `WagerTransactionRejected` para rejeições de negócio;
- `WagerTransactionPendingReference` para referências ausentes;
- `WalletBalanceChanged` sempre que `REFUND` ou `ROLLBACK` alterar o saldo.

## 4. Regras de negócio

### BR-001 — Kinds e referências permitidos

- `REFUND` exige referência externa e só pode referenciar uma `BET` `PROCESSED`.
- `ROLLBACK` exige referência externa e pode referenciar uma `BET`, `WIN` ou `REFUND` `PROCESSED`.
- `OPENING` continua interno e não pode ser submetido pela API.
- `BET`, `WIN` e `LOSS` continuam aceitos conforme as features anteriores.
- `REFUND` e `ROLLBACK` não podem referenciar `LOSS`, `OPENING`, `REJECTED`, `FAILED` ou outra operação pendente.

### BR-002 — Compatibilidade da referência

A referência é resolvida por `(providerId, referenceExternalTransactionId)` e deve pertencer ao mesmo provider, player, wallet, moeda e rodada da operação de reversão.

O valor da reversão deve ser exatamente igual ao valor da transação referenciada. Reversão parcial está fora de escopo.

### BR-003 — Direção e valor do ledger

`REFUND` gera sempre `CREDIT` com `balanceAfter = balanceBefore + money`.

`ROLLBACK` gera a direção inversa da referência. O lançamento deve preservar `balanceBefore ± money = balanceAfter`, moeda igual à wallet e saldo não negativo.

### BR-004 — Reversão única

Uma referência não pode ser revertida duas vezes pelo mesmo tipo de operação. A proteção deve ser persistente e funcionar com múltiplas instâncias concorrentes.

O replay idêntico deve devolver o snapshot originalmente persistido. O conflito de payload não pode produzir qualquer efeito financeiro.

### BR-005 — Estados terminais

`PROCESSED`, `REJECTED` e `FAILED` são terminais. Uma reversão terminal não pode ser reaplicada como novo efeito financeiro.

### BR-006 — Idempotência e precisão

O header `Idempotency-Key` é obrigatório. O `payloadHash` deve ser SHA-256 de JSON canônico ordenado contendo somente campos de negócio, incluindo `kind`, valor e `referenceExternalTransactionId`.

Valores são strings decimais positivas com até duas casas, moeda ISO-4217 normalizada para maiúsculas e persistida em `NUMERIC(19,2)` com coluna de moeda separada.

### BR-007 — Pendência e TTL

Referências ausentes seguem backoff de `30s`, `1m`, `2m`, `4m` e `7m`, sem agendar além do TTL total de 15 minutos desde a primeira persistência como `PENDING_REFERENCE`. Redelivery não reinicia o TTL.

### BR-008 — Atomicidade

A operação de reversão, a atualização da wallet, o ledger quando aplicável, a mudança de estado e os eventos da Outbox devem confirmar ou reverter juntos na mesma transação SQL.

## 5. Contrato HTTP

### Submeter REFUND

```http
POST /wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-a:refund-456
```

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "refund-456",
  "referenceExternalTransactionId": "bet-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "REFUND",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

### Submeter ROLLBACK

O contrato é o mesmo, com `kind = "ROLLBACK"` e a referência externa da transação processada que será invertida.

O endpoint permanece síncrono e reutiliza o mapeamento aprovado para wagering:

- `201 Created`: reversão processada inicialmente;
- `200 OK`: replay idempotente;
- `202 Accepted`: referência ausente persistida como `PENDING_REFERENCE`;
- `400 Bad Request`: payload inválido, referência ausente no contrato ou dinheiro inválido;
- `404 Not Found`: wallet inexistente, sem persistir a transação financeira;
- `409 Conflict`: conflito de idempotência, transação externa ou reversão duplicada;
- `422 Unprocessable Content`: referência incompatível, rejeição de negócio ou saldo negativo na inversão;
- `503 Service Unavailable`: falha transitória ou esgotamento dos retries de optimistic locking.

A resposta inicial deve incluir `transactionId`, `status`, snapshot de saldo e `idempotentReplay: false`. O replay deve devolver o mesmo snapshot com `idempotentReplay: true`.

## 6. Critério de aceite

### AC-001 — REFUND processado

Dado um saldo de `100.00 BRL`, uma `BET` processada de `25.00 BRL` e saldo atual de `75.00 BRL`, quando o cliente enviar um `REFUND` válido de `25.00 BRL`, então o sistema deve retornar `201`, persistir o `REFUND` como `PROCESSED`, retornar saldo `100.00 BRL`, avançar a versão uma vez e criar exatamente um `CREDIT` balanceado.

### AC-002 — ROLLBACK de WIN processado

Dado um `WIN` processado de `80.00 BRL` que elevou o saldo de `100.00 BRL` para `180.00 BRL`, quando o cliente enviar um `ROLLBACK` válido referenciando essa WIN, então o sistema deve retornar `201`, persistir o rollback como `PROCESSED`, retornar saldo `100.00 BRL`, criar exatamente um `DEBIT` e manter a consistência do ledger.

### AC-003 — Replay sem nova reversão

Dado que um `REFUND` ou `ROLLBACK` foi processado com uma `Idempotency-Key` e payload específicos, quando o cliente repetir a mesma requisição, então o sistema deve retornar `200`, o resultado original e `idempotentReplay = true`, sem nova alteração de saldo, versão ou ledger.

### AC-004 — Referência ausente

Dado um `REFUND` ou `ROLLBACK` cuja referência ainda não exista, quando o cliente enviar a operação, então o sistema deve retornar `202`, persistir `PENDING_REFERENCE`, enfileirar `WagerTransactionPendingReference` e não alterar saldo ou ledger.

### AC-005 — Referência incompatível

Dado um `REFUND` que referencia uma `WIN`, ou uma reversão cuja referência pertença a outro player, wallet, provider, moeda, rodada ou valor, quando o cliente enviar a operação, então o sistema deve retornar `422`, persistir a rejeição auditável, enfileirar `WagerTransactionRejected` e não alterar saldo ou ledger.

### AC-006 — Rollback com saldo insuficiente

Dado um `ROLLBACK` de uma operação `CREDIT` cujo débito inverso produziria saldo negativo, quando o cliente enviar a operação, então o sistema deve retornar `422` com `failureCode = REVERSAL_NEGATIVE_BALANCE`, sem alterar saldo, versão ou ledger.

### AC-007 — Reversão duplicada

Dado que uma referência já recebeu um `REFUND` ou `ROLLBACK` do mesmo tipo, quando outra operação tentar revertê-la novamente, então o sistema deve retornar `409` e manter inalterados o saldo, o ledger e a reversão original.

### AC-008 — Concorrência de reversões

Dado um saldo e duas reversões válidas concorrentes sobre a mesma wallet, quando ambas forem processadas simultaneamente, então optimistic locking deve impedir lost update, cada operação deve ter no máximo um efeito financeiro e o saldo final deve ser igual ao saldo reconstruído pelo ledger.

## 7. Casos de erro e edge cases

- `REFUND` sem `referenceExternalTransactionId` → `400` antes de qualquer escrita financeira.
- `ROLLBACK` sem `referenceExternalTransactionId` → `400` antes de qualquer escrita financeira.
- referência ausente → `202` e `PENDING_REFERENCE`, sem crédito ou débito parcial.
- referência incompatível → `422`, sem saldo ou ledger.
- `REFUND` de `WIN`, `LOSS`, `REFUND`, `ROLLBACK`, `OPENING` ou operação não terminal → `422`.
- `ROLLBACK` de `LOSS`, `OPENING`, `ROLLBACK`, operação rejeitada ou operação falha → `422`.
- valor diferente do valor da referência → `422`.
- player, wallet, moeda, provider ou rodada incompatíveis → `422`.
- wallet inexistente → `404`, sem persistir `WagerTransaction`.
- `ROLLBACK` que produziria saldo negativo → `422/REVERSAL_NEGATIVE_BALANCE`, sem efeito financeiro.
- mesma reversão repetida com payload idêntico → replay se a mesma idempotency key for usada; conflito de reversão se for uma nova operação do mesmo tipo.
- mesma key ou identificador externo com payload diferente → `409`.
- conflito de optimistic locking → até três tentativas totais; ao esgotar, `503` sem efeito duplicado.
- falha entre transação, wallet, ledger e Outbox → rollback integral.
- falha depois do commit antes da resposta → repetição idempotente retorna o resultado já persistido.
- múltiplas instâncias tentando reverter a mesma referência → no máximo uma reversão do mesmo tipo produz efeito.

## 8. Fora de escopo desta feature

- SQS, Inbox, DLQ e redelivery de mensagens.
- Publicação externa da Outbox; os eventos são apenas persistidos transacionalmente nesta rodada.
- Reversão parcial.
- Double-entry bookkeeping.
- Consulta pública nova de transações ou ledger paginado.
- Reconciliação.
- Autenticação.
- Teste de carga com três instâncias.
- Deploy e rollback de aplicação; não há Git nem fluxo de deploy configurado.
- Alteração dos contratos de criação/consulta de wallets ou regressão de `BET`, `WIN` e `LOSS`.

## 9. Suposições e perguntas abertas

- [x] A próxima feature foi interpretada como a fatia vertical síncrona de `REFUND` e `ROLLBACK`, após `BET`, `WIN` e `LOSS`, conforme o roadmap do produto.
- [x] As operações reutilizarão `ProcessWagerTransaction`, sem criar um fluxo financeiro paralelo.
- [x] `REFUND` exige uma `BET` `PROCESSED`; `ROLLBACK` aceita `BET`, `WIN` ou `REFUND` `PROCESSED`, conforme o README.
- [x] As reversões usam o valor integral da referência; reversão parcial permanece fora de escopo.
- [x] A referência externa será resolvida pelo mesmo provider e será validada contra player, wallet, moeda, rodada e valor.
- [x] Referências ausentes usarão `PENDING_REFERENCE`, backoff aprovado e TTL total de 15 minutos.
- [x] O fluxo continuará HTTP síncrono, com `201`, `200`, `202`, `400`, `404`, `409`, `422` e `503` conforme o contrato existente.
- [x] Money, `NUMERIC(19,2)`, moeda ISO normalizada, UUID v7, optimistic locking com três tentativas, ledger imutável e Outbox transacional seguem as decisões globais aprovadas.
- [x] Uma referência só pode receber uma reversão direta, independentemente de ser `REFUND` ou `ROLLBACK`; essa decisão impede dupla compensação da mesma operação. Um `ROLLBACK` de um `REFUND` continua permitido porque referencia a transação `REFUND`, e não diretamente a operação original.
- [x] `ROLLBACK` de `REFUND` é permitido como inversão integral da própria reversão, porque o README lista explicitamente `REFUND` entre as referências possíveis de `ROLLBACK`; portanto gera a direção inversa da referência, sem reversão parcial.

As perguntas abertas foram registradas e respondidas com fundamento no README e em decisões técnicas explícitas. A criação do plano, tarefas e qualquer implementação ainda deve aguardar a revisão e aprovação formal desta Spec.

## 10. Definition of Done desta feature

- [ ] Esta Spec foi revisada e aprovada.
- [x] O escopo de `REFUND`, `ROLLBACK`, referências válidas e reversão integral foi documentado a partir do README.
- [ ] O DTO aceita `REFUND` e `ROLLBACK` somente com referência externa válida.
- [ ] `REFUND` reverte uma `BET` com um `CREDIT` atômico.
- [ ] `ROLLBACK` aplica a direção inversa de `BET`, `WIN` ou `REFUND`.
- [ ] Referências incompatíveis e reversões com saldo negativo são rejeitadas sem efeito financeiro.
- [ ] Reversão duplicada, replay e conflito de payload são protegidos persistentemente.
- [ ] Referências ausentes usam pendência, backoff, TTL e expiração auditável.
- [ ] Wallet, reversão, ledger e Outbox são atômicos.
- [ ] Optimistic locking e concorrência real são testados.
- [ ] A regressão de wallet, `BET`, `WIN` e `LOSS` passa.
- [ ] Eu revisei e aprovei antes de criar o plano e iniciar a implementação.
