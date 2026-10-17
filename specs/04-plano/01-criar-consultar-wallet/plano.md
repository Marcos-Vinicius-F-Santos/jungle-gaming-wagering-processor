# Plano de Implementação — Criar e consultar Wallet com saldo inicial

Spec relacionada: [`specs/03-features/01-criar-consultar-wallet/spec.md`](../../03-features/01-criar-consultar-wallet/spec.md)
Arquitetura relacionada: [`specs/02-arquitetura/arquitetura.md`](../../02-arquitetura/arquitetura.md)
Status: Concluído e aprovado por Marcos em 2026-10-15

Escopo desta rodada: fases 1 a 5. A fase 06 de deploy não existe por enquanto, pois o projeto não possui Git nem fluxo de deploy configurado.

## 1. Resumo técnico

Implementar uma fatia vertical de wallets usando MikroORM e PostgreSQL. A criação deve validar UUID, moeda ISO-4217 e `Money`, persistir wallet e, quando o saldo for positivo, criar `OPENING` e um único crédito no ledger na mesma transação SQL. A consulta deve retornar saldo materializado e versão.

A garantia de duplicidade será feita por `UNIQUE(player_id, currency)` no banco, com mapeamento do conflito para `409`. O saldo será persistido como `NUMERIC(19,2)` e a moeda em coluna separada. IDs internos serão UUIDv7. Esta feature não implementa operações de aposta, SQS, Inbox, Outbox, autenticação ou consulta pública paginada do ledger.

## 2. Impacto no que já existe

O projeto é greenfield e não possui código ou schema anterior para preservar. O impacto inicial é a criação dos módulos, migrations, configuração de banco e endpoints desta feature.

| Componente/arquivo | Mudança | Risco |
|---|---|---|
| `src/modules/wallets/` | Criar domínio, aplicação, infraestrutura e HTTP da feature | Baixo; módulo isolado |
| `src/modules/wagering/` | Criar o mínimo necessário para a transação interna `OPENING` | Médio; não antecipar BET ou mensageria |
| `src/modules/messaging/` | Não implementar nesta feature | Evita ampliar escopo |
| PostgreSQL | Criar tabelas e constraints de wallet, transação e ledger | Alto; migration precisa ser reversível |
| `app.module.ts`/configuração | Registrar o módulo, MikroORM e banco | Médio; falha de configuração afeta bootstrap |
| API HTTP | Adicionar `POST /wallets` e `GET /wallets/:walletId` | Médio; status e validação são contrato público |

## 3. Componentes novos

### Domínio

- `Money` com amount decimal como string, moeda ISO-4217 e operações necessárias.
- `Wallet` com `open`, `rehydrate`, saldo e `version`.
- `WagerTransaction` com criação interna de `OPENING` e estado `PROCESSED`.
- `WalletLedgerEntry` imutável, validando saldo anterior/posterior.
- Códigos de erro de validação e conflitos necessários à feature.

### Aplicação

- `CreateWalletUseCase`.
- `GetWalletUseCase`.
- `WalletRepository`.
- `WagerTransactionRepository` para `OPENING`.
- `LedgerRepository`.
- `UnitOfWork`/transaction manager usando MikroORM.
- Resultado de criação/consulta independente de entidades do ORM.

### Infraestrutura

- Entidades/mapeamentos MikroORM para `wallets`, `wager_transactions` e `wallet_ledger_entries`.
- Migration de criação e rollback das tabelas, índices, constraints e checks.
- Gerador de UUIDv7 atrás de uma porta.
- Adapter de persistência que mantém `NUMERIC(19,2)` como string no limite da aplicação.

### HTTP

- DTO de criação com `playerId`, `initialBalance.amount` e `initialBalance.currency`.
- Pipe/validator para UUID.
- Normalização da moeda para maiúsculas e validação de código ISO-4217 de três letras.
- Controller de criação e consulta.
- Mapeamento para `201`, `400`, `404`, `409` e `503`.

## 4. Mudança de dados/banco

Criar uma migration reversível com, no mínimo:

### `wallets`

- PK UUIDv7;
- `player_id` UUID;
- `currency` de três caracteres;
- `balance_amount NUMERIC(19,2)`;
- `version` inteiro iniciando em `1`;
- timestamps;
- `UNIQUE(player_id, currency)`;
- `CHECK(balance_amount >= 0)`;
- `CHECK(version >= 1)`.

### `wager_transactions`

Criar somente as colunas necessárias para o `OPENING`: ID interno UUIDv7, provider interno do sistema, identificador externo/interno definido pelo domínio, wallet, player, kind, valor, moeda, status e timestamps. Não criar nesta tarefa o fluxo completo de idempotência de apostas nem referências de reversão.

### `wallet_ledger_entries`

- PK UUIDv7;
- `wallet_id`;
- `transaction_id`;
- direção;
- valor e moeda;
- `balance_before` e `balance_after`;
- timestamp;
- `UNIQUE(wallet_id, transaction_id)`;
- privilégios/trigger conforme necessário para impedir update/delete.

O rollback deve remover as tabelas e os objetos criados pela migration na ordem correta, respeitando foreign keys. A migration deve ser executada e revertida em PostgreSQL real antes de a tarefa ser considerada pronta.

## 5. Sequência de implementação

### Fase 1 — Base

1. Confirmar a estrutura de módulos por domínio e a configuração mínima do MikroORM.
2. Criar a migration reversível de wallet, `OPENING` e ledger.
3. Criar portas de repositório, Unit of Work, clock e UUIDv7.

### Fase 2 — Lógica principal

1. Implementar `Money` e suas validações.
2. Implementar `Wallet.open`/`rehydrate` e a regra de saldo/version.
3. Implementar `WagerTransaction` e `WalletLedgerEntry` para `OPENING`.
4. Implementar `CreateWalletUseCase` com wallet, `OPENING` e ledger na mesma transação.
5. Mapear conflito de unique constraint para resultado de negócio `WALLET_ALREADY_EXISTS`.
6. Implementar `GetWalletUseCase` retornando DTO de leitura, não entidade ORM.

### Fase 3 — Interface

1. Implementar DTO e validação de `playerId` UUID.
2. Normalizar moeda para maiúsculas e validar ISO-4217 de três letras.
3. Implementar `POST /wallets` e `GET /wallets/:walletId`.
4. Aplicar status `201`, `400`, `404`, `409` e `503` conforme a Spec.
5. Registrar logs estruturados mínimos sem payload financeiro completo.

### Fase 4 — Testes

1. Testar Money, Wallet, `OPENING` e ledger como regras puras.
2. Testar migration, constraints e rollback em PostgreSQL real.
3. Testar atomicidade de criação positiva e criação com falha.
4. Testar consulta, erros HTTP e normalização/rejeição de moeda.
5. Testar criação concorrente com múltiplas requisições reais.
6. Executar regressão completa antes de marcar a tarefa pronta.

### Fase 5 — Entrega

1. Atualizar a evidência de verificação da feature.
2. Comparar Spec ↔ Plano/Tarefas ↔ Código ↔ Testes.
3. Registrar divergências, se houver.
4. Confirmar rollback da migration e procedimento de recuperação.
5. Submeter para revisão e aprovação de Marcos; não marcar a feature como concluída sozinho.

## 6. Riscos

| Risco | Chance | Impacto | Como mitigar |
|---|---|---|---|
| MikroORM converter `NUMERIC` para `number` | Média | Alto: perda de precisão | Configurar tipo como string, testar valores de borda e proibir `number` no domínio |
| Falha entre wallet e `OPENING` | Média | Alto: inconsistência financeira | Unit of Work única e teste de rollback em PostgreSQL real |
| Race na criação duplicada | Média | Alto: duas wallets/OPENING | `UNIQUE(player_id, currency)` no banco e teste paralelo |
| Validação ISO divergente do contrato | Média | Médio: contrato inconsistente | Centralizar normalização/validação e cobrir caixa baixa, código inválido e tamanho incorreto |
| UUIDv7 indisponível no runtime escolhido | Baixa | Médio | Encapsular gerador atrás de porta e validar em teste de integração |
| Erro de mapeamento de constraint para HTTP | Média | Médio | Testar `409` com criação sequencial e concorrente |
| Migration difícil de reverter | Baixa | Alto | Executar `up`/`down` em banco descartável antes da aprovação |

Nenhum risco desta feature exige novo ADR neste momento; se a representação `NUMERIC(19,2)`, o gerador UUIDv7 ou a estratégia de constraints mudar, registrar uma decisão arquitetural antes de implementar.

## 7. Decisões operacionais aprovadas

Não há perguntas abertas para iniciar esta feature. Foram adotados os seguintes padrões:

- **Dependências:** usar Bun 1.x e escolher versões estáveis compatíveis de NestJS, MikroORM e demais dependências no bootstrap; fixar as versões exatas no `package.json`, lockfile e imagens Docker. Não usar versões flutuantes.
- **Ambiente local:** Docker Compose é o padrão único para PostgreSQL e serviços locais. O comando padrão é `docker compose up -d` na raiz do projeto; para parar, usar `docker compose down`.
- **Branches:** usar `main` como branch base e uma branch de feature, inicialmente `feature/criar-consultar-wallet`. Não trabalhar diretamente em `main`.
- **Trilha de commits:** implementar uma tarefa por vez, na ordem de `tarefas.md`, com commits pequenos e rastreáveis, como `feat(wallets): ...`, `test(wallets): ...` e `docs(wallets): ...`.
- **Integração:** somente integrar em `main` depois da revisão e aprovação de Marcos.
- **Ledger:** manter lançamentos imutáveis, sem update/delete e sem expurgo automático nesta fase. O ledger permanece retido como fonte de auditoria financeira.
- **Proteção do ledger:** usar a combinação de privilégios restritos e/ou trigger definida na migration para impedir alterações e exclusões.

Essas decisões são operacionais e não alteram os requisitos funcionais da feature. Qualquer mudança futura que altere contrato, schema ou limite arquitetural deve ser registrada antes de codar.
