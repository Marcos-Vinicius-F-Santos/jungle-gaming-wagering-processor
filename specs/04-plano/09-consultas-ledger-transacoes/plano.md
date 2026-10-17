# Plano de Implementação — Consultas de ledger e transações

Spec relacionada: [`../../03-features/09-consultas-ledger-transacoes/spec.md`](../../03-features/09-consultas-ledger-transacoes/spec.md)  
Arquitetura relacionada: [`../../02-arquitetura/arquitetura.md`](../../02-arquitetura/arquitetura.md)  
Produto relacionado: [`../../01-produto/spec.md`](../../01-produto/spec.md)  
Feature anterior: [`../08-observabilidade-saude/plano.md`](../08-observabilidade-saude/plano.md)  
Status: Implementação verificada — aguardando aprovação final

## 1. Resumo técnico

Implementar consultas HTTP somente leitura para o histórico de ledger de uma wallet e para transações persistidas. A feature terá três entradas públicas:

1. `GET /wallets/:walletId/ledger`, paginado por cursor keyset;
2. `GET /wagering/transactions/:transactionId`;
3. `GET /providers/:providerId/wagering/transactions/:externalTransactionId`.

As consultas serão separadas dos casos de uso financeiros de escrita por portas/read models próprios. O ledger será ordenado por `createdAt DESC, id DESC`, com cursor Base64URL, `limit` padrão 50 e máximo 100. A leitura por transaction ID e por identidade externa retornará todos os estados persistidos, sem replay, retry ou mutação.

## 2. Decisões aplicadas

- O read model não expõe `payloadHash`, payload bruto ou `idempotencyKey` por padrão.
- Wallet inexistente retorna `404`; wallet existente sem lançamentos retorna página vazia com `200`.
- Cursor incompatível com a wallet da URL retorna `400`.
- O cursor é Base64URL, contém escopo de `walletId` e representa `(createdAt, id)` na ordenação descendente; seu formato é interno e não constitui autorização.
- `limit` usa padrão 50, mínimo 1 e máximo 100.
- Será criada migration reversível com índice `(wallet_id, created_at DESC, id DESC)`.
- Consultas externas usam a chave completa `(providerId, externalTransactionId)`.
- A consulta por transaction ID cobre `OPENING`, `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK` e todos os estados persistidos.
- Erros terão códigos seguros `INVALID_CURSOR`, `INVALID_LIMIT`, `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND` e `READ_UNAVAILABLE`, alinhados ao formato HTTP existente.
- A leitura usará o comportamento padrão `READ COMMITTED` por request; o cursor garante progresso, não snapshot histórico.
- Métricas de leitura usarão `read_queries_total` e `read_query_duration_ms`, com `operation` e `outcome` de baixa cardinalidade.
- A ordenação e o cursor usarão UTC e não converterão timezone local.
- Reconciliação, filtros adicionais, cache, exportações, autenticação artesanal e alterações no README ficam fora do escopo.

## 3. Baseline e impacto

O sistema já possui persistência de wallets, ledger e transações, mas o ledger só tem uma leitura completa por wallet e o repository de transações ainda não oferece um read model geral para consulta HTTP. O controller de wallets expõe somente saldo e versão.

| Componente | Mudança planejada | Risco |
|---|---|---|
| `src/modules/wallets/application/ports/` | Criar contrato de query paginada do ledger | Médio; não quebrar o port de escrita usado por criação/processamento |
| `src/modules/wallets/infrastructure/persistence/` | Implementar keyset query e mapper de leitura | Alto; preservar ordem, precisão e isolamento por wallet |
| `src/modules/wagering/application/ports/` | Criar query port para ID e provider/external ID | Médio; não reutilizar métodos de escrita com efeitos colaterais |
| `src/modules/wagering/infrastructure/persistence/` | Retornar read model de qualquer kind/status | Alto; não reidratar `OPENING` como se fosse a única transação |
| `src/modules/wallets/http/` | Adicionar DTO/query validation e endpoint de ledger | Médio; mapear cursor e erros sem acesso ao banco |
| `src/modules/wagering/http/` | Adicionar endpoints de consulta de transação | Médio; preservar contratos de processamento existentes |
| `src/infrastructure/database/migrations/` | Criar índice de paginação reversível | Baixo; validar custo e plano de execução |
| `src/shared/`/observabilidade | Instrumentar duração/outcome sem IDs em tags | Baixo; métricas não podem influenciar leitura |
| `test/unit/` | Cobrir cursor, mappers, validação, casos de uso e erros | Médio |
| `test/integration/` | Validar PostgreSQL real, paginação, precisão e ausência de mutação | Alto |

O `README.md` não será alterado.

## 4. Contratos e desenho técnico

### Cursor

Criar um codec de cursor determinístico e validado, preferencialmente atrás de uma porta de aplicação. O valor serializado conterá `walletId`, `createdAt` em ISO UTC e `id` UUID. O codec deve:

- codificar em Base64URL sem padding;
- rejeitar JSON inválido, campos ausentes, data inválida ou UUID inválido;
- limitar o tamanho do cursor recebido;
- validar que o cursor pertence à wallet consultada antes de retornar itens;
- não lançar detalhes internos na camada HTTP.

O cursor de resposta será gerado somente quando a query buscar `limit + 1` itens e existir próxima página.

### Query port do ledger

Criar um port separado do `LedgerRepository` de escrita, com retorno de uma página imutável, por exemplo:

```ts
interface LedgerPage {
  readonly items: readonly LedgerEntryReadModel[];
  readonly hasNextPage: boolean;
}

interface LedgerQueryRepository {
  findPage(walletId: string, cursor: LedgerCursor | undefined, limit: number): Promise<LedgerPage>;
}
```

O adapter MikroORM deve usar o manager de leitura já adotado, selecionar apenas colunas necessárias e ordenar por `created_at DESC, id DESC`. Não deve carregar entidade mutável para executar regras financeiras.

### Query port de transações

Criar port próprio para o read model:

```ts
interface WagerTransactionQueryRepository {
  findById(id: string): Promise<WagerTransactionReadModel | null>;
  findByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionReadModel | null>;
}
```

O mapper deve preservar os campos persistidos de todos os kinds/status, converter datas para cópias seguras e manter dinheiro como strings. Não deve expor `payloadHash`, payload bruto ou `idempotencyKey` sem decisão posterior explícita.

### Casos de uso

Criar casos de uso de leitura para:

- listar ledger de uma wallet;
- obter transação por ID;
- obter transação por provider/external ID.

O caso de uso de ledger deve validar wallet existente, `limit` e cursor antes da query. O caso de uso de transação deve validar identificadores e apenas mapear ausência para erro de aplicação. Nenhum caso de uso deve chamar `ProcessWagerTransactionUseCase`.

### HTTP

Os controllers devem:

- usar `ParseUUIDPipe` ou DTOs equivalentes;
- validar `limit` como inteiro e aplicar padrão/máximo;
- devolver `nextCursor: null` quando não houver próxima página;
- mapear erros para 400/404/503 sem vazar infraestrutura;
- preservar o middleware de correlação da feature anterior;
- não acessar `EntityManager`, repositories concretos ou AWS SDK.

### Persistência

Adicionar migration reversível:

```sql
create index wallet_ledger_entries_wallet_created_id_idx
  on wallet_ledger_entries (wallet_id, created_at desc, id desc);
```

O índice de provider/external ID existente deve ser reutilizado. Não serão removidas constraints de imutabilidade, unicidade ou foreign keys.

### Observabilidade

Cada query deve registrar:

- `read_queries_total{operation,outcome}`;
- `read_query_duration_ms{operation,outcome}`;
- logs estruturados com `correlationId` e identificadores operacionais apenas quando necessários.

IDs não serão tags. Falha do adapter de métricas não pode transformar uma leitura em erro financeiro.

## 5. Sequência de implementação

### Fase 1 — Contratos e cursor

1. Confirmar baseline das entidades, repositories e controllers atuais.
2. Criar read models, ports e tipos de cursor.
3. Implementar codec/validação do cursor e limites.

### Fase 2 — Persistência de leitura

1. Criar migration do índice composto do ledger.
2. Implementar query paginada com keyset e ordem determinística.
3. Implementar query de transações por ID e provider/external ID.
4. Garantir que o mapper cubra `OPENING` e todos os estados sem efeitos colaterais.

### Fase 3 — Aplicação e HTTP

1. Criar casos de uso de consulta.
2. Criar DTOs/query params e mapeamento de erros.
3. Expor o endpoint de ledger.
4. Expor os dois endpoints de transação.
5. Adicionar métricas e logs de baixa cardinalidade.

### Fase 4 — Testes

1. Testar codec, limites, cursor de outra wallet e mappers.
2. Testar casos de uso e controllers sem infraestrutura real.
3. Testar paginação, precisão, todos os status e consultas por provider com PostgreSQL real.
4. Confirmar que consultas não alteram tabelas ou mensagens.

### Fase 5 — Verificação e entrega

1. Executar typecheck, build e testes unitários.
2. Executar integração com Docker/PostgreSQL.
3. Executar regressão completa dos fluxos financeiros, SQS, Outbox, referências e health.
4. Atualizar evidências e status sem aprovar a feature automaticamente.

## 6. Riscos e mitigação

| Risco | Severidade | Mitigação |
|---|---:|---|
| Paginação repetir ou pular itens | Crítica | Keyset por `(createdAt, id)`, ordem idêntica no SQL/cursor e testes com timestamps iguais |
| Cursor de uma wallet acessar outra | Crítica | Cursor sempre aplicado junto ao `walletId` e validação explícita de escopo |
| Consulta alterar estado financeiro | Crítica | Query ports separados, sem Unit of Work de escrita, testes antes/depois |
| `OPENING` ser perdido ou mapeado como operação externa | Alta | Mapper geral baseado na entidade persistida e teste específico de `OPENING` |
| Dinheiro virar ponto flutuante | Crítica | DTOs string, `Money` somente para leitura quando necessário e testes de precisão |
| IDs vazarem em tags | Média | Tags fixas `operation`/`outcome`, IDs somente em logs sanitizados |
| Índice não ser usado | Média | Migration reversível, `EXPLAIN` em integração e consulta sem `COUNT(*)` |
| Falha do banco expor detalhes | Alta | Códigos de erro estáveis e normalização no controller |
| Novo controller quebrar processamento existente | Alta | Módulos separados, typecheck e regressão completa |

## 7. Critérios de aprovação do plano

- Cada tarefa referencia FRs/BRs/ACs e possui verificação objetiva.
- Nenhuma tarefa modifica regras de escrita ou altera o README.
- O cursor é opaco, determinístico, validado e limitado à wallet da URL.
- A query do ledger usa índice/ordenação compatíveis com keyset pagination.
- A query de transações cobre todos os kinds/status persistidos.
- Controllers não acessam banco diretamente.
- Consultas não executam `flush`, retry, publish, delete ou alteração de visibilidade.
- Erros e logs não expõem SQL, payload bruto, hash, segredo ou stack trace.
- Testes de integração usam PostgreSQL real para paginação, precisão e ausência de mutação.
- Regressão dos fluxos anteriores passa antes da entrega.
- O status permanece aguardando aprovação final até revisão do usuário.

## 8. Evidências da implementação

Preencher durante a execução das tarefas, relacionando cada evidência aos AC-001..AC-015. A aprovação da Spec não aprova automaticamente o plano, a implementação ou a entrega final.
