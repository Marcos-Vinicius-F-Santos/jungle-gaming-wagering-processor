# Spec da Feature — Consultas de ledger e transações

Status: Implementação verificada — aguardando aprovação final  
Projeto: Distributed Wagering Processor  
Onde vive no código: `src/modules/wallets/`, `src/modules/wagering/` e interfaces HTTP  
Spec do produto: [`../../01-produto/spec.md`](../../01-produto/spec.md)  
Arquitetura: [`../../02-arquitetura/arquitetura.md`](../../02-arquitetura/arquitetura.md)  
Feature anterior: [`../08-observabilidade-saude/spec.md`](../08-observabilidade-saude/spec.md)

> Esta feature adiciona consultas HTTP somente leitura para o ledger da wallet e para transações financeiras persistidas, sem alterar saldo, estado de transação, Inbox, Outbox ou regras de processamento.

## 1. Objetivo

Permitir que clientes e operadores consultem o histórico financeiro de uma wallet e localizem uma transação por identificador interno ou pela identidade externa do provider.

A feature deve fornecer:

- consulta paginada do ledger por wallet;
- consulta de uma transação pelo `transactionId`;
- consulta de uma transação por `(providerId, externalTransactionId)`;
- contratos de resposta com valores monetários como strings decimais;
- cursor opaco, estável e baseado em `(createdAt, id)`;
- leituras sem efeitos colaterais e sem acesso direto do controller ao banco;
- erros seguros para wallet, transação ou cursor inexistentes/inválidos;
- métricas e logs de consulta com cardinalidade controlada.

Reconciliação, autenticação, cache e alterações financeiras permanecem fora desta feature.

## 2. Como funciona hoje

O sistema já possui:

- `GET /wallets/:walletId`, que retorna saldo, moeda, player e versão;
- `MikroOrmLedgerRepository`, com persistência de lançamentos e uma leitura completa por wallet;
- `MikroOrmWagerTransactionRepository`, com persistência das operações `OPENING`, `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`;
- constraints de unicidade para `(provider_id, external_transaction_id)`;
- chave primária em `wager_transactions.id`;
- `WalletLedgerEntry` com direção, valor, moeda, saldo antes, saldo depois e timestamp;
- `WagerTransactionRecord` com status, referências, falha, saldo resultante e timestamps;
- `ParseUUIDPipe`, validação HTTP e mapeamento de falhas de infraestrutura para respostas seguras;
- logs estruturados, correlação HTTP e métricas implementados pela feature anterior.

Ainda não existe:

- endpoint HTTP para consultar lançamentos do ledger;
- paginação por cursor para o ledger;
- read model/porta específica para consultar transações sem reutilizar regras de processamento;
- consulta por `transactionId` para todos os kinds e status persistidos;
- consulta por identidade externa do provider;
- índice composto do ledger adequado à ordenação paginada por wallet;
- contrato público estável para os detalhes retornados por essas consultas.

## 3. Requisitos funcionais

### FR-001 — Consultar o ledger de uma wallet

O sistema deve expor `GET /wallets/:walletId/ledger`.

O endpoint deve:

- aceitar `walletId` como UUID;
- validar a existência da wallet antes de responder;
- retornar os lançamentos pertencentes somente à wallet informada;
- ordenar os itens por `createdAt` decrescente e, em caso de empate, por `id` decrescente;
- retornar cada lançamento uma única vez dentro da ordenação definida;
- não recalcular nem alterar o saldo materializado;
- não retornar lançamentos de outra wallet mesmo quando o cursor for reutilizado incorretamente.

Uma wallet existente sem lançamentos deve retornar uma página vazia, não um erro.

### FR-002 — Paginar o ledger com cursor opaco

O endpoint deve aceitar:

- `limit`, opcional, padrão `50`, mínimo `1` e máximo `100`;
- `cursor`, opcional, emitido pelo servidor e tratado pelo cliente como opaco.

O cursor deve representar a posição da página anterior — incluindo o `walletId` de escopo, a combinação `(createdAt, id)` e a ordenação descendente — e ser codificado em Base64URL. O cliente não deve depender do formato interno. Um cursor válido de outra wallet deve ser rejeitado com `400`.

Para uma consulta descendente, a próxima página deve selecionar registros posteriores à posição do cursor na ordenação lógica, equivalente a:

```text
(created_at, id) < (cursor.createdAt, cursor.id)
```

O servidor deve buscar no máximo `limit + 1` registros para determinar se existe próxima página, sem executar `COUNT(*)` obrigatório. Quando não houver mais itens, `nextCursor` deve ser `null`.

Cursor ausente significa primeira página. Cursor malformado, incompatível com o formato ou com data/UUID inválidos deve resultar em `400 Bad Request`, sem consulta financeira parcial.

### FR-003 — Retornar lançamentos com valores exatos

Cada item do ledger deve conter, no mínimo:

```json
{
  "id": "uuid-v7",
  "transactionId": "uuid-v7",
  "direction": "CREDIT",
  "amount": "100.00",
  "currency": "BRL",
  "balanceBefore": "0.00",
  "balanceAfter": "100.00",
  "createdAt": "2026-10-16T12:00:00.000Z"
}
```

Valores monetários devem permanecer strings decimais com duas casas. O endpoint não deve converter valores para `number`, `float` ou `double`.

### FR-004 — Consultar transação por identificador interno

O sistema deve expor `GET /wagering/transactions/:transactionId`.

O endpoint deve:

- validar `transactionId` como UUID;
- localizar qualquer transação persistida dos kinds suportados, incluindo `OPENING`;
- retornar o estado persistido sem executar replay, retry, validação de referência ou regra financeira;
- retornar `404 Not Found` quando o identificador não existir;
- retornar `503 Service Unavailable` ou equivalente seguro quando a leitura não puder ser confirmada;
- nunca expor SQL, stack trace, credenciais ou detalhes internos do ORM.

### FR-005 — Consultar transação pela identidade externa

O sistema deve expor `GET /providers/:providerId/wagering/transactions/:externalTransactionId`.

O endpoint deve consultar pela chave única `(providerId, externalTransactionId)` e retornar o mesmo read model do endpoint por ID.

O escopo do `providerId` é obrigatório. Uma transação de outro provider com o mesmo `externalTransactionId` não pode ser retornada.

Quando não houver correspondência, o endpoint deve retornar `404 Not Found`, sem diferenciar se o provider existe ou não.

### FR-006 — Retornar um read model seguro da transação

O read model deve representar, quando disponíveis:

- `id`;
- `providerId`;
- `externalTransactionId`;
- `walletId`;
- `playerId`;
- `roundId`;
- `gameId`;
- `kind`;
- `status`;
- `amount` e `currency`;
- `referenceExternalTransactionId`;
- `referenceTransactionId`;
- `pendingSince`;
- `nextAttemptAt`;
- `pendingAttempts`;
- `failureCode`;
- `resultBalance`;
- `createdAt`;
- `processedAt`.

O read model não deve expor por padrão `payloadHash`, payload bruto ou dados de autenticação. A exposição de `idempotencyKey` depende da decisão registrada antes do plano, pois é um identificador fornecido pelo provider e pode ser sensível operacionalmente.

### FR-007 — Manter leitura separada do processamento

Controllers de consulta devem chamar casos de uso de leitura ou portas de query. Não devem:

- chamar `ProcessWagerTransactionUseCase` para obter uma transação;
- reidratar entidades somente para executar regras de domínio;
- acessar `EntityManager` diretamente;
- alterar estado para materializar uma resposta;
- compartilhar métodos de escrita com semântica que permita `flush` acidental.

As portas de leitura podem retornar DTOs imutáveis próprios da aplicação, sem obrigar o domínio financeiro a conhecer HTTP, MikroORM ou SQL.

### FR-008 — Preservar consistência dos dados retornados

As consultas devem ler os registros persistidos pelo PostgreSQL e preservar:

- a relação entre `walletId`, `transactionId` e lançamento;
- o `balanceBefore` e `balanceAfter` registrado no ledger;
- o status terminal ou pendente da transação;
- os valores monetários e suas moedas;
- timestamps em ISO 8601 UTC;
- a identidade externa com escopo de provider.

A consulta não deve reconstruir um saldo diferente do saldo materializado nem corrigir dados silenciosamente.

### FR-009 — Instrumentar consultas sem alta cardinalidade

Cada endpoint deve registrar duração e outcome com tags controladas, por exemplo:

- `operation`: `LEDGER_LIST`, `TRANSACTION_BY_ID` ou `TRANSACTION_BY_EXTERNAL`;
- `outcome`: `success`, `not_found`, `invalid_cursor`, `invalid_input` ou `unavailable`.

`walletId`, `transactionId`, `providerId` e `externalTransactionId` podem aparecer em logs correlacionados quando necessários, mas não devem ser tags de métricas.

## 4. Regras de negócio e operação

### BR-001 — Consultas nunca produzem efeito financeiro

Nenhuma consulta pode alterar wallet, ledger, transação, Inbox, Outbox, retries ou eventos.

### BR-002 — O ledger é imutável

O endpoint expõe lançamentos já persistidos. Não deve existir operação HTTP nesta feature para editar, excluir, reordenar ou recriar um lançamento.

### BR-003 — Cursor é posição, não autorização

O cursor serve apenas para paginação. Ele não concede acesso a outra wallet, não substitui autorização e não deve ser usado para consultar registros fora do `walletId` da URL.

### BR-004 — Ordenação é determinística

`createdAt` sozinho não é suficiente para paginação. O `id` é o desempate obrigatório para que duas entradas com o mesmo timestamp tenham posição estável.

### BR-005 — Valores financeiros são exatos

O contrato público mantém strings decimais e a moeda associada. Nenhuma camada de consulta pode usar ponto flutuante para formatar ou comparar dinheiro.

### BR-006 — Estado persistido prevalece

O endpoint retorna o estado persistido, inclusive `PENDING`, `PENDING_REFERENCE`, `REJECTED` ou `FAILED`, sem tentar concluir a operação durante a consulta.

### BR-007 — Erros de leitura não vazam infraestrutura

Mensagens de erro não devem revelar SQL, nomes de tabelas, endpoints internos, stack traces ou credenciais. Logs podem conter um código operacional curto e a causa normalizada.

### BR-008 — Autenticação segue fora da primeira fase

Conforme produto e arquitetura atuais, esta feature não cria autenticação artesanal. Se autenticação for habilitada futuramente por IdP externo, os endpoints deverão respeitar o guard correspondente; a regra não altera a semântica das consultas.

## 5. Contratos externos

### `GET /wallets/:walletId/ledger`

Query params:

```text
cursor=<opaque-base64url>&limit=50
```

Resposta `200 OK`:

```json
{
  "walletId": "018f0000-0000-7000-8000-000000000001",
  "items": [
    {
      "id": "018f0000-0000-7000-8000-000000000002",
      "transactionId": "018f0000-0000-7000-8000-000000000003",
      "direction": "DEBIT",
      "amount": "25.00",
      "currency": "BRL",
      "balanceBefore": "100.00",
      "balanceAfter": "75.00",
      "createdAt": "2026-10-16T12:00:00.000Z"
    }
  ],
  "nextCursor": "eyJjcmVhdGVkQXQiOiIyMDI2LTEwLTE2VDEyOjAwOjAwLjAwMFoiLCJpZCI6IjAxOGYwMDAwLTAwMDAtNzAwMC04MDAwLTAwMDAwMDAwMDAwMyJ9"
}
```

Regras:

- primeira página sem `cursor`;
- `limit` padrão `50`, máximo `100`;
- `nextCursor: null` na última página;
- wallet desconhecida retorna `404`;
- wallet existente sem lançamentos retorna `200` com `items: []` e `nextCursor: null`;
- UUID inválido, `limit` inválido ou cursor inválido retorna `400`.

### `GET /wagering/transactions/:transactionId`

Resposta `200 OK` usa o read model da transação:

```json
{
  "id": "018f0000-0000-7000-8000-000000000003",
  "providerId": "provider-a",
  "externalTransactionId": "external-a",
  "walletId": "018f0000-0000-7000-8000-000000000001",
  "playerId": "018f0000-0000-7000-8000-000000000004",
  "roundId": "round-a",
  "gameId": "game-a",
  "kind": "BET",
  "status": "PROCESSED",
  "amount": "25.00",
  "currency": "BRL",
  "failureCode": null,
  "resultBalance": { "amount": "75.00", "currency": "BRL" },
  "createdAt": "2026-10-16T12:00:00.000Z",
  "processedAt": "2026-10-16T12:00:00.010Z"
}
```

`404 Not Found` deve ser usado quando a transação não existir. A resposta não deve diferenciar ausência por ID inválido de detalhes internos do banco.

### `GET /providers/:providerId/wagering/transactions/:externalTransactionId`

Usa o mesmo status HTTP e o mesmo read model da consulta por ID. O lookup deve ser escopado pelo par completo `providerId` + `externalTransactionId`.

### Erros mínimos

Os códigos abaixo são a convenção proposta para respostas seguras:

| Situação | HTTP | Código proposto |
|---|---:|---|
| UUID inválido | 400 | `INVALID_IDENTIFIER` |
| `limit` inválido | 400 | `INVALID_LIMIT` |
| cursor inválido | 400 | `INVALID_CURSOR` |
| wallet inexistente | 404 | `WALLET_NOT_FOUND` |
| transação inexistente | 404 | `TRANSACTION_NOT_FOUND` |
| falha de leitura | 503 | `READ_UNAVAILABLE` |

O formato final de erro deve ser alinhado ao padrão já adotado pelos controllers antes da implementação.

## 6. Persistência e desempenho

### Ledger

Criar migration reversível para suportar a paginação por keyset, preferencialmente com índice:

```sql
create index wallet_ledger_entries_wallet_created_id_idx
  on wallet_ledger_entries (wallet_id, created_at desc, id desc);
```

O índice deve ser avaliado contra o plano de execução real e não deve remover a constraint de imutabilidade ou a unicidade `(wallet_id, transaction_id)`.

### Transações

- `wager_transactions.id` já possui chave primária para consulta direta;
- `(provider_id, external_transaction_id)` já possui unicidade e deve ser usado pela consulta externa;
- a consulta não deve carregar payloads ou relações não necessárias;
- a consulta por ID e a consulta externa devem retornar uma linha ou nenhuma, sem paginação.

### Leitura

- usar um manager/contexto de leitura compatível com o padrão MikroORM atual;
- não manter entidades mutáveis em cache de processo;
- não fazer `COUNT(*)` obrigatório para o ledger;
- não adicionar N+1 para enriquecer itens com dados que não fazem parte do contrato;
- manter o tempo de resposta observável sem transformar IDs em tags.

## 7. Critérios de aceite

### AC-001 — Ledger da wallet

Dada uma wallet existente com lançamentos, quando o endpoint for chamado, então deve retornar somente os lançamentos daquela wallet, com valores, direção e saldos registrados.

### AC-002 — Wallet sem lançamentos

Dada uma wallet existente sem lançamentos, quando a primeira página for consultada, então deve retornar `200`, lista vazia e `nextCursor: null`.

### AC-003 — Wallet inexistente

Dado um UUID de wallet que não existe, quando o ledger for consultado, então deve retornar `404` sem executar escrita ou expor detalhes do banco.

### AC-004 — Ordenação determinística

Dado que dois lançamentos tenham o mesmo `createdAt`, quando forem consultados, então a ordenação por `id` deve desempatar de forma determinística.

### AC-005 — Paginação por cursor

Dado um ledger com mais de `limit` itens, quando a página seguinte for consultada com `nextCursor`, então não deve repetir nem pular itens na ordenação definida.

### AC-006 — Limites de paginação

Dado `limit` ausente, válido, menor que `1` ou maior que `100`, quando o endpoint for chamado, então deve aplicar `50`, aceitar o valor válido ou retornar `400`, respectivamente.

### AC-007 — Cursor inválido

Dado um cursor alterado, vazio, não Base64URL ou com posição inválida, quando for utilizado, então deve retornar `400` sem fazer uma consulta financeira ambígua.

### AC-008 — Consulta por ID

Dada uma transação persistida de qualquer kind suportado, quando for consultada pelo ID, então deve retornar o estado persistido e seus dados de rastreabilidade sem executar processamento.

### AC-009 — Consulta por provider

Dada uma transação persistida, quando for consultada pelo par `(providerId, externalTransactionId)`, então deve retornar a mesma transação que a consulta por ID.

### AC-010 — Escopo de provider

Dado que dois providers usem valores externos diferentes ou que uma consulta use provider incorreto, então somente o par exato deve retornar resultado; casos sem correspondência retornam `404`.

### AC-011 — Estados e valores exatos

Dada uma transação `PROCESSED`, `REJECTED`, `PENDING` ou `PENDING_REFERENCE`, quando for consultada, então o status, `failureCode`, referências, saldo resultante e valores monetários devem refletir o PostgreSQL sem conversão para ponto flutuante.

### AC-012 — Somente leitura

Dada qualquer consulta de ledger ou transação, quando ela terminar, então contagens e versões de wallet, ledger, transação, Inbox e Outbox devem permanecer iguais.

### AC-013 — Erros seguros

Dado erro de validação, ausência de registro ou falha de infraestrutura, quando a API responder, então deve usar o status/código definido sem SQL, stack trace, segredo ou payload bruto.

### AC-014 — Regressão financeira

Dado que os novos repositories, casos de uso e controllers estejam habilitados, quando BET, WIN, LOSS, REFUND, ROLLBACK, Inbox, referências, Outbox e health forem executados, então seus efeitos financeiros e contratos previamente aprovados devem permanecer iguais.

### AC-015 — Observabilidade da leitura

Dada uma consulta bem-sucedida, inválida, não encontrada ou indisponível, quando as métricas forem observadas, então o outcome deve ser contabilizado com tags de baixa cardinalidade e duração em milissegundos.

## 8. Casos de erro e edge cases

- wallet UUID inválido;
- transaction UUID inválido;
- `providerId` vazio, longo demais ou contendo caracteres não aceitos;
- `externalTransactionId` vazio, longo demais ou contendo caracteres não aceitos;
- `limit=0`, negativo, decimal, não numérico ou maior que `100`;
- cursor vazio, truncado, alterado ou codificado com posição inexistente;
- cursor válido de outra wallet;
- duas entradas com o mesmo timestamp;
- criação de novos lançamentos entre duas páginas;
- wallet existente sem ledger;
- transação `OPENING` sem campos externos de operação financeira;
- transação `PENDING_REFERENCE` com `nextAttemptAt` futuro;
- transação `REJECTED` com `failureCode` e sem `resultBalance`;
- transação `LOSS` processada sem lançamento de ledger adicional;
- provider inexistente;
- external ID inexistente;
- erro de conexão ou timeout do PostgreSQL;
- consulta concorrente com processamento financeiro sem leitura de estado intermediário inválido;
- falha ao registrar métrica não deve transformar uma leitura confirmada em mutação ou crash;
- logs de consulta não devem incluir payload bruto, `payloadHash` ou valores financeiros desnecessários.

## 9. Fora de escopo desta feature

- Criar, alterar, excluir ou corrigir lançamentos do ledger.
- Reconstruir ou corrigir automaticamente o saldo da wallet.
- Implementar `POST /wallets/:walletId/reconciliation`.
- Alterar processamento de BET, WIN, LOSS, REFUND ou ROLLBACK.
- Alterar Inbox, Outbox, SQS, retries ou workers.
- Criar busca paginada de todas as transações do sistema sem chave de consulta definida.
- Filtros adicionais por data, kind, status, round ou game.
- Exportar CSV, relatório financeiro, dashboard ou cache distribuído.
- Autenticação artesanal; a integração com IdP externo permanece decisão separada.
- Alterar o `README.md`.

## 10. Suposições, perguntas abertas e sugestões

### Decisões já definidas pelo produto e pela arquitetura

- [x] Os endpoints de ledger e transações fazem parte da API prevista no produto.
- [x] O ledger é imutável e as consultas não podem produzir efeitos financeiros.
- [x] Valores monetários são serializados como strings decimais e persistidos com precisão exata.
- [x] O cursor usa Base64URL, é baseado em `(createdAt, id)`, ordena decrescentemente e respeita padrão `50`/máximo `100`.
- [x] A consulta por external ID é escopada por `providerId`.
- [x] Controllers não acessam banco diretamente; consultas usam casos de uso e portas.
- [x] Autenticação permanece fora da primeira fase e health continua sem autenticação.

### Sugestões para aprovação antes do plano

- [x] **Read model:** não expor `payloadHash` nem `idempotencyKey` por padrão; retornar somente campos de rastreabilidade necessários ao cliente.
- [x] **Wallet inexistente:** retornar `404`, diferenciando wallet conhecida sem lançamentos, que retorna página vazia.
- [x] **Cursor de outra wallet:** rejeitar o cursor com `400`, evitando resultados inesperados fora da wallet da URL.
- [x] **Índice:** criar `(wallet_id, created_at DESC, id DESC)` em migration reversível e validar o plano com PostgreSQL real.
- [x] **Erros:** padronizar códigos `INVALID_CURSOR`, `INVALID_LIMIT`, `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND` e `READ_UNAVAILABLE` no formato de erro HTTP existente.
- [x] **Consistência:** usar leitura `READ COMMITTED` por request, sem snapshot de múltiplas páginas; o cursor garante progresso, não congelamento histórico.
- [x] **Observabilidade:** adicionar `read_queries_total` e `read_query_duration_ms` com `operation`/`outcome`, sem IDs como tags.
- [x] **Ordenação temporal:** usar `createdAt DESC, id DESC` tanto no SQL quanto na geração do cursor, sem conversão de timezone local.

## 11. Definition of Done desta feature

- [x] Esta Spec foi revisada e aprovada.
- [x] O formato do read model e a política de exposição de identificadores foram aprovados.
- [x] O contrato de cursor, limites e comportamento para wallet inexistente foram aprovados.
- [x] O índice de paginação foi criado em migration reversível e verificado com PostgreSQL.
- [x] Existem portas/casos de uso de leitura separados dos fluxos financeiros de escrita.
- [x] `GET /wallets/:walletId/ledger` implementa paginação sem repetição ou salto sob a ordenação aprovada.
- [x] As consultas por ID e por provider retornam todos os estados persistidos sem efeitos colaterais.
- [x] Erros de entrada, ausência e infraestrutura são mapeados sem vazamento de detalhes internos.
- [x] Logs e métricas de consulta são seguros e têm cardinalidade controlada.
- [x] Testes unitários cobrem cursor, limites, mapeamento, estados e erros.
- [x] Testes de integração usam PostgreSQL real para paginação, precisão e ausência de mutação.
- [x] A suíte completa e a regressão dos fluxos anteriores passam.
- [x] O README não foi alterado.
- [ ] O plano e as tarefas foram criados somente depois da aprovação formal desta Spec.
