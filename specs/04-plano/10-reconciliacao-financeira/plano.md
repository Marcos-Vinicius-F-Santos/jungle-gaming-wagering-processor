# Plano de Implementação — Reconciliação financeira da wallet

Spec relacionada: [`../../03-features/10-reconciliacao-financeira/spec.md`](../../03-features/10-reconciliacao-financeira/spec.md)  
Arquitetura relacionada: [`../../02-arquitetura/arquitetura.md`](../../02-arquitetura/arquitetura.md)  
Produto relacionado: [`../../01-produto/spec.md`](../../01-produto/spec.md)  
Feature anterior: [`../09-consultas-ledger-transacoes/plano.md`](../09-consultas-ledger-transacoes/plano.md)  
Status: Rascunho — aguardando aprovação formal do plano e tarefas

## 1. Resumo técnico

Implementar uma verificação somente leitura que compare o saldo materializado de uma wallet com o saldo reconstruído a partir de todos os lançamentos do ledger.

A feature terá uma entrada pública:

```http
POST /wallets/:walletId/reconciliation
```

O caso de uso receberá um snapshot consistente de wallet e ledger, calculará o saldo por direção usando decimal exato, validará a cadeia `balanceBefore`/`balanceAfter`, calculará a diferença assinada e retornará `consistent` e `issues`. Divergências serão respostas de negócio `200 OK`; falhas que impeçam confirmar o snapshot serão `503`.

## 2. Decisões aplicadas

- O módulo será separado em `src/modules/reconciliation/`, sem mover regras de wallet ou wagering.
- A consulta será encapsulada em um port próprio de snapshot; o controller não acessará `EntityManager` nem repositories concretos.
- Wallet e ledger serão lidos em uma transação PostgreSQL `READ ONLY` com isolamento `REPEATABLE READ`, ou adapter equivalente que garanta o mesmo snapshot.
- A consulta não usará locks de escrita, não alterará estado e não impedirá processamento concorrente.
- O ledger será ordenado por `created_at ASC, id ASC` para reconstrução determinística.
- O saldo calculado será `soma(CREDIT) - soma(DEBIT)` iniciando em `0.00`.
- A cadeia será validada por lançamento, entre lançamentos e contra o saldo materializado.
- Saldos e valores de lançamento usarão `Money`; `difference` será decimal assinado exato, pois pode ser negativa.
- Divergência de dados retornará `200 OK` com `consistent: false` e códigos `issues` estáveis.
- Falha de leitura, timeout ou indisponibilidade retornará `503 RECONCILIATION_UNAVAILABLE`.
- O contrato incluirá `issues`, sempre deduplicado e ordenado de forma determinística.
- Métricas usarão `wallet_reconciliations_total`, `wallet_reconciliation_entries_checked_total` e `wallet_reconciliation_duration_ms`, sem IDs em tags.
- Não será criada migration; o schema atual já contém os dados necessários.
- Não serão alterados `README.md`, regras financeiras, Inbox, Outbox, SQS ou workers.

## 3. Baseline e impacto

O sistema já possui `Wallet`, `WalletLedgerEntry`, repositories de wallet/ledger, constraints de imutabilidade e `Money`. Ainda não existe módulo de reconciliação nem uma leitura que obtenha wallet e ledger no mesmo snapshot. O repository de ledger existente reidrata entidades de domínio e não deve ser reutilizado para detectar corrupção persistida, pois suas factories podem rejeitar dados antes de a reconciliação classificar o problema.

| Componente | Mudança planejada | Risco |
|---|---|---|
| `src/modules/reconciliation/application/ports/` | Criar snapshot read model e port de query | Médio; preservar separação da escrita |
| `src/modules/reconciliation/application/` | Criar cálculo, validação da cadeia e caso de uso | Alto; precisão, sinal da diferença e códigos determinísticos |
| `src/modules/reconciliation/infrastructure/` | Implementar snapshot PostgreSQL/MikroORM | Alto; manter wallet e ledger no mesmo snapshot |
| `src/modules/reconciliation/http/` | Criar controller, contrato e mapper | Médio; mapear 400/404/503 sem vazamento |
| `src/modules/reconciliation/reconciliation.module.ts` | Registrar adapters e casos de uso | Médio; não alterar providers financeiros existentes |
| `src/shared/application/ports/` | Reutilizar logger/métricas existentes | Baixo; falha de métrica não pode falhar o negócio |
| `test/unit/` | Cobrir cálculo, cadeia, diferença, issues e HTTP | Médio |
| `test/integration/` | Validar PostgreSQL, snapshot, concorrência e ausência de mutação | Alto |
| `src/infrastructure/database/migrations/` | Nenhuma alteração estrutural | Baixo; confirmar schema e registrar decisão |

## 4. Contratos e desenho técnico

### Snapshot de reconciliação

Criar um port próprio, com read models imutáveis, aproximadamente:

```ts
interface ReconciliationLedgerEntrySnapshot {
  readonly id: string;
  readonly direction: 'CREDIT' | 'DEBIT';
  readonly amount: string;
  readonly currency: string;
  readonly balanceBefore: string;
  readonly balanceAfter: string;
  readonly createdAt: Date;
}

interface ReconciliationSnapshot {
  readonly walletId: string;
  readonly currency: string;
  readonly storedBalance: string;
  readonly entries: readonly ReconciliationLedgerEntrySnapshot[];
}

interface ReconciliationQueryRepository {
  findSnapshot(walletId: string): Promise<ReconciliationSnapshot | null>;
}
```

O adapter deve ler somente as colunas necessárias, ordenar por `created_at ASC, id ASC` e retornar dados brutos de leitura sem reidratar `WalletLedgerEntry` para executar regras financeiras. A ausência da wallet retorna `null`; erro de infraestrutura sobe como falha normalizada.

### Snapshot transacional

O adapter deve abrir uma transação de leitura com `READ ONLY` e `REPEATABLE READ`, consultar a wallet e o ledger no mesmo contexto e encerrá-la antes de retornar o read model. Não deve usar `FOR UPDATE`, `flush`, `persist`, `nativeUpdate`, publish ou alteração de visibilidade.

Se o driver/ORM não suportar a configuração diretamente no repository, criar uma porta de contexto de snapshot ou adapter equivalente, documentando a garantia testada no PostgreSQL.

### Calculador

Separar a regra determinística do acesso ao banco em um componente testável, por exemplo `ReconciliationCalculator`:

1. inicializar o acumulado em `0.00` na moeda da wallet;
2. verificar direção, moeda, valores e saldos do lançamento;
3. validar a aritmética individual;
4. validar `balanceBefore` do primeiro lançamento e a transição entre itens;
5. adicionar créditos e subtrair débitos;
6. comparar o último saldo e o acumulado com o saldo materializado;
7. deduplicar e ordenar `issues`;
8. produzir `calculatedBalance`, `difference`, `consistent` e `checkedEntries`.

Valores negativos só são permitidos na representação de `difference`; saldos e valores de lançamentos continuam não negativos conforme o domínio/schema.

### Caso de uso

O `ReconcileWalletUseCase` deve:

- validar o UUID antes de chamar o port, quando usado fora do `ParseUUIDPipe`;
- solicitar um único snapshot;
- mapear ausência para `WalletNotFoundError`;
- delegar o cálculo ao componente puro;
- registrar outcome, duração e quantidade verificada;
- registrar divergência com códigos seguros e `walletId` apenas no contexto de log;
- nunca iniciar processamento financeiro nem persistir resultado.

### HTTP

O controller de reconciliação deve:

- usar `@Controller('wallets')` e `@Post(':walletId/reconciliation')` ou composição equivalente;
- usar `ParseUUIDPipe`;
- retornar o read model com strings decimais e `issues`;
- mapear `WalletNotFoundError` para `404 { code: 'WALLET_NOT_FOUND' }`;
- mapear falha de infraestrutura para `503 { code: 'RECONCILIATION_UNAVAILABLE' }`;
- não acessar banco diretamente;
- preservar correlação e logger existentes.

### Métricas e logs

Emitir duração mesmo em erro, com tags `outcome` e, quando aplicável, `issue` agregada em dimensão controlada. Não usar `walletId`, IDs de ledger ou valores como tags. Falha de métricas deve ser tolerada.

Logs de divergência devem conter evento, `walletId`, `checkedEntries`, `issues`, `correlationId` e valores normalizados somente quando necessários; nunca payload bruto, secrets ou stack trace como resposta HTTP.

## 5. Sequência de implementação

### Fase 1 — Baseline e contratos

1. Confirmar entidades, constraints, ordenação e limites do schema atual.
2. Criar read models, port de snapshot e tipos de `issues`.
3. Definir o contrato de resposta e a representação decimal assinada de `difference`.

### Fase 2 — Cálculo de domínio da reconciliação

1. Implementar cálculo por direção com precisão exata.
2. Implementar validações de aritmética, moeda, primeiro saldo e cadeia.
3. Implementar deduplicação/ordenação determinística dos códigos.
4. Cobrir o calculador com testes unitários antes do adapter.

### Fase 3 — Persistência e caso de uso

1. Implementar snapshot PostgreSQL/MikroORM em transação read-only repeatable read.
2. Criar caso de uso, erros de aplicação e instrumentação.
3. Registrar providers no módulo de reconciliação sem alterar os módulos financeiros.

### Fase 4 — HTTP

1. Criar controller, mapper e mapeamento de erros.
2. Integrar o módulo ao `AppModule`.
3. Testar contrato para resultado consistente, divergente, wallet inexistente e indisponibilidade.

### Fase 5 — Integração e regressão

1. Validar PostgreSQL real com wallet zero, `OPENING`, operações e divergência controlada.
2. Validar leitura sob processamento concorrente e snapshot completo.
3. Confirmar ausência de efeitos colaterais em wallet, ledger, transações, Inbox e Outbox.
4. Executar typecheck, build e regressão completa.

### Fase 6 — Verificação e entrega

1. Auditar contratos, issues, logs, métricas e ausência de migration.
2. Preencher evidências Spec ↔ Plano ↔ Código ↔ Testes.
3. Atualizar status dos documentos para implementação verificada aguardando aprovação, sem aprovar automaticamente.

## 6. Riscos e mitigação

| Risco | Severidade | Mitigação |
|---|---:|---|
| Wallet e ledger lidos em snapshots diferentes | Crítica | Transação read-only `REPEATABLE READ` e teste concorrente real |
| `difference` negativa incompatível com `Money` atual | Alta | Read model decimal assinado separado; Money permanece para saldos |
| Factory do domínio esconder ledger corrompido | Alta | Snapshot raw read model; cálculo classifica issues sem reidratação financeira |
| Soma ou diferença usar ponto flutuante | Crítica | Decimal exato, strings e testes de valores grandes/negativos |
| Corrigir divergência acidentalmente | Crítica | Port somente leitura, sem Unit of Work de escrita e snapshots antes/depois |
| Cadeia de lançamentos não ser determinística | Alta | Ordem `created_at ASC, id ASC` e testes de timestamps iguais |
| Divergência virar erro HTTP indevido | Média | `200` para resultado calculado e `503` somente para leitura não confirmada |
| IDs vazarem em métricas | Média | Tags fixas e IDs somente em logs sanitizados |
| Regressão nos módulos financeiros | Alta | Módulo isolado, integração e suíte completa |

## 7. Critérios de aprovação do plano

- Cada tarefa referencia FRs/BRs/ACs e possui verificação objetiva.
- O snapshot usa uma garantia explícita de consistência no PostgreSQL.
- O cálculo é puro, determinístico e não usa ponto flutuante.
- `difference` suporta valores negativos sem alterar o contrato de `Money`.
- Divergências são respostas `200` sinalizadas; falhas de leitura são `503`.
- O controller não acessa banco diretamente e o caso de uso não chama processamento financeiro.
- Nenhuma tarefa altera saldo, ledger, transação, Inbox, Outbox ou SQS.
- Não há migration sem necessidade comprovada.
- Testes unitários cobrem todos os códigos de issue relevantes.
- Testes de integração usam PostgreSQL real para consistência, divergência e concorrência.
- A regressão das features anteriores passa antes da entrega.
- O README permanece inalterado.
- O status final permanece aguardando aprovação do usuário.

## 8. Evidências da implementação

Preencher durante a execução das tarefas, relacionando cada evidência aos AC-001..AC-013. A aprovação do plano não aprova automaticamente a implementação ou a entrega final.
