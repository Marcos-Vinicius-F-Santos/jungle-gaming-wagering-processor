# Tarefas — Processar REFUND e ROLLBACK

## Referências

- Spec: [`specs/03-features/04-processar-refund-rollback/spec.md`](../../03-features/04-processar-refund-rollback/spec.md)
- Plano: [`specs/04-plano/04-processar-refund-rollback/plano.md`](plano.md)
- Arquitetura: [`specs/02-arquitetura/`](../../02-arquitetura/)

**Status:** Rascunho — tarefas aguardam aprovação do plano.

> A pasta `specs/04-plano/FEATURE_TEMPLATE/` não existe. A organização abaixo segue o padrão das tarefas de `03-processar-win-loss`. Nenhuma tarefa está aprovada ou concluída neste momento.

## Fase 1 — Base e persistência

- [ ] **T-001 [FR-001 a FR-011]** Confirmar os limites do fluxo de reversão, os ports existentes, a Unit of Work, o worker de referências pendentes e a estratégia de referência interna.
  - **Arquivos/módulos:** `specs/02-arquitetura/`, módulo de wagering, repositórios e migrations existentes.
  - **Verificação:** documentar a decisão de desenho e registrar divergências do schema antes de qualquer alteração de código.

- [ ] **T-002 [FR-007, FR-008, FR-010, FR-011]** Criar migration reversível para persistir a transação diretamente referenciada e impor uma única reversão direta por referência, independentemente de `REFUND` ou `ROLLBACK`.
  - **Arquivos/módulos:** migration do módulo de wagering, schema PostgreSQL e entidades MikroORM.
  - **Verificação:** executar up/down/up em banco de teste; testar inserção válida, duplicata do mesmo tipo e duplicata de tipo diferente.

- [ ] **T-003 [FR-004, FR-005, FR-007, FR-008, FR-011]** Atualizar entidades, records, repositórios e ports para carregar a referência interna, o tipo referenciado e os estados pendentes/rejeitados.
  - **Arquivos/módulos:** `src/modules/wagering/domain`, `application`, `infrastructure` e contratos de persistência.
  - **Verificação:** typecheck; testes de mapeamento; leitura/escrita sem perda de dados existentes.

- [ ] **T-004 [FR-002, FR-003, FR-009, FR-010]** Estender regras de domínio e códigos de falha para direção inversa, `REVERSAL_NEGATIVE_BALANCE`, referência incompatível e duplicidade de reversão.
  - **Arquivos/módulos:** `WagerTransaction`, `Wallet`, ledger e value objects de Money.
  - **Verificação:** testes unitários para cada tipo de operação, direção, valor integral e rejeição sem mutação parcial.

- [ ] **T-005 [FR-002, FR-003, FR-005, FR-009, FR-011]** Garantir que auditoria e evento de reversão reutilizem o Outbox existente e permaneçam na mesma transação da carteira, ledger e operação.
  - **Arquivos/módulos:** Unit of Work, Outbox, mapeadores de eventos e auditoria.
  - **Verificação:** confirmar persistência conjunta após commit e ausência de registros após rollback/falha.

## Fase 2 — Lógica de domínio e aplicação

- [ ] **T-006 [FR-001, FR-007, FR-008]** Expandir comando, hash e validação de entrada para aceitar `REFUND` e `ROLLBACK`, exigindo referência para ambos.
  - **Arquivos/módulos:** command/DTO interno de `ProcessWagerTransaction` e validações de aplicação.
  - **Verificação:** aceitar payloads válidos; rejeitar tipo desconhecido, referência ausente, formato inválido e hash incompatível.

- [ ] **T-007 [FR-002, FR-003, FR-004, FR-005]** Implementar resolução e validação da referência, incluindo status processado, tipo permitido, compatibilidade de provedor, jogador, carteira, moeda, rodada e valor integral.
  - **Arquivos/módulos:** use case, serviço/validador de referência e ports de consulta.
  - **Verificação:** testes para `REFUND` de `BET`, `ROLLBACK` de `BET`/`WIN`/`REFUND`, referência incompatível, não processada e parcial.

- [ ] **T-008 [FR-007, FR-010, FR-011]** Implementar proteção contra duas reversões diretas concorrentes da mesma referência, combinando verificação de aplicação com a garantia persistente do banco.
  - **Arquivos/módulos:** use case, repositório transacional, constraint criada em T-002.
  - **Verificação:** disparar duas requisições simultâneas e confirmar que somente uma produz efeito financeiro, ledger e Outbox.

- [ ] **T-009 [FR-002, FR-004, FR-010, FR-011]** Implementar `REFUND` como crédito integral de `BET` processado, com atualização de carteira, ledger, auditoria e Outbox.
  - **Arquivos/módulos:** `ProcessWagerTransactionUseCase`, domínio de carteira e persistência de ledger.
  - **Verificação:** saldo, versão, operação persistida e evento correspondem ao valor exato; replay retorna o mesmo resultado.

- [ ] **T-010 [FR-003, FR-004, FR-009, FR-010, FR-011]** Implementar `ROLLBACK` como inversão de `BET`, `WIN` ou `REFUND`, permitindo a cadeia `ROLLBACK` de `REFUND` sem quebrar a regra de uma reversão direta por referência.
  - **Arquivos/módulos:** use case, regras de direção e ledger.
  - **Verificação:** conferir débito/crédito e saldo final para cada tipo; confirmar que o valor é integral e o contexto é preservado.

- [ ] **T-011 [FR-009, FR-011]** Implementar rejeição de `ROLLBACK` que produziria saldo negativo, com `REVERSAL_NEGATIVE_BALANCE`, auditoria e evento de rejeição sem alterar carteira ou ledger financeiro.
  - **Arquivos/módulos:** domínio de carteira, use case, auditoria e presenter de falhas.
  - **Verificação:** saldo e versão permanecem inalterados; operação fica rejeitada e a resposta HTTP segue a Spec.

- [ ] **T-012 [FR-005, FR-006, FR-011]** Reutilizar o fluxo de `PENDING_REFERENCE`, backoff de `30s/1m/2m/4m/7m` e expiração em `15m` para `REFUND` e `ROLLBACK`.
  - **Arquivos/módulos:** worker de referências, scheduler/fila existente e estados de `WagerTransaction`.
  - **Verificação:** referência indisponível retorna `202`; reprocessamento bem-sucedido é idempotente; expiração retorna `REFERENCE_NOT_FOUND` sem efeito financeiro.

- [ ] **T-013 [FR-007, FR-008, FR-010, FR-011]** Reutilizar idempotência, replay exato, conflito de idempotência, retries otimistas e logs estruturados para as novas operações.
  - **Arquivos/módulos:** use case, idempotency repository, retry policy e logging.
  - **Verificação:** mesmo request retorna replay; mesma chave com payload diferente retorna conflito; concorrência exaure no máximo três tentativas e não duplica efeito.

## Fase 3 — Interface HTTP

- [ ] **T-014 [FR-001, FR-004, FR-008]** Atualizar DTO, validação e documentação interna do endpoint para os novos tipos e a obrigatoriedade de `referenceTransactionId`.
  - **Arquivos/módulos:** DTOs, schemas de validação e módulo HTTP de wagering.
  - **Verificação:** payloads válidos passam; entradas inválidas retornam `400` sem chegar à aplicação.

- [ ] **T-015 [FR-001, FR-004, FR-005, FR-007, FR-008, FR-009]** Atualizar controller/presenter para mapear criação, replay, pendência, não encontrado, conflito, regra de negócio e indisponibilidade aos status definidos.
  - **Arquivos/módulos:** controller e presenter do endpoint existente.
  - **Verificação:** testes HTTP para `201`, `200`, `202`, `400`, `404`, `409`, `422` e `503`, preservando `BET`, `WIN` e `LOSS`.

- [ ] **T-016 [FR-005, FR-006, FR-011]** Confirmar registro do worker, ports, handlers e configuração do módulo sem criar endpoint ou fluxo paralelo e sem incluir SQS/Inbox/DLQ nesta entrega.
  - **Arquivos/módulos:** módulo de wagering, bootstrap e configuração de jobs.
  - **Verificação:** aplicação sobe com os providers corretos; testes de composição e typecheck passam.

## Fase 4 — Testes

- [ ] **T-017 [FR-002, FR-003, FR-004, FR-009]** Criar testes unitários para regras de tipo permitido, compatibilidade, direção, valor integral, cadeia de reversão e saldo negativo.
  - **Arquivos/módulos:** testes de domínio e aplicação do módulo de wagering.
  - **Verificação:** matriz cobre todos os tipos de referência e todos os códigos de falha da Spec.

- [ ] **T-018 [FR-002, FR-003, FR-005, FR-006, FR-009, FR-011]** Criar testes de integração para migration, constraints, Unit of Work, ledger, carteira, auditoria e Outbox.
  - **Arquivos/módulos:** testes PostgreSQL/MikroORM e infraestrutura de wagering.
  - **Verificação:** commit deixa todos os registros consistentes; qualquer falha reverte todos; up/down/up funciona.

- [ ] **T-019 [FR-001, FR-004, FR-005, FR-007, FR-008, FR-009]** Criar testes HTTP de sucesso, replay, pendência, expiração, referência incompatível, ausência de referência, conflito e saldo negativo.
  - **Arquivos/módulos:** suíte HTTP/e2e do módulo.
  - **Verificação:** respostas e corpos seguem o contrato da Spec sem regressão para operações existentes.

- [ ] **T-020 [FR-007, FR-008, FR-010, FR-011]** Criar testes de concorrência para reversões simultâneas, replay paralelo, conflitos de idempotência e retries otimistas.
  - **Arquivos/módulos:** testes de integração concorrente e repositórios transacionais.
  - **Verificação:** no máximo uma reversão direta produz efeito; saldo, versão, ledger e Outbox permanecem consistentes.

- [ ] **T-021 [FR-005, FR-006, FR-011]** Criar testes do worker para backoff, reprocessamento, sucesso posterior, expiração, `ROLLBACK` de `REFUND` e reexecução idempotente.
  - **Arquivos/módulos:** testes de jobs/scheduler e fixtures de wagering.
  - **Verificação:** tentativas respeitam a sequência definida e a expiração não cria efeito financeiro.

## Fase 5 — Verificação e entrega

- [ ] **T-022 [FR-001 a FR-011]** Executar typecheck, build, suíte completa, validação de migrations, checklist de critérios de aceitação e revisão final da documentação.
  - **Arquivos/módulos:** projeto inteiro, Spec, plano e tarefas.
  - **Verificação:** todos os comandos passam; cada FR e AC possui evidência; registrar pendências sem marcar aprovação automaticamente.

## Dependências e ordem

`T-001` deve preceder T-002 a T-005. A base persistente (T-002/T-003) deve estar pronta antes de T-008 e T-010. A lógica (T-006 a T-013) deve estar estabilizada antes da validação HTTP (T-014/T-016) e dos testes finais (T-017 a T-021). T-022 é a etapa de convergência e só pode ser encerrada após aprovação explícita.

## Fora da execução desta lista

Não criar SQS, Inbox, DLQ, redelivery, publicação externa do Outbox, reconciliação, consulta pública, autenticação/autorização, carga multi-instância, deploy ou alterações no `README.md`.
