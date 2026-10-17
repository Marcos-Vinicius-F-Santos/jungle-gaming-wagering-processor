# Spec da Feature — Processar BET com idempotência e optimistic locking

Status: Rascunho — aguardando revisão e aprovação
Projeto: Distributed Wagering Processor
Onde vive no código: `src/modules/wagering/` e portas/adapters de wallet, persistência e HTTP
Spec do produto: [`../../01-produto/spec.md`](../../01-produto/spec.md)
Arquitetura: [`../../02-arquitetura/arquitetura.md`](../../02-arquitetura/arquitetura.md)
Feature anterior: [`../01-criar-consultar-wallet/spec.md`](../01-criar-consultar-wallet/spec.md)

## 1. Objetivo

Processar uma operação `BET` recebida por HTTP, debitando a wallet de forma atômica e auditável. A feature entra agora como a próxima fatia vertical após a criação/consulta de wallet e valida as garantias centrais de idempotência persistente, saldo não negativo e concorrência segura.

## 2. Como funciona hoje

A feature anterior já permite criar e consultar wallets, persistindo saldo, versão, `OPENING` e ledger inicial. Ainda não existe endpoint para submeter uma transação de aposta nem alteração posterior de saldo.

Esta feature adiciona `POST /wagering/transactions` para `kind = BET`; não altera o comportamento dos endpoints de wallet existentes.

## 3. Requisitos funcionais

### FR-001 — Submeter BET

QUANDO o cliente enviar `POST /wagering/transactions` com `Idempotency-Key`, provider, transação externa, player, wallet, rodada, jogo e dinheiro válidos, com `kind = BET`

O SISTEMA DEVE aceitar a operação para processamento síncrono pelo caso de uso financeiro único.

### FR-002 — Validar vínculo da operação

QUANDO a operação identificar um player, wallet ou moeda incompatível com a wallet persistida

O SISTEMA DEVE rejeitar a operação sem alterar saldo e sem criar lançamento de ledger.

### FR-003 — Processar BET com saldo suficiente

QUANDO a wallet existir, os dados forem compatíveis e o saldo for suficiente para o valor da aposta

O SISTEMA DEVE, na mesma transação SQL, persistir a transação como `PROCESSED`, debitar a wallet, incrementar sua `version` e criar exatamente um lançamento `DEBIT` no ledger.

### FR-004 — Rejeitar saldo insuficiente

QUANDO o saldo disponível for menor que o valor da `BET`

O SISTEMA DEVE persistir a transação como `REJECTED`, com `failureCode = INSUFFICIENT_FUNDS`, sem alterar saldo e sem criar lançamento financeiro.

### FR-005 — Garantir atomicidade

QUANDO ocorrer uma falha durante a persistência da transação, alteração da wallet ou criação do ledger

O SISTEMA DEVE desfazer todas as escritas da operação, sem deixar débito parcial, transação financeira órfã ou ledger inconsistente.

### FR-006 — Garantir idempotent replay

QUANDO uma requisição repetir uma `Idempotency-Key` já processada com o mesmo payload de negócio

O SISTEMA DEVE retornar o resultado persistido originalmente, marcar a resposta como `idempotentReplay = true` e não criar novo débito, nova versão ou novo lançamento.

### FR-007 — Rejeitar conflito de idempotência

QUANDO uma requisição usar uma `Idempotency-Key` já persistida com payload de negócio diferente

O SISTEMA DEVE retornar conflito explícito, sem alterar saldo, status da transação original ou ledger.

### FR-008 — Proteger transação externa duplicada

QUANDO já existir uma transação para o mesmo `(providerId, externalTransactionId)`

O SISTEMA DEVE tratar a repetição de forma determinística, sem criar uma segunda operação financeira; caso o payload não corresponda ao registro existente, deve rejeitar como conflito.

### FR-009 — Proteger concorrência por wallet

QUANDO duas ou mais `BET`s válidas disputarem a mesma wallet simultaneamente

O SISTEMA DEVE usar optimistic locking condicionado pela versão anterior e retry limitado, permitindo processamento paralelo de wallets diferentes sem lost update.

### FR-010 — Manter rastreabilidade

QUANDO uma `BET` for processada ou rejeitada por regra de negócio

O SISTEMA DEVE manter uma `WagerTransaction` auditável com provider, identificador externo, idempotency key, payload hash, wallet, player, valor, moeda, status e `failureCode` quando aplicável.

## 4. Regras de negócio

### BR-001 — Operação permitida

Esta feature aceita somente `kind = BET`. `OPENING` é interno e os demais kinds (`WIN`, `LOSS`, `REFUND` e `ROLLBACK`) ficam fora do escopo desta rodada.

### BR-002 — Valor monetário

O valor deve ser string decimal não negativa, com no máximo duas casas, moeda ISO-4217 em coluna separada e precisão exata. Uma `BET` deve ter valor estritamente maior que zero.

### BR-003 — Compatibilidade com wallet

`playerId`, `walletId` e `currency` da operação devem corresponder à wallet persistida. A moeda deve ser normalizada para maiúsculas na camada HTTP antes da validação de domínio.

### BR-004 — Débito e ledger

Uma `BET` `PROCESSED` gera exatamente um `DEBIT` com `balanceBefore = saldo anterior` e `balanceAfter = saldo anterior - valor`. O saldo posterior não pode ser negativo.

### BR-005 — Rejeição auditável

Uma `BET` `REJECTED` permanece persistida, não altera o saldo e não gera lançamento de ledger. `failureCode` deve ser estável e legível por máquina.

### BR-006 — Idempotency-Key

O header `Idempotency-Key` é obrigatório e é a fonte da verdade para replay. O `payloadHash` deve ser SHA-256 de JSON canônico com chaves ordenadas e somente campos de negócio; header e metadados de transporte não entram no hash.

### BR-007 — Resultado de replay

Uma repetição idêntica deve retornar o mesmo resultado financeiro persistido, incluindo saldo observado no processamento original, sem repetir efeitos.

### BR-008 — Concorrência

O update da wallet deve usar a versão carregada, por exemplo `WHERE id = ? AND version = ?`, e considerar conflito quando nenhuma linha for afetada. O retry não pode duplicar o débito nem contornar constraints.

### BR-009 — Estados terminais

`PROCESSED`, `REJECTED` e `FAILED` são terminais. A transação não pode ser reaplicada depois de atingir um desses estados.

## 5. Contrato HTTP

### Submeter

```http
POST /wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-a:transaction-123
```

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

Resultado esperado para uma aposta processada:

```json
{
  "transactionId": "0192f298-345e-7e38-af88-e43f851a819d",
  "status": "PROCESSED",
  "balance": { "amount": "975.00", "currency": "BRL" },
  "idempotentReplay": false
}
```

Mapeamento HTTP aprovado para esta feature:

- `201 Created`: BET processada pela primeira vez.
- `200 OK`: replay idempotente, com `idempotentReplay = true`.
- `400 Bad Request`: payload inválido.
- `404 Not Found`: wallet inexistente.
- `409 Conflict`: conflito de idempotência ou transação externa com payload diferente.
- `422 Unprocessable Content`: rejeição de negócio, como saldo insuficiente.
- `503 Service Unavailable`: falha transitória ou esgotamento dos retries de optimistic locking.

`202 Accepted` não é utilizado nesta fatia, porque o processamento de `BET` é síncrono. A API deve distinguir essas situações de forma consistente.

## 6. Critério de aceite

### AC-001 — BET processada

Dado um player com wallet `100.00 BRL` e `version = 1`

Quando o cliente enviar uma `BET` de `80.00 BRL` com `Idempotency-Key` nova

Então o sistema deve retornar o status de sucesso definido para a submissão, persistir a transação como `PROCESSED`, retornar saldo `20.00 BRL`, incrementar a versão para `2` e criar exatamente um `DEBIT` no ledger.

### AC-002 — saldo insuficiente

Dado um player com wallet `100.00 BRL`

Quando o cliente enviar uma `BET` de `120.00 BRL`

Então o sistema deve persistir a operação como `REJECTED` com `INSUFFICIENT_FUNDS`, manter saldo `100.00 BRL` e não criar lançamento de ledger.

### AC-003 — replay idempotente

Dado que uma `BET` foi processada com uma `Idempotency-Key` e payload específicos

Quando o cliente repetir a mesma requisição

Então o sistema deve retornar o resultado original com `idempotentReplay = true`, sem novo débito, sem novo ledger e sem novo incremento de versão.

### AC-004 — conflito de payload

Dado que uma `Idempotency-Key` já foi usada com uma `BET` de `25.00 BRL`

Quando o cliente reutilizar a mesma key para uma `BET` de `30.00 BRL`

Então o sistema deve retornar conflito explícito e o saldo deve permanecer igual ao resultado da primeira operação.

### AC-005 — concorrência sobre saldo

Dado um saldo inicial de `100.00 BRL` e duas `BET`s concorrentes de `80.00 BRL`

Quando as duas operações forem processadas simultaneamente

Então exatamente uma deve ser `PROCESSED`, a outra deve ser `REJECTED` por saldo insuficiente, o saldo final deve ser `20.00 BRL` e deve existir exatamente um débito.

### AC-006 — wallet incompatível

Dado uma `BET` cujo `playerId` ou moeda não corresponde à wallet informada

Quando o cliente enviar a operação

Então o sistema deve rejeitá-la sem alterar saldo e sem criar lançamento.

## 7. Casos de erro / edge cases

- `Idempotency-Key` ausente, vazia ou inválida → rejeitar antes de qualquer escrita.
- payload com `kind` diferente de `BET` → rejeitar como operação não suportada nesta feature.
- amount como número JSON, vazio, negativo, científico ou com mais de duas casas → rejeitar sem escrita.
- player, wallet ou moeda incompatível → rejeitar sem efeito financeiro.
- wallet inexistente → retornar `404` sem persistir `WagerTransaction`, saldo ou ledger, pois não existe wallet válida para referenciar e a FK deve ser preservada.
- wallet em moeda diferente da operação → rejeitar sem débito.
- saldo insuficiente → persistir `REJECTED` auditável, sem ledger.
- conflito de versão durante o débito → recarregar e repetir até três tentativas totais; ao esgotar retries, retornar `503` sem confirmar efeito financeiro ou duplicar lançamento.
- mesma transação externa com payload diferente → conflito, sem novo efeito.
- wallet inexistente → retornar `404` sem persistir transação financeira, sem alterar saldo ou ledger; a rejeição não é auditada em `wager_transactions` porque a FK de wallet é obrigatória.
- falha antes do commit → rollback completo e resposta de falha transitória sem afirmar sucesso.
- falha depois do commit antes da resposta → repetição idempotente deve retornar o resultado já persistido.

## 8. Fora de escopo desta feature

- `WIN`, `LOSS`, `REFUND` e `ROLLBACK`.
- Referências fora de ordem, `PENDING_REFERENCE` e worker de reprocessamento.
- SQS, Inbox, DLQ e redelivery de mensagens.
- Transactional Outbox e publicação de eventos de integração.
- Consulta pública de transações e ledger paginado.
- Reconciliação.
- Autenticação.
- Teste de carga e execução com três instâncias; a concorrência desta feature será validada no PostgreSQL real com requisições simultâneas.

## 9. Suposições e perguntas abertas

- [x] A próxima feature foi interpretada como a primeira fatia de processamento definida na Spec do Produto: `BET` síncrono por HTTP.
- [x] O header `Idempotency-Key` será obrigatório, conforme o README.
- [x] O hash usará SHA-256 sobre JSON canônico ordenado somente com campos de negócio, conforme decisão arquitetural aprovada.
- [x] A estratégia será optimistic locking com retry limitado, conforme decisão arquitetural aprovada.
- [x] Optimistic locking terá três tentativas totais — uma inicial e dois retries; após isso, a API retorna `503` sem efeito financeiro confirmado.
- [x] O mapeamento HTTP será `201` para processamento inicial, `200` para replay, `400` para payload inválido, `404` para wallet inexistente, `409` para conflitos, `422` para rejeição de negócio e `503` para falha transitória.
- [x] O `Idempotency-Key` será único no escopo do provider, com unicidade `(providerId, idempotencyKey)`, mantendo também `(providerId, externalTransactionId)`.
- [x] Os limites serão `providerId` até 64 caracteres, `externalTransactionId` até 255, `roundId` e `gameId` até 128, e `Idempotency-Key` até 255; campos devem ser não vazios e não conter caracteres de controle.
- [x] Wallet inexistente será retornada como `404`, sem persistir `WagerTransaction`, saldo ou ledger, preservando a FK obrigatória de `wager_transactions.wallet_id`.

Nenhuma dessas perguntas foi decidida silenciosamente. A implementação deve aguardar a revisão e aprovação desta Spec e o fechamento das decisões que alteram o contrato público ou a política de concorrência.

## 10. Definition of Done desta feature

- [ ] Esta Spec foi revisada e aprovada.
- [x] As perguntas de status, retry, escopo de key, limites de campos e wallet inexistente foram respondidas.
- [ ] `ProcessWagerTransaction` aceita somente `BET` nesta rodada e é chamado pelo HTTP.
- [ ] Money, player, wallet, moeda, valor e `Idempotency-Key` são validados antes do débito.
- [ ] BET processada persiste transação, wallet e um ledger `DEBIT` na mesma transação SQL.
- [ ] BET rejeitada por saldo insuficiente permanece auditável sem alterar saldo ou ledger.
- [ ] Replay idêntico retorna o resultado original sem novo efeito.
- [ ] Conflito de payload com a mesma key não produz efeito financeiro.
- [ ] Optimistic locking e retry limitado são testados com concorrência real.
- [ ] Falha intermediária confirma rollback completo.
- [ ] A regressão da feature anterior passa.
- [ ] Eu revisei e aprovei antes de iniciar a próxima fase.
