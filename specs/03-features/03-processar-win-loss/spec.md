# Spec da Feature — Processar WIN e LOSS

Status: Rascunho — aguardando revisão e aprovação
Projeto: Distributed Wagering Processor
Onde vive no código: `src/modules/wagering/`, portas/adapters de wallet, persistência e HTTP
Spec do produto: [`../../01-produto/spec.md`](../../01-produto/spec.md)
Arquitetura: [`../../02-arquitetura/arquitetura.md`](../../02-arquitetura/arquitetura.md)
Feature anterior: [`../02-processar-bet/spec.md`](../02-processar-bet/spec.md)

## 1. Objetivo

Adicionar o processamento síncrono das operações `WIN` e `LOSS` ao mesmo fluxo de transações já usado por `BET`. `WIN` deve creditar a wallet de forma atômica e auditável; `LOSS` deve registrar o resultado sem alterar saldo ou ledger.

Esta é a próxima fatia vertical porque amplia o conjunto de resultados de uma rodada sem introduzir ainda reversões (`REFUND`/`ROLLBACK`), SQS ou Inbox. Os eventos desta operação devem ser enfileirados na Outbox transacional mínima exigida pelo README.

## 2. Como funciona hoje

O endpoint `POST /wagering/transactions` aceita somente `kind = BET`. O caso de uso `ProcessWagerTransaction` valida a wallet, calcula o hash canônico, aplica idempotência, usa optimistic locking com três tentativas totais e, quando a operação é processada, altera saldo e cria um lançamento `DEBIT` no ledger.

`WagerTransaction` já possui os kinds `WIN` e `LOSS` no domínio e conhece `CREDIT` para `WIN`, mas o DTO e o caso de uso ainda não permitem processá-los pelo HTTP. A criação/consulta de wallet e o processamento de `BET` existentes não devem perder comportamento.

## 3. Requisitos funcionais

### FR-001 — Submeter WIN ou LOSS

QUANDO o cliente enviar `POST /wagering/transactions` com `Idempotency-Key`, provider, transação externa, player, wallet, rodada, jogo, dinheiro e `kind` igual a `WIN` ou `LOSS`

O SISTEMA DEVE aceitar a operação para processamento síncrono pelo mesmo caso de uso financeiro de wagering.

### FR-002 — Processar WIN com crédito

QUANDO uma operação `WIN` for válida, a wallet existir e todas as regras de referência aplicáveis forem satisfeitas

O SISTEMA DEVE persistir a `WagerTransaction` como `PROCESSED`, creditar a wallet, incrementar sua `version`, criar exatamente um lançamento `CREDIT` no ledger e enfileirar os eventos exigidos na Outbox, dentro da mesma transação SQL.

### FR-003 — Processar LOSS sem efeito financeiro

QUANDO uma operação `LOSS` for válida

O SISTEMA DEVE persistir a `WagerTransaction` como `PROCESSED`, enfileirar `WagerTransactionProcessed` na Outbox e não alterar saldo, não incrementar a `version` da wallet nem criar lançamento no ledger.

### FR-004 — Preservar precisão e invariantes

QUANDO `WIN` alterar o saldo

O SISTEMA DEVE usar `Money` decimal exato, moeda explícita, `NUMERIC(19,2)` no banco e manter `balanceBefore + money = balanceAfter`.

### FR-005 — Validar wallet e operação

QUANDO player, wallet, moeda, valor, provider, identificador externo, rodada, jogo ou `Idempotency-Key` forem inválidos ou incompatíveis com a wallet persistida

O SISTEMA DEVE rejeitar a operação sem alteração financeira e sem lançamento indevido no ledger, usando os contratos de validação e status HTTP aprovados para wagering.

### FR-006 — Validar referência de WIN quando informada

QUANDO uma operação `WIN` possuir uma referência de transação externa que ainda não esteja disponível

O SISTEMA DEVE persistir a operação como `PENDING_REFERENCE`, enfileirar `WagerTransactionPendingReference` na Outbox e disponibilizá-la para reprocessamento posterior, sem aplicar crédito enquanto a referência não puder ser validada.

QUANDO uma operação `WIN` possuir uma referência de transação externa disponível

O SISTEMA DEVE localizar a transação referenciada e rejeitar a operação se ela não puder ser validada como uma operação compatível com provider, player, wallet, moeda e rodada.

QUANDO uma operação `PENDING_REFERENCE` exceder o TTL

O SISTEMA DEVE torná-la `REJECTED` com `failureCode = REFERENCE_NOT_FOUND` e enfileirar `WagerTransactionRejected` na Outbox, na mesma transação SQL da mudança de estado.

### FR-007 — Garantir idempotent replay

QUANDO uma requisição repetir uma `Idempotency-Key` já processada com o mesmo payload de negócio

O SISTEMA DEVE retornar o resultado persistido originalmente, com `idempotentReplay = true`, sem novo crédito, alteração de saldo, alteração de versão ou lançamento de ledger.

### FR-008 — Rejeitar conflito de payload

QUANDO uma requisição reutilizar uma `Idempotency-Key` ou uma transação externa existente com payload de negócio diferente

O SISTEMA DEVE retornar conflito explícito sem alterar a transação original, o saldo ou o ledger.

### FR-009 — Proteger concorrência de WIN

QUANDO duas ou mais operações `WIN` disputarem a mesma wallet simultaneamente

O SISTEMA DEVE usar optimistic locking condicionado pela versão anterior e até três tentativas totais, sem lost update ou crédito duplicado.

### FR-010 — Manter rastreabilidade

QUANDO uma operação `WIN` ou `LOSS` for processada ou rejeitada por regra de negócio

O SISTEMA DEVE manter uma `WagerTransaction` auditável com provider, identificador externo, idempotency key, payload hash, wallet, player, rodada, jogo, valor, moeda, kind, status e `failureCode` quando aplicável.

Os eventos `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference` e, somente quando o saldo mudar, `WalletBalanceChanged` DEVEM ser persistidos na Outbox transacional junto com a operação correspondente. A publicação para SQS permanece fora desta feature.

## 4. Regras de negócio

### BR-001 — Kinds permitidos

Esta feature aceita `WIN` e `LOSS`. `BET` continua aceito pela feature anterior; `OPENING` continua sendo interno. `REFUND` e `ROLLBACK` permanecem fora desta rodada.

### BR-002 — Valor monetário

O valor deve ser recebido como string decimal positiva, com no máximo duas casas, moeda ISO-4217 em coluna separada e precisão exata. A moeda deve ser normalizada para maiúsculas na camada HTTP.

### BR-003 — Compatibilidade com wallet

`playerId`, `walletId` e `currency` da operação devem corresponder à wallet persistida. Wallet inexistente continua retornando `404` sem persistir uma `WagerTransaction`, preservando a FK obrigatória.

### BR-004 — Crédito de WIN

Uma `WIN` `PROCESSED` gera exatamente um `CREDIT` com `balanceBefore = saldo anterior` e `balanceAfter = saldo anterior + valor`. A wallet deve avançar sua `version` somente uma vez.

### BR-005 — LOSS sem movimentação

Uma `LOSS` `PROCESSED` não altera saldo, não incrementa a `version` da wallet e não gera lançamento de ledger. A transação permanece auditável.

### BR-006 — Idempotência

O header `Idempotency-Key` é obrigatório. O `payloadHash` deve ser SHA-256 de JSON canônico ordenado contendo somente campos de negócio, incluindo `kind` e qualquer referência efetivamente definida para esta operação.

### BR-007 — Resultado de replay

O replay deve retornar o snapshot do resultado persistido originalmente. Para `WIN`, o snapshot contém o saldo após o crédito; para `LOSS`, o resultado deve deixar claro que não houve alteração de saldo.

### BR-008 — Referência de WIN

Quando uma referência for utilizada, ela deve ser resolvida por `(providerId, referenceExternalTransactionId)`, pertencer ao mesmo provider, player, wallet, moeda e rodada e representar uma `BET` compatível. A referência é opcional para `WIN`.

### BR-009 — Referência fora de ordem

Quando uma referência de `WIN` ainda não existir, a operação deve permanecer como `PENDING_REFERENCE`, sem crédito ou ledger, e ser reprocessada com backoff de `30s`, `1m`, `2m`, `4m` e `7m`, sem ultrapassar o TTL total de 15 minutos desde a primeira pendência. Ao expirar, deve tornar-se `REJECTED` com `failureCode = REFERENCE_NOT_FOUND`.

### BR-010 — Estados terminais

`PROCESSED`, `REJECTED` e `FAILED` são terminais. Uma transação terminal não pode ser reaplicada como novo efeito financeiro.

### BR-011 — Eventos e Outbox

- Toda operação processada, inclusive `LOSS`, gera `WagerTransactionProcessed` na Outbox.
- Toda rejeição de negócio gera `WagerTransactionRejected` na Outbox.
- `WIN` processada gera `WalletBalanceChanged` porque altera saldo; `LOSS` não gera esse evento.
- Uma referência ausente gera `WagerTransactionPendingReference`.
- A operação financeira, o ledger quando aplicável e os registros da Outbox devem confirmar ou reverter juntos na mesma transação SQL.
- A Outbox é persistida nesta feature; SQS, Inbox, DLQ e redelivery continuam adiados.

## 5. Contrato HTTP

### Submeter WIN ou LOSS

```http
POST /wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-a:transaction-456
```

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-456",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "WIN",
  "money": { "amount": "80.00", "currency": "BRL" }
}
```

O endpoint permanece síncrono e reutiliza o mapeamento de transporte aprovado para wagering:

- `201 Created`: processamento inicial de `WIN` ou `LOSS`;
- `200 OK`: replay idempotente;
- `400 Bad Request`: payload inválido;
- `404 Not Found`: wallet inexistente;
- `409 Conflict`: conflito de idempotência ou transação externa;
- `422 Unprocessable Content`: rejeição de negócio ou referência inválida, conforme decisão final;
- `202 Accepted`: `WIN` persistida como `PENDING_REFERENCE`, com evento de pendência enfileirado na Outbox e aguardando reprocessamento;
- `503 Service Unavailable`: falha transitória ou esgotamento dos retries de optimistic locking.

Para `LOSS`, a resposta inclui um snapshot do saldo inalterado. O mesmo snapshot é devolvido em replay para manter o resultado determinístico.

## 6. Critério de aceite

### AC-001 — WIN processada

Dado um player com wallet `100.00 BRL`, `version = 1` e uma referência de rodada válida, quando o cliente enviar uma `WIN` de `80.00 BRL` com `Idempotency-Key` nova, então o sistema deve retornar processamento inicial bem-sucedido, persistir a transação como `PROCESSED`, retornar saldo `180.00 BRL`, incrementar a versão para `2` e criar exatamente um `CREDIT` no ledger.

### AC-002 — LOSS processada sem efeito financeiro

Dado um player com wallet `100.00 BRL` e `version = 1`, quando o cliente enviar uma `LOSS` válida com `Idempotency-Key` nova, então o sistema deve retornar processamento inicial bem-sucedido, persistir a transação como `PROCESSED`, manter saldo `100.00 BRL`, manter a versão `1` e não criar lançamento no ledger.

### AC-003 — replay idempotente

Dado que uma `WIN` ou `LOSS` foi processada com uma `Idempotency-Key` e payload específicos, quando o cliente repetir a mesma requisição, então o sistema deve retornar `200`, o mesmo resultado persistido e `idempotentReplay = true`, sem novo efeito financeiro.

### AC-004 — referência ausente ou incompatível

Dado uma `WIN` com referência ainda inexistente, quando o cliente enviar a operação, então o sistema deve retornar `202`, persistir `PENDING_REFERENCE` e não alterar saldo nem criar lançamento de ledger.

Dado uma `WIN` com referência incompatível, quando o cliente enviar a operação, então o sistema deve rejeitá-la com `422`, sem alterar saldo e sem criar lançamento de ledger.

### AC-005 — conflito de payload

Dado que uma `WIN` ou `LOSS` já foi processada com uma `Idempotency-Key`, quando o cliente reutilizar a mesma key com payload diferente, então o sistema deve retornar `409` e manter inalterados a transação original, o saldo e o ledger.

### AC-006 — concorrência de créditos

Dado um saldo inicial de `100.00 BRL` e duas `WIN`s válidas concorrentes de `80.00 BRL`, quando ambas forem processadas simultaneamente, então o saldo final deve ser `260.00 BRL`, a versão deve avançar duas vezes, cada transação deve ser processada uma vez e devem existir dois lançamentos `CREDIT`.

## 7. Casos de erro / edge cases

- `kind` diferente de `WIN` ou `LOSS` nesta nova fatia → manter o comportamento definido pela feature anterior e rejeitar como operação não suportada no contrato correspondente.
- `Idempotency-Key` ausente, vazia ou inválida → `400` antes de qualquer escrita.
- amount como número JSON, vazio, negativo, científico ou com mais de duas casas → `400` sem escrita financeira.
- player, wallet ou moeda incompatível → rejeição de negócio sem alteração de saldo ou ledger.
- wallet inexistente → `404` sem persistir `WagerTransaction`, saldo ou ledger.
- `WIN` sem referência → pode ser processada normalmente, pois a referência é opcional.
- `WIN` com referência ausente → persistir `PENDING_REFERENCE`, reprocessar com backoff de `30s`, `1m`, `2m`, `4m` e `7m`, respeitando TTL total de 15 minutos; ao expirar, rejeitar com `REFERENCE_NOT_FOUND`.
- `WIN` com referência incompatível → `422`, sem crédito e sem ledger.
- `LOSS` repetida com mesmo payload → replay sem novo registro financeiro.
- Uma mesma BET pode receber múltiplas `WIN`s ou `LOSS`s; não há nova unicidade de resultado além das chaves de idempotência e transação externa.
- mesmo identificador externo com payload diferente → `409` sem novo efeito.
- conflito de versão em `WIN` → recarregar e repetir até três tentativas totais; ao esgotar, `503` sem crédito duplicado.
- falha entre persistência da transação, atualização da wallet, ledger e Outbox → rollback integral.
- falha depois do commit antes da resposta → repetição idempotente deve retornar o resultado já persistido.

## 8. Fora de escopo desta feature

- `REFUND` e `ROLLBACK`.
- SQS, Inbox, DLQ e redelivery.
- Publicação dos eventos por SQS ou outro broker externo; os eventos devem ser apenas persistidos na Outbox nesta rodada.
- Consulta pública de transações e ledger paginado.
- Reconciliação.
- Autenticação.
- Teste de carga com três instâncias.
- Alteração dos contratos de criação e consulta de wallets ou do processamento de `BET` já aprovado.

## 9. Suposições e perguntas abertas

- [x] A próxima feature foi interpretada como a fatia vertical de `WIN` e `LOSS` síncronos por HTTP, conforme a ordem recomendada a partir da Spec do Produto.
- [x] O endpoint e o caso de uso de wagering existentes serão reutilizados, sem criar um fluxo financeiro paralelo.
- [x] As decisões já aprovadas de Money, moeda, idempotência, optimistic locking, três tentativas totais e wallet inexistente continuam válidas.
- [x] `WIN` não exige `referenceExternalTransactionId`; a referência é opcional.
- [x] `LOSS` não exige referência e pode ser processada sem referência.
- [x] Referência de `WIN` ausente deve gerar `PENDING_REFERENCE`, com reprocessamento, TTL total de 15 minutos e `REFERENCE_NOT_FOUND` ao expirar.
- [x] A referência de `WIN` deve pertencer ao mesmo provider, player, wallet, moeda e rodada.
- [x] Uma mesma `BET` pode receber múltiplas `WIN`s ou `LOSS`s; não será criada uma restrição adicional não prevista no README.
- [x] A resposta de `LOSS` inclui snapshot do saldo inalterado, também usado no replay.
- [x] O valor de `WIN` pode ser diferente do valor da `BET`; a igualdade integral é exigida pelo README apenas para `REFUND` e `ROLLBACK`.

Nenhuma pergunta acima foi decidida silenciosamente. A implementação deve aguardar a revisão desta Spec e o fechamento das perguntas que alteram o contrato público ou as regras de referência.

## 10. Definition of Done desta feature

- [ ] Esta Spec foi revisada e aprovada.
- [x] As perguntas de referência, unicidade de resultado e resposta de `LOSS` foram respondidas.
- [ ] O DTO aceita `WIN` e `LOSS` com as validações aprovadas.
- [ ] `WIN` processada persiste transação, wallet e um ledger `CREDIT` na mesma transação SQL.
- [ ] `LOSS` processada permanece auditável sem alterar wallet ou ledger.
- [ ] Replay idêntico de `WIN` e `LOSS` retorna o resultado original sem novo efeito.
- [ ] Conflito de payload não produz efeito financeiro.
- [ ] Referências inválidas não produzem crédito nem ledger.
- [ ] Eventos de processamento, rejeição, pendência e mudança de saldo são enfileirados na Outbox correta e atomicamente.
- [ ] Optimistic locking e retry limitado são testados com concorrência real.
- [ ] Falha intermediária confirma rollback completo, incluindo a Outbox.
- [ ] A regressão das features de wallet e `BET` passa.
- [ ] Eu revisei e aprovei antes de iniciar a próxima fase.
