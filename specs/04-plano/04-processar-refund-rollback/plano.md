# Plano de Implementação — Processar REFUND e ROLLBACK

## Referências

- Especificação: [`specs/03-features/04-processar-refund-rollback/spec.md`](../../03-features/04-processar-refund-rollback/spec.md)
- Arquitetura: [`specs/02-arquitetura/`](../../02-arquitetura/)
- Requisitos globais: [`README.md`](../../../README.md)
- Referência de estrutura: [`specs/04-plano/03-processar-win-loss/`](../03-processar-win-loss/)

**Status:** Rascunho — aguardando aprovação formal da Spec e deste plano.

> A pasta `specs/04-plano/FEATURE_TEMPLATE/` prevista no prompt de planejamento não existe no repositório. Este documento segue a estrutura consolidada das features anteriores e registra a divergência para revisão.

## 1. Objetivo

Estender o fluxo existente de `ProcessWagerTransaction` para processar, de forma idempotente e transacional, as operações `REFUND` e `ROLLBACK` no mesmo caso de uso e na mesma interface HTTP já utilizada por `BET`, `WIN` e `LOSS`.

O resultado esperado é:

- `REFUND` válido de um `BET` processado gera crédito integral na carteira;
- `ROLLBACK` válido de `BET`, `WIN` ou `REFUND` processado aplica a direção inversa da operação referenciada;
- a reversão usa o valor integral e a referência deve ser compatível com provedor, jogador, carteira, moeda e rodada;
- uma referência pode receber apenas uma reversão direta, independentemente de ser `REFUND` ou `ROLLBACK`; uma reversão de `REFUND` continua permitida como cadeia explícita;
- transação, carteira, ledger e evento Outbox permanecem atômicos sob concorrência, replay e falhas.

## 2. Escopo

### Incluído

- Novos tipos de operação `REFUND` e `ROLLBACK` no fluxo de submissão existente.
- Validação da referência obrigatória, tipo referenciado, compatibilidade contextual e valor integral.
- Resolução de referência pendente, backoff e expiração conforme a Spec.
- Aplicação de crédito/débito inverso com controle de saldo e versão otimista.
- Proteção persistente contra duas reversões diretas da mesma referência, inclusive quando os tipos forem diferentes.
- Auditoria, idempotência, conflitos de idempotência e publicação transacional no Outbox.
- Testes unitários, de integração, HTTP, concorrência e regressão do comportamento atual.

### Fora de escopo

- Novo endpoint ou segundo caso de uso para reversões.
- Implementação de SQS, Inbox, DLQ, redelivery ou publicação externa do Outbox.
- Reconciliação, consulta pública de transações, autenticação/autorização e mudanças de infraestrutura.
- Deploy ou alteração do `README.md`.

## 3. Estratégia de implementação

### Fase 1 — Base e persistência

1. Confirmar os limites da solução com a arquitetura existente e reutilizar os ports, Unit of Work, repositórios e worker já presentes.
2. Introduzir a representação persistente da transação diretamente referenciada pela reversão, se ainda não existir.
3. Criar constraint/índice único que impeça mais de uma reversão direta por referência, independentemente do tipo da nova operação.
4. Atualizar entidades, registros, repositórios, códigos de falha e eventos sem criar um fluxo paralelo.
5. Garantir que a unidade transacional inclua carteira, ledger, transação de reversão e Outbox.

### Fase 2 — Lógica de domínio e aplicação

1. Aceitar `REFUND` e `ROLLBACK` no comando e exigir `referenceTransactionId` para ambos.
2. Resolver a referência e validar existência, status processado, compatibilidade de contexto, valor integral e tipo permitido.
3. Processar `REFUND` sempre como `CREDIT` do valor integral do `BET`.
4. Processar `ROLLBACK` como direção inversa de `BET`, `WIN` ou `REFUND`.
5. Rejeitar a operação quando o débito inverso produzir saldo negativo, sem efeitos parciais.
6. Reutilizar idempotência, replay, conflitos, retries otimistas e o worker de referências pendentes.
7. Persistir auditoria e evento de domínio/Outbox com os dados da reversão.

### Fase 3 — Interface HTTP

1. Estender DTO, validação, controller e presenter existentes.
2. Preservar o contrato de `BET`, `WIN` e `LOSS`.
3. Aplicar os status definidos na Spec: `201`, `200`, `202`, `400`, `404`, `409`, `422` e `503`.

### Fase 4 — Testes

1. Cobrir regras de domínio e direção financeira.
2. Cobrir constraints, atomicidade, Outbox e rollback transacional no PostgreSQL.
3. Cobrir HTTP, idempotência, conflitos, referências incompatíveis, pendências e expiração.
4. Cobrir concorrência, duas reversões simultâneas e regressão das operações existentes.

### Fase 5 — Verificação e entrega

1. Executar typecheck, build, suíte completa e ciclo de migração up/down/up.
2. Conferir os critérios de aceitação da Spec e a matriz de requisitos.
3. Atualizar o status somente após aprovação explícita; não marcar a Spec ou o plano como aprovados automaticamente.

## 4. Impacto por componente

| Componente | Impacto planejado | Requisitos |
|---|---|---|
| `WagerTransaction` e regras de domínio | Representar reversões, referência direta, direção inversa, estados pendentes/rejeitados e falhas específicas | FR-002 a FR-011 |
| `ProcessWagerTransactionUseCase` | Resolver referência, validar regras, aplicar efeito financeiro, idempotência e persistência atômica | FR-001 a FR-011 |
| `Wallet`/ledger | Reutilizar crédito/débito e controle de saldo com versão otimista | FR-002, FR-003, FR-009, FR-010 |
| Repositórios e banco | Persistir referência interna e impor unicidade de uma reversão direta por transação | FR-007, FR-008, FR-010, FR-011 |
| DTO/controller/presenter | Aceitar os novos tipos e expor o mapeamento HTTP da Spec | FR-001, FR-004 a FR-009 |
| Worker de referências pendentes | Reprocessar `REFUND`/`ROLLBACK` pendentes, backoff e expiração | FR-005, FR-006, FR-011 |
| Outbox/auditoria | Registrar reversão e publicar o evento apenas após commit | FR-002, FR-003, FR-005, FR-009, FR-011 |
| Testes existentes | Garantir que `BET`, `WIN` e `LOSS` permaneçam inalterados | FR-010, FR-011 |

## 5. Alterações de banco de dados

- Criar migration nova e reversível para armazenar a referência da transação revertida, caso o modelo atual ainda não possua essa relação.
- Criar constraint/índice único para impedir duas reversões diretas da mesma referência, sem separar a regra por `REFUND` e `ROLLBACK`.
- Manter as constraints de idempotência, referência externa, moeda, valor e status já existentes.
- Garantir que a migration seja compatível com registros existentes e que o down seja executável em ambiente de teste.
- Não editar migrations já aplicadas.

A escolha entre FK interna, coluna de referência e índice/constraint deve ser validada contra o schema real antes da implementação. Se a arquitetura atual não tiver uma forma segura de impor a unicidade entre tipos, essa decisão deve ser registrada antes de alterar o schema, pois uma correção posterior seria onerosa.

## 6. Fluxo transacional planejado

1. Receber o comando e calcular/validar o hash da requisição.
2. Consultar por idempotência; retornar replay exato ou conflito quando aplicável.
3. Para `REFUND`/`ROLLBACK`, validar a referência externa e resolver a transação original.
4. Se a referência ainda não estiver disponível, persistir `PENDING_REFERENCE` dentro da política definida.
5. Validar tipo permitido, compatibilidade contextual, valor integral e regra de uma reversão direta.
6. Aplicar crédito ou débito inverso na carteira com atualização condicional de versão.
7. Persistir reversão, ledger, auditoria e Outbox na mesma Unit of Work.
8. Commitar e somente então permitir a publicação do evento.
9. Em retry otimista, reexecutar a transação até três tentativas; em falha definitiva, não deixar efeitos parciais.

## 7. Riscos e mitigação

| Risco | Impacto | Mitigação |
|---|---|---|
| Dupla compensação por `REFUND` e `ROLLBACK` concorrentes | Crítico | Unicidade persistente por referência direta e teste concorrente |
| Direção financeira incorreta no `ROLLBACK` | Alto | Regra única de domínio, testes por tipo e verificação do ledger |
| `ROLLBACK` gerar saldo negativo | Alto | Validar antes do commit e retornar `REVERSAL_NEGATIVE_BALANCE` sem efeito parcial |
| Referência incompatível ou de outro jogador/carteira | Alto | Comparação obrigatória de provedor, jogador, carteira, moeda e rodada |
| Corrida entre replay e nova reversão | Alto | Idempotência, lock/versão otimista e constraint de banco |
| Falha entre carteira, ledger e Outbox | Alto | Unit of Work única e testes de rollback transacional |
| Expiração de referência pendente inconsistente | Médio | Reutilizar worker, backoff definido e teste de TTL de 15 minutos |
| Regressão em `BET`, `WIN` ou `LOSS` | Alto | Testes de regressão e manutenção do mesmo caso de uso |
| Divergência entre schema atual e estratégia de referência | Médio/alto | Inspeção do schema antes da migration e registro de decisão se necessário |

## 8. Decisões incorporadas

- `REFUND` só referencia `BET` processado.
- `ROLLBACK` pode referenciar `BET`, `WIN` ou `REFUND` processado.
- A reversão é sempre integral e mantém o contexto da referência.
- Uma referência recebe apenas uma reversão direta, independentemente do tipo; `ROLLBACK` de `REFUND` é permitido como reversão encadeada.
- Referências pendentes usam backoff de `30s`, `1m`, `2m`, `4m` e `7m`, com expiração em `15m`.
- São mantidos Money exato, PostgreSQL, controle de versão otimista com até três retries, Outbox transacional e o mesmo caso de uso para HTTP/SQS no futuro.
- SQS, Inbox, DLQ, publicação externa, reconciliação, autenticação e deploy permanecem fora desta entrega.

## 9. Critério para aprovação do plano

O plano estará pronto para execução quando houver aprovação explícita da Spec e deste plano, com a estratégia de persistência da referência direta confirmada contra o schema existente. Até lá, as tarefas permanecem abertas e nenhum código deve ser implementado com base neste documento.
