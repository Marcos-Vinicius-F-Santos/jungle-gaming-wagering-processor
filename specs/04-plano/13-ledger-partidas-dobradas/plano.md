# Plano de Implementação — Ledger de partidas dobradas

Spec relacionada: [`../../03-features/13-ledger-partidas-dobradas/spec.md`](../../03-features/13-ledger-partidas-dobradas/spec.md)  
Arquitetura relacionada: [`../../../ARCHITECTURE.md`](../../../ARCHITECTURE.md)  
README de referência: [`../../../README.md`](../../../README.md)  
Feature anterior: [`../12-teste-carga-capacidade/plano.md`](../12-teste-carga-capacidade/plano.md)  

Status: Implementação verificada — aguardando aprovação final  

## 1. Objetivo do plano

Implementar o diferencial opcional de partidas dobradas como uma camada contábil append-only, preservando o saldo materializado, o `WalletLedgerEntry` compatível, as regras de negócio, a idempotência, o processamento HTTP/SQS e a Transactional Outbox.

O resultado deve permitir reconstruir e verificar cada efeito financeiro como débitos e créditos balanceados por moeda, sem criar um segundo fluxo financeiro nem exigir um endpoint público novo.

## 2. Decisões aplicadas da Spec

- O catálogo inicial terá contas `WALLET`, `HOUSE_FUNDING`, `GAME_STAKE`, `GAME_PAYOUT` e `REVERSAL_CLEARING`, com chave estável e moeda explícita.
- `LOSS` permanecerá sem journal patrimonial na primeira versão, preservando a semântica atual de não alterar saldo.
- `WalletLedgerEntry` continuará como projeção compatível durante a migração; os postings serão a camada contábil adicional.
- O backfill usará `LEGACY_COUNTERPARTY` quando o histórico não contiver a contrapartida econômica original, registrando essa limitação.
- Não será criado endpoint HTTP público novo nesta entrega; reconciliação e testes verificarão journals e postings.
- Migrations serão reversíveis no schema e os registros confirmados serão append-only.
- Balanceamento será validado no domínio dentro da Unit of Work e reforçado por constraint trigger, procedimento ou verificação transacional equivalente.
- Qualquer divergência contábil será bloqueadora, mesmo que o saldo materializado pareça correto.

## 3. Baseline e impacto

### Já existente

- `Money`, `Wallet`, `WagerTransaction` e `WalletLedgerEntry` imutável.
- Processamento financeiro síncrono com optimistic locking, idempotência e referências.
- Inbox persistente, Outbox transacional, publisher, retry, DLQ e shutdown.
- Reconciliação de saldo contra ledger.
- Migrations MikroORM e regressão unitária, integração, resiliência e carga.

### A adicionar

- `LedgerAccount`, `JournalEntry` e `Posting` no domínio.
- Política determinística de contas e mapeamento de efeitos.
- Tabelas, índices, constraints e proteção append-only.
- Repositórios e portas para inserir/consultar journals e postings.
- Construção contábil dentro da mesma Unit of Work financeira.
- Backfill histórico idempotente e relatório de linhas ambíguas.
- Verificações contábeis na reconciliação e testes de falhas/concurrency.

### A preservar

- Contratos HTTP e envelope SQS existentes.
- Saldos, versões, statuses e failure codes atuais.
- No máximo um efeito financeiro por operação.
- `LOSS` sem alteração de saldo e sem ledger patrimonial.
- Ack após commit, Outbox no mesmo commit e sem publicação antecipada.
- `README.md` e `ARCHITECTURE.md`, salvo decisão explícita posterior.

## 4. Desenho técnico

### 4.1 Domínio

Implementar value objects/enums para tipo de conta e direção de posting. `JournalEntry.create` deve exigir pelo menos um débito e um crédito, moeda única, valores positivos e igualdade exata dos totais. `rehydrate` apenas reconstrói estado persistido.

O journal será criado por uma política de aplicação que recebe a transação financeira e o efeito aplicado. A política não poderá usar `number` para dinheiro nem decidir contrapartida por string livre.

### 4.2 Persistência

Criar três tabelas novas:

| Tabela | Responsabilidade | Garantias principais |
|---|---|---|
| `ledger_accounts` | catálogo de contas | chave estável, moeda, conta wallet única |
| `ledger_journal_entries` | cabeçalho do lançamento | vínculo único com transação/efeito, policy version |
| `ledger_postings` | débitos e créditos | valor positivo, direção, FK, moeda e índices |

O repositório deve inserir o journal e seus postings na mesma Unit of Work e permitir consultas de reconciliação sem expor entidades ORM ao domínio.

### 4.3 Integridade

O domínio valida balanceamento antes do flush. A persistência deve impedir alterações/deleções de registros confirmados e proteger unicidades. Como balanceamento é uma propriedade entre linhas, a implementação deve escolher e documentar uma constraint trigger, uma função transacional ou uma verificação equivalente que não permita commit parcial.

### 4.4 Mapeamento financeiro

| Efeito | Débito | Crédito | Conta wallet |
|---|---|---|---|
| `OPENING` | `HOUSE_FUNDING` | `WALLET` | aumenta |
| `BET` | `WALLET` | `GAME_STAKE` | diminui |
| `WIN` | `GAME_PAYOUT` | `WALLET` | aumenta |
| `REFUND` de `BET` | `GAME_STAKE` | `WALLET` | aumenta |
| `ROLLBACK` | inversão exata dos postings referenciados | inversão exata | conforme efeito |
| `LOSS` | nenhum journal patrimonial | nenhum | não altera |

`REFUND`/`ROLLBACK` não poderão criar uma contrapartida nova quando a inversão exata da operação original for possível.

### 4.5 Backfill

O backfill deve criar as contas wallet, converter cada `WalletLedgerEntry` histórico em um journal balanceado e usar `LEGACY_COUNTERPARTY` quando a origem não contiver a conta econômica. A operação deve ser reexecutável, não alterar dados de negócio e produzir contagem de convertidos, ignorados e inconsistentes.

## 5. Fluxo transacional

Para HTTP e SQS, o fluxo será:

1. resolver idempotência e carregar a transação;
2. aplicar a regra financeira existente com lock/retry já aprovado;
3. criar ou manter o `WalletLedgerEntry` de compatibilidade;
4. resolver contas e construir um `JournalEntry` balanceado;
5. persistir journal e postings na mesma Unit of Work;
6. persistir Outbox e marcar Inbox, quando aplicável;
7. fazer commit;
8. responder ou fazer ack somente depois do commit.

Replay idêntico deve retornar o resultado existente sem inserir novo journal. Conflito de payload deve abortar sem novo efeito.

## 6. Testes

### Unitários

- soma exata de débitos/créditos por moeda;
- rejeição de journal incompleto, desbalanceado, negativo ou multi-moeda;
- imutabilidade de `Account`, `JournalEntry` e `Posting`;
- mapeamento de `OPENING`, `BET`, `WIN`, `REFUND` e `ROLLBACK`;
- `LOSS` sem journal patrimonial;
- reversão exata e política versionada;
- idempotência do builder contábil.

### Integração PostgreSQL

- migration up/down e constraints;
- persistência e consultas de journals/postings;
- impossibilidade de update/delete;
- balanceamento na mesma transação;
- backfill reexecutável e sem alteração de saldo;
- reconciliação detectando journal/posting inconsistente.

### Integração financeira e mensageria

- HTTP e SQS criam o mesmo resultado contábil;
- Inbox, wallet, transação, ledger, journal e Outbox têm atomicidade;
- replay, redelivery e retries não duplicam postings;
- crash antes do commit não deixa journal parcial;
- crash depois do commit preserva o journal para publicação/reprocessamento.

### Concorrência e regressão

- duas operações concorrentes na mesma wallet;
- três instâncias compartilhando PostgreSQL;
- reversões concorrentes;
- toda a suíte unitária, integração, resiliência e carga existente.

## 7. Fases de implementação

1. Confirmar baseline de entidades, migrations, repositórios e invariantes atuais.
2. Implementar contratos de domínio e política de contas.
3. Criar schema, constraints, índices e append-only.
4. Implementar persistência e builder transacional.
5. Integrar efeitos de abertura, BET, WIN e reversões.
6. Integrar projeção compatível e política de LOSS.
7. Implementar backfill e reconciliação contábil.
8. Executar testes de concorrência, falha, mensageria e regressão.
9. Auditar Spec ↔ plano ↔ tarefas ↔ código ↔ migrations ↔ evidências e aguardar aprovação final.

## 8. Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Criar uma segunda regra financeira | builder contábil recebe o efeito já aplicado e não recalcula saldo |
| Journal desbalanceado por commit parcial | Unit of Work única, validação de domínio e proteção no banco |
| Backfill inventar informação histórica | `LEGACY_COUNTERPARTY` explícita e relatório de limitação |
| Replay duplicar postings | unicidade por transação/efeito e testes de redelivery |
| Perder compatibilidade com consultas atuais | manter `WalletLedgerEntry` como projeção na primeira versão |
| `LOSS` alterar comportamento | sem journal patrimonial e teste de saldo inalterado |
| Conta errada por moeda | moeda em conta, journal e posting com validação cruzada |
| Correção silenciosa de inconsistência | reconciliação somente leitura e divergência bloqueadora |
| Migration irreversível | migration down testada em banco descartável e sem apagar dados externos |

## 9. Critérios para considerar o plano concluído

- FR-001 a FR-011 e AC-001 a AC-010 possuem tarefas e evidências objetivas.
- Journals e postings balanceiam exatamente por moeda.
- Saldo, ledger atual, statuses e contratos permanecem compatíveis.
- Replays, retries, redelivery e concorrência não duplicam efeitos.
- Backfill é idempotente e limita claramente o que não pode ser inferido.
- Reconciliação detecta desequilíbrio e divergência sem correção silenciosa.
- HTTP, SQS, Inbox e Outbox permanecem atômicos.
- Migrations, unitários, integração, resiliência e carga permanecem verdes.
- README e arquitetura não são alterados sem decisão explícita.
- Spec, plano e tarefas ficam marcados como aguardando aprovação final; nenhuma aprovação é inferida.
