# Spec da Feature — Ledger de partidas dobradas

Status: Implementação verificada — aguardando aprovação final  
Projeto: Distributed Wagering Processor  
Feature anterior: [`../12-teste-carga-capacidade/spec.md`](../12-teste-carga-capacidade/spec.md)  
Arquitetura: [`../../../ARCHITECTURE.md`](../../../ARCHITECTURE.md)  
README de referência: [`../../../README.md`](../../../README.md)  

> Esta feature implementa o diferencial opcional de ledger de partidas dobradas mencionado no README. Ela amplia a auditabilidade contábil sem alterar saldo, idempotência, contratos HTTP, semântica de `BET`, `WIN`, `LOSS`, `REFUND` ou `ROLLBACK`, nem as garantias de Inbox e Outbox.

## 1. Objetivo

Adicionar uma representação contábil imutável em que cada efeito financeiro seja registrado como um conjunto de lançamentos balanceados: a soma dos débitos deve ser igual à soma dos créditos dentro da mesma moeda e do mesmo lançamento contábil.

A feature deve permitir responder, para cada operação financeira que altera saldo:

- quais contas foram debitadas e creditadas;
- qual transação de negócio originou o lançamento;
- se o lançamento está balanceado por moeda;
- se o saldo da wallet continua igual ao saldo reconstruído;
- se um replay ou uma reversão criou algum segundo efeito;
- se os lançamentos históricos foram migrados sem alterar o resultado financeiro.

O ledger de partidas dobradas é uma camada de auditoria e consistência. Não é autorização contábil, não calcula impostos, não cria plano de contas regulatório e não substitui o domínio financeiro existente sem uma decisão posterior.

## 2. Como funciona hoje

O projeto já possui:

- `Money` com aritmética decimal exata;
- `Wallet` com saldo materializado e `version`;
- `WagerTransaction` com idempotência, referências e estados terminais;
- `WalletLedgerEntry` imutável, com `balanceBefore` e `balanceAfter`;
- regras para `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`;
- Inbox, Outbox transacional, publisher, reconciliação e testes de concorrência/resiliência;
- execução de carga e invariantes financeiras verificáveis.

O ledger atual é orientado à wallet: cada alteração de saldo pode possuir no máximo um lançamento para a wallet. Ele ainda não identifica explicitamente a conta de contrapartida nem exige igualdade entre débitos e créditos de um lançamento contábil.

## 3. Requisitos funcionais

### FR-001 — Representar lançamentos contábeis balanceados

O SISTEMA DEVE persistir um `JournalEntry` imutável para cada efeito financeiro que altera saldo. Um `JournalEntry` DEVE possuir um ou mais `Posting` de débito e um ou mais `Posting` de crédito, todos na mesma moeda, com totais iguais.

### FR-002 — Relacionar contabilidade e negócio

Cada lançamento contábil DEVE estar relacionado a exatamente uma transação financeira de negócio quando o efeito vier de `OPENING`, `BET`, `WIN`, `REFUND` ou `ROLLBACK`. A relação DEVE ser única e idempotente por `transactionId` e tipo de efeito.

### FR-003 — Preservar a semântica financeira atual

A adoção do ledger de partidas dobradas NÃO PODE alterar saldo final, `balanceBefore`, `balanceAfter`, status, códigos de rejeição, regras de referência, idempotência, retries, Inbox, Outbox ou respostas HTTP existentes.

### FR-004 — Definir contas e contrapartidas determinísticas

O sistema DEVE resolver a conta da wallet e a conta de contrapartida por uma política determinística, sem depender de estado apenas em memória. A política DEVE ser versionável e identificável no lançamento.

### FR-005 — Manter `LOSS` sem efeito de saldo

`LOSS` continua não alterando o saldo da wallet nem criando `WalletLedgerEntry`. O comportamento contábil de `LOSS` DEVE ser explicitamente definido antes da implementação: não gerar lançamento contábil por não haver efeito financeiro, ou gerar apenas um lançamento não patrimonial separado, sem tocar a wallet.

### FR-006 — Representar reversões como inversões

`REFUND` e `ROLLBACK` DEVEM criar postings que sejam a inversão exata dos postings do efeito referenciado, respeitando valor, moeda, conta e quantidade. Uma reversão repetida DEVE ser replay ou rejeição conforme a regra já aprovada, sem segundo efeito.

### FR-007 — Proteger imutabilidade e unicidade

Postings e journal entries DEVEM ser append-only. A aplicação não pode expor update/delete de lançamentos. O banco DEVE proteger, no mínimo, unicidade do journal, unicidade da relação com a transação/efeito e integridade dos valores positivos.

### FR-008 — Validar balanceamento por moeda

O domínio DEVE rejeitar journal entries com moedas misturadas, valor zero/negativo, apenas um lado contábil ou totais de débito e crédito diferentes. A validação DEVE ocorrer antes do commit e ser repetida na reconciliação.

### FR-009 — Migrar o ledger existente com segurança

A migration DEVE criar as tabelas e índices necessários sem apagar o ledger atual. O backfill DEVE ser determinístico, idempotente, reversível no nível de schema e não pode mudar saldo, versão, status ou timestamps de negócio.

### FR-010 — Integrar com transação, Inbox e Outbox

Quando uma operação vier por HTTP ou SQS, wallet, transação, `WalletLedgerEntry` compatível, `JournalEntry`, postings e Outbox DEVEM confirmar ou reverter na mesma Unit of Work financeira. O ack SQS continua posterior ao commit.

### FR-011 — Expor diagnóstico seguro

O sistema DEVE permitir verificar balanceamento, relação com a transação e divergências em testes/reconciliação. Qualquer consulta ou relatório não pode expor segredos, receipt handles ou payloads financeiros desnecessários.

## 4. Modelo de domínio proposto

### 4.1 `LedgerAccount`

Conta imutável identificada por `accountId`, `accountType`, `currency` e estado ativo. O catálogo mínimo sugerido é:

- `WALLET`: uma conta por wallet e moeda;
- `HOUSE_FUNDING`: contrapartida de `OPENING`;
- `GAME_STAKE`: contrapartida de `BET` e `ROLLBACK` de `BET`;
- `GAME_PAYOUT`: contrapartida de `WIN` e `ROLLBACK` de `WIN`;
- `REVERSAL_CLEARING`: contrapartida explícita quando a inversão não puder apontar diretamente para a conta original.

O catálogo não deve ser inferido pelo nome livre de uma operação. Cada conta deve ter uma chave estável, moeda explícita e origem auditável.

### 4.2 `JournalEntry`

```ts
class JournalEntry {
  private constructor(
    public readonly id: string,
    public readonly transactionId: string,
    public readonly effectType: string,
    public readonly currency: Currency,
    public readonly policyVersion: string,
    public readonly occurredAt: Date,
    public readonly postings: readonly Posting[],
  ) {}

  static create(props: CreateJournalEntryProps): JournalEntry;
  static rehydrate(state: JournalEntryState): JournalEntry;

  isBalanced(): boolean;
  reversedEntryId(): string | undefined;
}
```

`create` deve validar que há pelo menos um débito e um crédito, que todos os postings usam a moeda do journal e que os totais são exatamente iguais usando `Money`, nunca `number` para dinheiro.

### 4.3 `Posting`

```ts
enum PostingDirection { Debit = "DEBIT", Credit = "CREDIT" }

interface Posting {
  readonly id: string;
  readonly journalEntryId: string;
  readonly accountId: string;
  readonly walletId?: string;
  readonly direction: PostingDirection;
  readonly money: Money;
  readonly createdAt: Date;
}
```

Um posting não possui transição de estado. O valor é sempre positivo; a direção representa o lado contábil, e não um sinal armazenado no valor.

### 4.4 Mapeamento inicial dos efeitos

O mapeamento recomendado é:

| Efeito | Débito | Crédito | Efeito na wallet |
|---|---|---|---|
| `OPENING` | `HOUSE_FUNDING` | `WALLET` | aumenta |
| `BET` | `WALLET` | `GAME_STAKE` | diminui |
| `WIN` | `GAME_PAYOUT` | `WALLET` | aumenta |
| `REFUND` de `BET` | `GAME_STAKE` | `WALLET` | aumenta |
| `ROLLBACK` de `BET` | inversão exata do `BET` | inversão exata do `BET` | aumenta |
| `ROLLBACK` de `WIN` | inversão exata do `WIN` | inversão exata do `WIN` | diminui |
| `LOSS` | decisão aberta | decisão aberta | não altera |

A tabela é uma proposta de domínio, não uma decisão contábil regulatória. O plano de implementação deve transformar a política aprovada em uma porta/configuração testável.

## 5. PostgreSQL e migração

### 5.1 Tabelas sugeridas

`ledger_accounts`:

- `id` UUID/UUIDv7 como chave primária;
- `account_key` estável e único;
- `account_type`, `currency`, `wallet_id` opcional;
- `policy_version`, `created_at`, `active`;
- `UNIQUE(account_key)` e, para contas de wallet, `UNIQUE(wallet_id, currency, account_type)`.

`ledger_journal_entries`:

- `id` UUID/UUIDv7;
- `transaction_id` FK para `wager_transactions`;
- `effect_type`, `currency`, `policy_version`, `occurred_at`, `created_at`;
- `UNIQUE(transaction_id, effect_type)`;
- sem `UPDATE`/`DELETE` no fluxo da aplicação.

`ledger_postings`:

- `id` UUID/UUIDv7;
- `journal_entry_id` FK para `ledger_journal_entries`;
- `account_id` FK para `ledger_accounts`;
- `wallet_id` opcional para acelerar consultas e validar a conta;
- `direction`, `amount NUMERIC(19,2)`, `currency`, `created_at`;
- `CHECK(amount > 0)` e índices por journal, account, wallet e transaction.

A igualdade agregada entre débitos e créditos deve ser garantida pelo domínio dentro da Unit of Work e validada por uma constraint trigger, procedimento transacional ou verificação equivalente. Um `CHECK` por linha não é suficiente para garantir balanceamento entre várias linhas.

### 5.2 Backfill histórico

O backfill deve:

1. criar contas `WALLET` para wallets existentes;
2. criar uma conta de contrapartida legada por moeda, marcada como `LEGACY_COUNTERPARTY`;
3. converter cada `WalletLedgerEntry` existente em um journal entry balanceado, preservando valor, direção e timestamp original;
4. relacionar o journal à transação original e marcar `policy_version = legacy-v1`;
5. não criar postings para `LOSS` ou transações sem efeito de saldo;
6. ser seguro para reexecução por chave natural e produzir relatório de linhas ignoradas/ambíguas;
7. bloquear o corte se houver saldo/ledger inconsistente antes do backfill.

O backfill não pode inventar a conta econômica real quando o histórico não a contém. A contrapartida legada deve deixar essa limitação explícita no diagnóstico.

## 6. Concorrência, idempotência e reversões

- A wallet continua sendo a unidade de concorrência e o optimistic locking existente permanece obrigatório.
- O retry de concorrência não pode criar um segundo journal ou postings; a unicidade deve tornar a operação idempotente também no ledger dobrado.
- Replay com payload igual retorna o resultado persistido e não insere postings.
- Conflito de idempotência não insere journal, postings ou Outbox.
- Uma reversão deve carregar a referência original e sua política contábil; não pode ser aceita se o efeito original não estiver `PROCESSED`.
- `REFUND` e `ROLLBACK` continuam sujeitos às regras de valor, provider, player, wallet, moeda e rodada já existentes.
- Crash antes do commit não deixa journal parcial; crash depois do commit deixa o journal completo e recuperável.

## 7. Relatórios e reconciliação

A reconciliação deve acrescentar, sem quebrar a resposta atual:

- total de journals e postings verificados;
- journals desbalanceados por moeda;
- postings sem conta ou sem transação compatível;
- divergência entre saldo da wallet e postings da conta `WALLET`;
- journals duplicados por transação/efeito;
- linhas históricas convertidas e linhas não convertidas no backfill.

Nenhuma divergência deve ser corrigida silenciosamente. O resultado deve ser `consistent` ou `inconsistent`, com códigos estáveis e sem payload financeiro completo em logs.

## 8. Critérios de aceite

### AC-001 — Journal balanceado

Dado um efeito financeiro suportado, quando o commit ocorrer, então o journal terá débitos e créditos na mesma moeda com totais exatamente iguais.

### AC-002 — Sem alteração de semântica

Dado o mesmo conjunto de operações das features anteriores, então saldos, status, versões, códigos e respostas permanecem iguais antes e depois da ativação do ledger dobrado.

### AC-003 — Idempotência contábil

Dado um replay ou retry da mesma operação, então haverá no máximo um journal e um conjunto de postings para aquele efeito.

### AC-004 — Reversão exata

Dado um `REFUND` ou `ROLLBACK` válido, então seus postings serão a inversão exata do efeito referenciado e a reversão repetida não criará segundo efeito.

### AC-005 — Concorrência segura

Dadas duas operações concorrentes sobre a mesma wallet, então as regras atuais de saldo e optimistic locking permanecem válidas e não haverá journal duplicado ou desbalanceado.

### AC-006 — Imutabilidade

Dada uma tentativa de alterar ou excluir journal/posting já confirmado, então o banco ou a aplicação rejeitará a operação e o registro original permanecerá intacto.

### AC-007 — Backfill auditável

Dado um banco com ledger histórico consistente, então o backfill será reexecutável, produzirá journals balanceados e não mudará saldo, versão, status ou timestamps do negócio.

### AC-008 — Falha atômica

Dado um erro antes do commit, então wallet, transação, ledger antigo, journal, postings e Outbox serão revertidos juntos.

### AC-009 — Reconciliação dobrada

Dado um journal ou posting inconsistente, então a reconciliação detectará e classificará a divergência sem corrigi-la silenciosamente.

### AC-010 — Multi-instância

Dado o processamento por HTTP e SQS em três instâncias, então a unicidade e o balanceamento permanecerão protegidos por PostgreSQL, sem garantia apenas em memória.

## 9. Casos de erro e edge cases

- débito e crédito em moedas diferentes;
- journal com apenas um lado ou totais diferentes;
- valor zero, negativo, científico ou com precisão inválida;
- conta inexistente, inativa ou incompatível com a moeda;
- wallet sem conta contábil durante processamento;
- replay concorrente criando dois journals;
- reversão sem referência, referência incompatível ou já revertida;
- falha entre inserção do journal e postings;
- tentativa de update/delete em registro imutável;
- migration executada duas vezes;
- backfill com ledger histórico divergente;
- `LOSS` sem efeito contábil conforme decisão aprovada;
- falha de publicação da Outbox depois do commit;
- crash antes do commit e redelivery SQS depois do reinício.

## 10. Fora de escopo

- plano de contas regulatório, IFRS/GAAP ou aconselhamento contábil;
- impostos, taxas, comissão, câmbio ou múltiplas moedas na mesma operação;
- fechamento contábil, períodos fiscais ou lançamentos de ajuste manuais;
- edição, exclusão ou correção silenciosa de journals;
- novo endpoint público obrigatório para consultar postings;
- autenticação, autorização ou segregação de funções;
- alteração das regras de `LOSS`, referências, retry, DLQ, Inbox ou Outbox sem decisão explícita;
- teste de produção, soak test ou meta comercial de capacidade.

## 11. Perguntas abertas

1. O catálogo mínimo deve usar as cinco contas propostas (`WALLET`, `HOUSE_FUNDING`, `GAME_STAKE`, `GAME_PAYOUT`, `REVERSAL_CLEARING`) ou o produto exige contas por provedor/jogo?
2. Para `LOSS`, devemos manter ausência total de lançamento, preservando a semântica atual, ou registrar um journal não patrimonial separado?
3. O `WalletLedgerEntry` atual deve continuar como projeção de compatibilidade ou ser substituído diretamente por uma consulta aos postings?
4. O backfill histórico com `LEGACY_COUNTERPARTY` é aceitável quando a contrapartida econômica não existe no banco?
5. A primeira entrega precisa de consulta HTTP de journals/postings ou testes/reconciliação internos são suficientes?
6. O journal deve ser criado somente para efeitos que alteram saldo ou também para operações rejeitadas e `LOSS` como fatos auditáveis sem efeito patrimonial?

## 12. Sugestões para aprovação

- [x] Aprovar catálogo mínimo por moeda, com uma conta `WALLET` por wallet e contas sistêmicas fixas.
- [x] Aprovar que `LOSS` permaneça sem journal patrimonial na primeira versão, mantendo o contrato financeiro existente.
- [x] Aprovar `WalletLedgerEntry` como projeção compatível durante a migração, com postings como fonte contábil adicional.
- [x] Aprovar backfill determinístico usando `LEGACY_COUNTERPARTY`, com limitação explícita no relatório.
- [x] Aprovar ausência de endpoint público novo nesta primeira entrega; reconciliação e testes verificam os postings.
- [x] Aprovar migrations reversíveis e append-only, com constraint trigger ou verificação transacional de balanceamento.
- [x] Aprovar que qualquer divergência contábil seja bloqueadora, mesmo que o saldo materializado pareça correto.

## 13. Definition of Done

- [x] Spec, plano e tarefas foram revisados e aprovados antes da implementação.
- [x] Catálogo de contas e política de `LOSS` estão decididos e documentados.
- [x] Journal e postings possuem modelo de domínio imutável e testes unitários.
- [x] Migration cria constraints, índices e política de append-only.
- [x] `BET`, `WIN`, `OPENING`, `REFUND` e `ROLLBACK` geram postings balanceados na mesma Unit of Work.
- [x] Replay, retry, concorrência e redelivery não duplicam journals ou efeitos financeiros.
- [x] Backfill é idempotente, auditável e preserva o estado financeiro existente.
- [x] Reconciliação detecta desequilíbrio, divergência de wallet e referências inválidas.
- [x] Integração HTTP, SQS, Inbox e Outbox permanece verde.
- [x] Testes com três instâncias e falhas entre commit/publicação passam.
- [x] Nenhum lançamento confirmado pode ser alterado ou excluído pelo fluxo normal.
- [x] README e `ARCHITECTURE.md` só serão alterados mediante decisão explícita desta feature.
- [ ] A aprovação final foi registrada antes de considerar a feature concluída.
