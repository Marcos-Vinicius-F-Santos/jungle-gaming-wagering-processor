# Spec da Feature — Reconciliação financeira da wallet

Status: Aprovada — sugestões incorporadas; plano e tarefas criados, aguardando implementação  
Projeto: Distributed Wagering Processor  
Onde vive no código: `src/modules/reconciliation/`, portas de leitura de `wallets` e interface HTTP  
Spec do produto: [`../../01-produto/spec.md`](../../01-produto/spec.md)  
Arquitetura: [`../../02-arquitetura/arquitetura.md`](../../02-arquitetura/arquitetura.md)  
Feature anterior: [`../09-consultas-ledger-transacoes/spec.md`](../09-consultas-ledger-transacoes/spec.md)

> Esta feature adiciona uma verificação financeira somente leitura para comparar o saldo materializado da wallet com o saldo reconstruído a partir do ledger imutável. Divergências são sinalizadas e observadas, nunca corrigidas silenciosamente.

## 1. Objetivo

Permitir que operadores e testes de integridade verifiquem se uma wallet permanece consistente com seu ledger persistido.

A feature deve fornecer:

- `POST /wallets/:walletId/reconciliation`;
- leitura do saldo materializado e dos lançamentos imutáveis da wallet;
- reconstrução exata do saldo usando `Money`, sem ponto flutuante;
- cálculo da diferença e indicação explícita de consistência;
- contagem dos lançamentos examinados;
- detecção de inconsistências na cadeia do ledger, além da divergência do saldo final;
- logs e métricas de reconciliação com cardinalidade controlada;
- resposta estável, segura e sem alteração de dados financeiros.

A reconciliação não cria correções, lançamentos, retries, eventos de negócio ou alterações de saldo.

## 2. Como funciona hoje

O sistema já possui:

- `GET /wallets/:walletId`, que retorna saldo, moeda e versão da wallet;
- `LedgerRepository.findByWalletId(walletId)`, que lê os lançamentos da wallet em ordem cronológica;
- `WalletLedgerEntry`, com direção, valor, moeda, `balanceBefore`, `balanceAfter` e timestamp;
- constraints de imutabilidade, unicidade por `(wallet_id, transaction_id)`, moeda, valor positivo e não-negatividade do saldo posterior;
- `Money`, que mantém valores decimais exatos como strings;
- logs estruturados, métricas e consultas de ledger implementados pelas features anteriores.

Ainda não existe:

- módulo `reconciliation`;
- porta/read model específico para obter um snapshot de wallet e ledger para reconciliação;
- caso de uso de reconstrução e comparação do saldo;
- endpoint HTTP de reconciliação;
- política de códigos de divergência e métricas de reconciliação.

## 3. Requisitos funcionais

### FR-001 — Expor a reconciliação da wallet

O sistema deve expor:

```http
POST /wallets/:walletId/reconciliation
```

O endpoint deve aceitar `walletId` como UUID, não exigir corpo e retornar `200 OK` quando a verificação for concluída, independentemente de o resultado ser consistente ou divergente.

UUID inválido deve ser rejeitado pelo padrão de validação HTTP existente, sem consultar o banco.

### FR-002 — Validar a existência da wallet

O caso de uso deve consultar a wallet pelo identificador informado. Quando ela não existir, o endpoint deve retornar `404 Not Found` com código seguro `WALLET_NOT_FOUND`.

Uma wallet existente com saldo zero e sem lançamentos é válida e deve retornar uma reconciliação consistente com `checkedEntries: 0`.

### FR-003 — Ler um snapshot consistente

A leitura do saldo materializado e do ledger deve ocorrer no mesmo snapshot lógico do PostgreSQL. A implementação deve usar uma unidade de leitura consistente, preferencialmente uma transação `READ ONLY` com isolamento `REPEATABLE READ`, ou uma estratégia equivalente comprovada.

A reconciliação não deve bloquear a wallet nem impedir processamento concorrente. Se uma operação financeira fizer commit durante a verificação, o resultado deve representar integralmente o estado observado antes ou depois desse commit, nunca uma combinação parcial de estados.

### FR-004 — Reconstruir o saldo com precisão exata

Para uma wallet na moeda `C`, o saldo calculado deve ser obtido pela soma exata dos lançamentos:

```text
calculatedBalance = soma(CREDIT) - soma(DEBIT)
```

O cálculo deve começar em `0.00 C`, incluir todos os lançamentos persistidos da wallet no snapshot e preservar duas casas decimais. Os saldos e valores de lançamento usam `Money`; a diferença pode ser negativa e deve usar uma representação decimal assinada exata própria do read model. Não pode usar `number`, `float` ou `double` em nenhuma camada do cálculo.

### FR-005 — Validar a cadeia do ledger

Além de comparar o saldo final, a reconciliação deve verificar cada lançamento e a continuidade cronológica da cadeia:

- `balanceBefore` e `balanceAfter` usam a mesma moeda da wallet;
- em `CREDIT`, `balanceBefore + amount = balanceAfter`;
- em `DEBIT`, `balanceBefore - amount = balanceAfter`;
- o `balanceAfter` de um lançamento é igual ao `balanceBefore` do próximo lançamento na ordem cronológica;
- o primeiro lançamento parte de `0.00`, quando houver lançamentos;
- nenhum saldo observado é negativo;
- o `balanceAfter` do último lançamento coincide com o saldo calculado.

Uma falha em qualquer regra torna `consistent` igual a `false`, mesmo que a soma de créditos e débitos coincida com o saldo materializado.

### FR-006 — Comparar com o saldo materializado

O saldo armazenado na wallet deve ser comparado ao saldo reconstruído. A resposta deve calcular:

```text
difference = calculatedBalance - storedBalance
```

`consistent` só pode ser `true` quando `difference` for `0.00` e nenhuma regra de cadeia tiver falhado.

Nenhum arredondamento, tolerância ou comparação aproximada é permitido.

### FR-007 — Retornar o contrato de reconciliação

Uma resposta bem-sucedida deve conter:

```json
{
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "storedBalance": { "amount": "975.00", "currency": "BRL" },
  "calculatedBalance": { "amount": "975.00", "currency": "BRL" },
  "difference": { "amount": "0.00", "currency": "BRL" },
  "consistent": true,
  "checkedEntries": 42,
  "issues": []
}
```

`issues` deve ser uma lista estável de códigos legíveis por máquina. Quando não houver divergência, deve ser vazia. Quando houver uma ou mais falhas, deve conter cada código relevante sem SQL, stack trace ou dados sensíveis.

Códigos mínimos:

| Código | Significado |
|---|---|
| `BALANCE_DIFFERENCE` | saldo calculado diferente do saldo materializado |
| `LEDGER_ENTRY_UNBALANCED` | um lançamento não satisfaz sua própria aritmética |
| `LEDGER_CHAIN_BROKEN` | `balanceAfter` não coincide com o próximo `balanceBefore` |
| `LEDGER_INITIAL_BALANCE_INVALID` | o primeiro lançamento não começa em zero |
| `LEDGER_NEGATIVE_BALANCE` | algum saldo persistido é negativo |
| `LEDGER_CURRENCY_MISMATCH` | lançamento ou saldo usa moeda diferente da wallet |

Os códigos devem ser deduplicados e ordenados de forma determinística. A resposta não deve expor IDs individuais de lançamentos por padrão.

### FR-008 — Sinalizar divergência sem corrigi-la

Quando `consistent` for `false`, o endpoint ainda deve retornar `200 OK` com a evidência calculada e os códigos em `issues`.

O caso de uso não pode:

- alterar `wallets`;
- inserir, atualizar ou excluir `wallet_ledger_entries`;
- criar ou alterar `wager_transactions`;
- modificar Inbox ou Outbox;
- publicar evento financeiro;
- recalcular e persistir automaticamente o saldo;
- emitir operação compensatória.

### FR-009 — Instrumentar a operação

A reconciliação deve registrar logs estruturados e métricas com baixa cardinalidade.

Métricas mínimas:

- `wallet_reconciliations_total`, com `outcome` `consistent`, `inconsistent`, `not_found` ou `unavailable`;
- `wallet_reconciliation_entries_checked_total`, com a contagem observada ou equivalente no adapter de métricas;
- `wallet_reconciliation_duration_ms`, com observação de duração.

`walletId`, IDs de lançamento e valores monetários completos podem aparecer em logs correlacionados quando necessários, mas não devem ser tags de métricas.

Uma falha do adapter de métricas não pode transformar uma reconciliação concluída em falha de negócio.

### FR-010 — Tratar falhas de leitura com segurança

Se o snapshot não puder ser confirmado por timeout, indisponibilidade do PostgreSQL ou erro de infraestrutura, o endpoint deve retornar `503 Service Unavailable` com código `RECONCILIATION_UNAVAILABLE`.

O erro não deve expor SQL, nome de tabela, stack trace, credenciais ou detalhes do ORM. A falha deve ser registrada com causa normalizada e correlação operacional.

## 4. Regras de negócio e operação

### BR-001 — Reconciliação é somente leitura

Uma execução bem-sucedida ou malsucedida não pode produzir efeitos financeiros ou de mensageria.

### BR-002 — O ledger persistido é a fonte da reconstrução

O saldo calculado deve ser derivado exclusivamente dos lançamentos persistidos no snapshot. O caso de uso não deve reprocessar transações nem inferir lançamentos ausentes a partir de `wager_transactions`.

### BR-003 — Valores e moeda são exatos

Todos os saldos e valores de lançamento da resposta são strings decimais não negativas com duas casas e moeda explícita. `difference` é uma string decimal assinada com duas casas e moeda explícita, pois pode ser negativa. Comparações são feitas por `Money`/decimal exato.

### BR-004 — Divergência é auditável, não autocorrigida

Uma inconsistência deve ser sinalizada na resposta, logada e contabilizada. A correção, investigação ou operação compensatória pertence a um fluxo futuro e não é executada por esta feature.

### BR-005 — Snapshot não é autorização

O endpoint apenas verifica a wallet indicada. Autenticação e autorização continuam fora da primeira fase; se um IdP externo for habilitado futuramente, o guard aplicável deve proteger o endpoint sem alterar a semântica financeira.

### BR-006 — Concorrência não usa lock global

A verificação não deve adquirir lock global nem impedir wallets distintas de processarem em paralelo. O snapshot deve garantir consistência de leitura sem alterar a estratégia de escrita otimista.

### BR-007 — Resultado é pontual

O relatório representa o snapshot obtido naquele request. Não constitui garantia de que a wallet permanecerá consistente após novos commits.

## 5. Contratos externos

### `POST /wallets/:walletId/reconciliation`

Request:

```http
POST /wallets/0192f291-27dd-7d3f-8071-5f8685deef37/reconciliation
```

Sem corpo e sem parâmetros de paginação.

Resposta consistente — `200 OK`:

```json
{
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "storedBalance": { "amount": "975.00", "currency": "BRL" },
  "calculatedBalance": { "amount": "975.00", "currency": "BRL" },
  "difference": { "amount": "0.00", "currency": "BRL" },
  "consistent": true,
  "checkedEntries": 42,
  "issues": []
}
```

Resposta divergente — `200 OK`:

```json
{
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "storedBalance": { "amount": "975.00", "currency": "BRL" },
  "calculatedBalance": { "amount": "950.00", "currency": "BRL" },
  "difference": { "amount": "-25.00", "currency": "BRL" },
  "consistent": false,
  "checkedEntries": 42,
  "issues": ["BALANCE_DIFFERENCE"]
}
```

Erros mínimos:

| Situação | HTTP | Código |
|---|---:|---|
| UUID inválido | 400 | `INVALID_IDENTIFIER` |
| wallet inexistente | 404 | `WALLET_NOT_FOUND` |
| snapshot/infraestrutura indisponível | 503 | `RECONCILIATION_UNAVAILABLE` |

O formato de erro deve seguir o padrão já adotado pelos controllers de wallets e consultas.

## 6. Persistência e desempenho

- Não é necessária migration para o contrato mínimo da feature.
- A leitura deve usar as tabelas atuais `wallets` e `wallet_ledger_entries`.
- O adapter deve selecionar apenas os campos necessários: saldo/moeda/versão da wallet e campos de cálculo do ledger.
- O cálculo pode ser feito em memória com `Money` após leitura dos registros, desde que não use ponto flutuante e que a quantidade lida seja observável.
- Não usar o endpoint paginado do ledger para reconciliação, pois a reconciliação precisa avaliar o conjunto completo no mesmo snapshot.
- O custo é linear em `checkedEntries`; a feature não deve introduzir `COUNT(*)` separado nem N+1.
- O resultado não deve ser armazenado em cache como fonte de verdade.

## 7. Critérios de aceite

### AC-001 — Wallet consistente com saldo inicial

Dada uma wallet com `OPENING` e operações financeiras válidas, quando a reconciliação for executada, então o saldo calculado deve coincidir com o saldo armazenado, `difference` deve ser `0.00`, `consistent` deve ser `true` e `issues` deve ser vazia.

### AC-002 — Wallet sem lançamentos

Dada uma wallet com saldo `0.00` e nenhum lançamento, quando a reconciliação for executada, então deve retornar `200`, saldo calculado `0.00`, `checkedEntries: 0` e resultado consistente.

### AC-003 — Wallet inexistente

Dado um UUID válido que não corresponde a uma wallet, quando a reconciliação for executada, então deve retornar `404` com `WALLET_NOT_FOUND` sem tentar calcular saldo.

### AC-004 — Divergência de saldo

Dada uma wallet cujo saldo materializado não coincide com a soma exata do ledger, quando a reconciliação for executada, então deve retornar `200`, `consistent: false`, `BALANCE_DIFFERENCE` e a diferença com sinal `calculatedBalance - storedBalance`.

### AC-005 — Lançamento aritmeticamente inválido

Dado um lançamento inconsistente com sua direção e seus saldos, quando a reconciliação for executada, então deve retornar `consistent: false` e `LEDGER_ENTRY_UNBALANCED`.

### AC-006 — Cadeia quebrada

Dado que dois lançamentos consecutivos não compartilhem o mesmo saldo de transição, quando a reconciliação for executada, então deve retornar `consistent: false` e `LEDGER_CHAIN_BROKEN`.

### AC-007 — Primeiro lançamento inválido

Dado que o primeiro lançamento não comece em `0.00`, quando a reconciliação for executada, então deve retornar `consistent: false` e `LEDGER_INITIAL_BALANCE_INVALID`.

### AC-008 — Moeda incompatível

Dado um lançamento com moeda diferente da wallet, quando a reconciliação for executada, então deve retornar `consistent: false` e `LEDGER_CURRENCY_MISMATCH`, sem converter valores.

### AC-009 — Snapshot sob concorrência

Dado um processamento financeiro concorrente à reconciliação, quando o request terminar, então o resultado deve corresponder a um snapshot completo antes ou depois do commit observado, sem combinar saldo de uma versão com ledger de outra.

### AC-010 — Somente leitura

Dada qualquer execução válida ou divergente, quando ela terminar, então contagens, versões e timestamps de wallet, ledger, transação, Inbox e Outbox devem permanecer iguais.

### AC-011 — Erros seguros

Dado timeout ou indisponibilidade do PostgreSQL, quando a reconciliação for executada, então deve retornar `503` com `RECONCILIATION_UNAVAILABLE` sem vazar SQL, stack trace ou credenciais.

### AC-012 — Observabilidade

Dada uma reconciliação consistente, divergente, inexistente ou indisponível, quando as métricas forem observadas, então o outcome, duração e contagem de lançamentos devem ser registrados com tags de baixa cardinalidade.

### AC-013 — Regressão financeira

Dado o módulo de reconciliação habilitado, quando BET, WIN, LOSS, REFUND, ROLLBACK, Inbox, referências, Outbox, consultas e health forem executados, então seus contratos e efeitos previamente aprovados devem permanecer iguais.

## 8. Casos de erro e edge cases

- wallet UUID inválido;
- wallet inexistente;
- wallet zero sem ledger;
- wallet positiva com `OPENING` e ledger completo;
- saldo materializado menor ou maior que o saldo calculado;
- diferença negativa, positiva ou zero;
- ledger com dois lançamentos no mesmo timestamp;
- ledger com moeda incompatível;
- `balanceBefore` ou `balanceAfter` aritmeticamente inválido;
- primeiro `balanceBefore` diferente de zero;
- transição quebrada entre lançamentos;
- saldo persistido negativo, caso uma base inconsistente seja encontrada apesar das constraints;
- ledger vazio para wallet com saldo positivo;
- wallet com somente lançamentos sem efeito financeiro não é uma situação inválida por si só;
- commit financeiro concorrente antes ou depois do snapshot;
- timeout da leitura;
- falha ao registrar métrica;
- erro de serialização de log;
- execução repetida não cria registros ou eventos adicionais;
- a resposta não deve listar payloads, secrets ou IDs de lançamento desnecessários.

## 9. Fora de escopo desta feature

- Corrigir automaticamente o saldo da wallet.
- Criar lançamentos compensatórios ou alterar o ledger.
- Alterar `WagerTransaction`, Inbox, Outbox, SQS, workers ou regras financeiras.
- Reconciliar todas as wallets em lote ou criar agendamento periódico.
- Exportar relatório CSV, dashboard, alertas ou integração com APM.
- Expor detalhes de cada lançamento como contrato público obrigatório.
- Implementar autenticação artesanal ou autorização de operador.
- Criar migration sem necessidade comprovada pelo schema atual.
- Alterar o `README.md`.

## 10. Suposições, perguntas abertas e sugestões

### Decisões já definidas pelo produto e pela arquitetura

- [x] O endpoint é `POST /wallets/:walletId/reconciliation`.
- [x] A resposta deve apresentar saldo armazenado, saldo calculado, diferença, consistência e quantidade de lançamentos.
- [x] Divergências devem ser sinalizadas, contabilizadas e logadas, sem correção silenciosa.
- [x] O ledger imutável é a base do saldo reconstruído.
- [x] Valores monetários usam `Money` e strings decimais exatas.
- [x] O módulo de reconciliação é separado de `wallets` e `wagering`, usando portas de leitura.
- [x] Autenticação permanece fora da primeira fase.

### Sugestões para aprovação antes do plano

- [x] **Snapshot:** executar wallet e ledger em transação PostgreSQL `READ ONLY` com `REPEATABLE READ`, sem locks de escrita.
- [x] **Cálculo:** usar soma por direção a partir de `0.00` e validar também a cadeia `balanceBefore`/`balanceAfter`.
- [x] **Divergência:** manter `200 OK` para inconsistência de dados, reservando `503` para falha em confirmar a leitura.
- [x] **Contrato:** incluir `issues` com códigos estáveis e lista vazia para resultados consistentes.
- [x] **Observabilidade:** usar `wallet_reconciliations_total`, `wallet_reconciliation_entries_checked_total` e `wallet_reconciliation_duration_ms`, sem IDs em tags.
- [x] **Dados expostos:** não retornar IDs de lançamentos, payloads ou valores além dos quatro saldos do contrato.
- [x] **Migration:** não criar migration; validar a implementação contra o schema atual e registrar ausência de alteração estrutural.

## 11. Definition of Done desta feature

- [x] Esta Spec foi revisada e aprovada.
- [x] A política de snapshot consistente foi aprovada.
- [x] O algoritmo exato de reconstrução e validação da cadeia foi aprovado.
- [x] O contrato de `issues` e os códigos de divergência foram aprovados.
- [ ] O endpoint `POST /wallets/:walletId/reconciliation` foi implementado.
- [ ] A reconciliação não altera wallet, ledger, transação, Inbox, Outbox ou SQS.
- [ ] Testes unitários cobrem soma, direção, precisão, cadeia, moedas e códigos de issues.
- [ ] Testes de integração usam PostgreSQL real para saldo consistente, divergência e wallet vazia.
- [ ] Teste concorrente confirma snapshot completo durante processamento financeiro.
- [ ] Erros de ausência e infraestrutura são mapeados sem vazamento de detalhes internos.
- [ ] Logs e métricas têm correlação segura e cardinalidade controlada.
- [ ] A suíte de regressão das features anteriores permanece passando.
- [ ] O README não foi alterado.
- [x] O plano e as tarefas foram criados depois da aprovação formal desta Spec.
