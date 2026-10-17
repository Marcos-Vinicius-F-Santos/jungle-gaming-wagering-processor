# Plano de Implementação — Processar BET com idempotência e optimistic locking

Spec relacionada: [`../../03-features/02-processar-bet/spec.md`](../../03-features/02-processar-bet/spec.md)
Arquitetura relacionada: [`../../02-arquitetura/arquitetura.md`](../../02-arquitetura/arquitetura.md)
Status: Rascunho — aguardando aprovação

Escopo desta rodada: fases 1 a 5. A fase 06 de deploy não existe por enquanto, pois o projeto não possui Git nem fluxo de deploy configurado. A fase 5 cobre apenas verificação, rollback de migration e preparação para revisão.

## 1. Resumo técnico

Estender o módulo `wagering` existente para processar `BET` de forma síncrona pelo endpoint `POST /wagering/transactions`, reutilizando o caso de uso financeiro único previsto na arquitetura. A operação será validada na borda HTTP, terá `payloadHash` SHA-256 de JSON canônico, será deduplicada por `(providerId, idempotencyKey)` e `(providerId, externalTransactionId)`, e executará transação, débito da wallet e ledger na mesma transação SQL.

O saldo será alterado exclusivamente pelo agregado `Wallet`. O update usará `WHERE id = ? AND version = ?`, com três tentativas totais de optimistic locking. Em caso de replay, o resultado persistido será retornado sem novo efeito. O processamento de `BET` não introduz SQS, Inbox, Outbox, worker ou as demais operações financeiras nesta rodada.

## 2. Impacto no que já existe

| Componente/arquivo | Mudança | Risco |
|---|---|---|
| `src/modules/wagering/domain/wager-transaction.ts` | Expandir o modelo que hoje representa apenas `OPENING` para suportar `BET`, estados terminais, hash, idempotência e rejeições auditáveis | Alto; preservar o comportamento de `OPENING` da feature anterior |
| `src/modules/wagering/infrastructure/persistence/entities/wager-transaction.entity.ts` | Mapear campos de BET, resultado necessário para replay e novas constraints/índices | Alto; divergência entre entidade, migration e domínio pode quebrar a persistência existente |
| `src/modules/wagering/application/ports/wager-transaction-repository.port.ts` | Adicionar buscas por idempotency key e transação externa, além de persistência/consulta do resultado | Médio; manter portas sem dependência de MikroORM |
| `src/modules/wallets/domain/wallet.ts` | Adicionar operação de débito que preserve moeda e saldo não negativo | Alto; qualquer race pode causar saldo incorreto |
| `src/modules/wallets/application/ports/wallet-repository.port.ts` e adapter MikroORM | Adicionar update condicional por versão e retorno de conflito de optimistic locking | Alto; precisa distinguir conflito de versão de wallet inexistente |
| `src/infrastructure/database/migrations/` | Criar migration nova para ajustar o índice de idempotência ao escopo do provider e armazenar snapshot de replay | Alto; não editar a migration já aplicada e garantir `up/down` reversível |
| `src/shared/infrastructure/database/mikro-orm-unit-of-work.ts` | Reutilizar a Unit of Work e coordenar retry em transações SQL independentes | Médio; retry não pode repetir efeito confirmado |
| `src/modules/wagering/` e `src/app.module.ts` | Registrar caso de uso, adapters e controller sem criar uma camada paralela fora da arquitetura | Médio; preservar o bootstrap e a feature de wallets |
| Testes existentes de wallets | Executar regressão sem alterar contrato de criação/consulta | Médio; alteração de schema pode afetar fixtures e constraints |

## 3. Componentes novos

### Domínio e aplicação

- `ProcessWagerTransactionUseCase`, como único orquestrador financeiro da entrada HTTP.
- Estados e tipos de `WagerTransaction` necessários para `BET`: `PENDING`, `PROCESSED`, `REJECTED` e `FAILED`.
- Códigos estáveis de falha, incluindo `INSUFFICIENT_FUNDS`, `WALLET_NOT_FOUND`, `WALLET_MISMATCH`, `IDEMPOTENCY_CONFLICT`, `EXTERNAL_TRANSACTION_CONFLICT` e `LOCK_RETRY_EXHAUSTED` quando aplicável.
- Serviço puro de canonicalização e hash SHA-256, sem dependência de NestJS ou ORM.
- Métodos de repositório para localizar por `(providerId, idempotencyKey)` e `(providerId, externalTransactionId)` e para guardar o snapshot necessário ao replay.
- Operação de débito da wallet e porta para update condicional por `version`.

### Infraestrutura e HTTP

- Entidade/mapeamento MikroORM atualizado para a transação de BET e o resultado persistido.
- Nova migration reversível, sem editar a migration de fundação já executada.
- DTO e controller de `POST /wagering/transactions`.
- Presenter/error mapper para `201`, `200`, `400`, `404`, `409`, `422` e `503`.
- Logs estruturados mínimos do fluxo, sem payload financeiro completo ou dados sensíveis.

Não serão criados nesta feature adapters de SQS, Inbox, Outbox, DLQ, workers, eventos de integração, reconciliação ou endpoints das operações `WIN`, `LOSS`, `REFUND` e `ROLLBACK`.

## 4. Mudança de dados/banco

Criar uma nova migration versionada e reversível. A migration anterior não deve ser editada.

### `wager_transactions`

- Preservar a unique existente em `(provider_id, external_transaction_id)`.
- Remover o índice parcial atualmente global de `idempotency_key` e criar unique parcial em `(provider_id, idempotency_key)` para chaves não nulas.
- Manter `idempotency_key` nullable para o `OPENING` interno; BET exige o valor na camada de aplicação.
- Adicionar snapshot opcional do resultado, no mínimo `result_balance_amount NUMERIC(19,2)` e `result_balance_currency varchar(3)`, para replay determinístico sem consultar o saldo atual da wallet.
- Adicionar ou ajustar checks de tamanho/forma compatíveis com o contrato: `provider_id` até 64, `external_transaction_id` até 255, `round_id` e `game_id` até 128, e `idempotency_key` até 255.
- Preservar checks de valor positivo, moeda ISO em maiúsculas, kinds e statuses definidos pelo README.

### `wallets` e `wallet_ledger_entries`

Não alterar a regra financeira da feature anterior. O débito deve usar a versão atual da wallet e gerar no máximo um ledger por transação. As constraints de saldo não negativo, aritmética do ledger e imutabilidade permanecem ativas.

### Rollback

O `down` deve remover primeiro os índices/constraints/colunas adicionados e recriar o índice anterior somente se isso for seguro e explicitamente documentado; caso o índice anterior global não possa ser restaurado sem risco de colisão, o procedimento deve falhar de forma clara em vez de apagar dados. O rollback deve ser executado em PostgreSQL real. Nenhuma alteração deve truncar ou reescrever transações existentes.

## 5. Sequência de implementação

### Fase 1 — Base

1. Confirmar os limites do módulo `wagering`, o caso de uso único e as portas existentes.
2. Criar migration nova para unicidade por provider, snapshot de replay e checks de contrato.
3. Atualizar entidades MikroORM e portas de repositório.
4. Criar canonicalizador/hash e a política explícita de três tentativas totais.

### Fase 2 — Lógica principal

1. Expandir `WagerTransaction` sem quebrar `OPENING`.
2. Implementar débito de `Wallet` e update condicional por versão.
3. Implementar consultas de idempotência/transação externa e replay.
4. Implementar `ProcessWagerTransactionUseCase` com atomicidade, rejeições auditáveis e ledger.
5. Implementar tratamento de conflitos concorrentes e retry limitado.

### Fase 3 — Interface

1. Criar DTO com validação dos campos, UUIDs, valor decimal, moeda ISO e limites aprovados.
2. Criar `POST /wagering/transactions` chamando o caso de uso, sem acesso direto ao banco.
3. Mapear os status HTTP aprovados e os payloads de resposta, incluindo replay.
4. Adicionar logs estruturados mínimos e métricas locais de replay/conflito/retry, se a infraestrutura existente permitir sem ampliar o escopo.

### Fase 4 — Testes

1. Testar domínio, canonicalização/hash, estados e regras de BET.
2. Testar migration, constraints, rollback e atomicidade em PostgreSQL real.
3. Testar contrato HTTP e os códigos de status aprovados.
4. Testar replay, conflito de key, duplicidade externa e falhas depois do commit.
5. Testar concorrência real sobre a mesma wallet e paralelismo entre wallets distintas.
6. Executar a regressão completa da feature de wallets.

### Fase 5 — Entrega e verificação

1. Atualizar as evidências da feature e preencher a verificação de convergência.
2. Confirmar migration `up/down` e o procedimento local de recuperação.
3. Revisar Spec ↔ Plano/Tarefas ↔ Código ↔ Testes.
4. Submeter para revisão e aprovação de Marcos; não marcar como concluído sem essa aprovação.

Não haverá deploy nesta rodada por ausência de Git e de fluxo de deploy configurado.

## 6. Riscos

| Risco | Chance | Impacto | Como mitigar |
|---|---|---|---|
| Alterar o índice global de idempotency key para escopo por provider | Média | Alto: colisões podem criar replay ou conflito incorreto | Migration nova reversível, constraints testadas e registro da decisão de escopo antes da execução da migration |
| Expandir `WagerTransaction` sem quebrar `OPENING` | Média | Alto: regressão na criação de wallet | Preservar factory `opening`, executar testes anteriores e testar os dois kinds no mesmo schema |
| Replay devolver saldo atual em vez do saldo original | Média | Alto: resposta não determinística para o provedor | Persistir snapshot do resultado e testar mudança posterior da wallet antes do replay |
| Retry repetir débito ou ledger | Média | Muito alto: inconsistência financeira | Cada tentativa usa transação SQL própria, update condicional por versão, unique constraints e teste concorrente real |
| Concorrência em wallet quente exceder o limite | Média | Médio: aumento de `503` | Três tentativas totais, métrica de conflito e resposta explícita sem efeito parcial |
| Falha durante a migration em banco já usado | Baixa | Alto: indisponibilidade ou perda de constraint | Não editar migration aplicada, fazer backup/checagem prévia no ambiente local e executar `up/down` em banco descartável |
| Limites de campos divergirem entre DTO, entidade e banco | Média | Médio: comportamento inconsistente | Uma fonte de constantes de limite, testes de fronteira e checks equivalentes no banco |

O risco do escopo da idempotency key merece Registro de Decisão em `specs/02-arquitetura/DECISAO_TEMPLATE.md`, pois altera uma constraint durável e um contrato de integração. As demais decisões já estão aprovadas na Spec da Feature; qualquer mudança nelas também deve ser registrada antes da implementação.

## 7. Perguntas abertas antes de começar

Não há perguntas funcionais abertas: as decisões de retry, status HTTP, escopo da idempotência, limites de campos e wallet inexistente foram aprovadas e registradas na Spec da Feature.

Permanece como controle obrigatório antes da migration a criação do Registro de Decisão sobre o escopo `(providerId, idempotencyKey)`, sem alterar o contrato aprovado.
