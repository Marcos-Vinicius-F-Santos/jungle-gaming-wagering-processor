# Spec da Feature — Resiliência operacional do processamento SQS/Inbox

Status: Implementação verificada — aguardando aprovação final  
Projeto: Distributed Wagering Processor  
Onde vive no código: `src/modules/messaging/sqs/`, `src/modules/messaging/inbox/`, infraestrutura de testes e Docker Compose  
Spec do produto: [`../../01-produto/spec.md`](../../01-produto/spec.md)  
Arquitetura: [`../../02-arquitetura/arquitetura.md`](../../02-arquitetura/arquitetura.md)  
Feature relacionada: [`../05-processar-sqs-inbox/spec.md`](../05-processar-sqs-inbox/spec.md)  

> Esta feature fecha as lacunas de resiliência identificadas na comparação com o README original. Ela não cria uma segunda regra financeira nem substitui o caso de uso existente; seu objetivo é tornar verificáveis e operacionais as garantias de múltiplas instâncias, redelivery, crash recovery, reinício e shutdown.

## 1. Objetivo

Comprovar e endurecer o processamento assíncrono de transações para que o sistema permaneça correto quando houver múltiplas instâncias, entrega duplicada, falha do processo em pontos críticos, reinício ou encerramento gracioso.

A unidade de correção continua sendo a transação SQL que coordena Inbox, `WagerTransaction`, wallet, ledger e Outbox. O SQS fornece entrega e redelivery, mas não será tratado como fonte de verdade para idempotência ou consistência financeira.

O resultado desta feature deve demonstrar, com PostgreSQL e LocalStack/MiniStack reais, que:

- uma mensagem entregue a várias instâncias produz no máximo um efeito financeiro;
- um crash depois do commit e antes do `ack` não duplica débito, crédito, ledger ou Outbox;
- uma falha antes do commit permite redelivery e novo processamento seguro;
- o serviço reinicia sem deixar Inbox ou efeitos financeiros em estado inconsistente;
- `SIGTERM` não confirma mensagens cujo processamento não foi commitado;
- a invariável final `wallet.balance == saldo reconstruído pelo ledger` permanece verdadeira.

## 2. Como funciona hoje

O projeto já possui processamento financeiro síncrono e assíncrono, Inbox persistente, idempotência, optimistic locking, Outbox, retries, DLQ e worker de referências pendentes. Também existem testes de integração para o caminho básico de SQS, para o `ack` após processamento, para concorrência financeira e para publicação da Outbox.

As lacunas desta rodada são operacionais e de verificação:

- não há teste executado com pelo menos três instâncias reais do consumidor;
- não há cenário integrado que mate o consumidor entre o commit SQL e o `ack` do SQS;
- não há cenário de reinício que comprove a recuperação de Inbox em processamento;
- não há verificação de `SIGTERM` durante uma mensagem em voo;
- não há comando ou harness dedicado para executar esses cenários de forma repetível.

Esta feature não altera o contrato HTTP, os cálculos monetários, as regras de `BET`, `WIN`, `LOSS`, `REFUND` ou `ROLLBACK`, nem o contrato dos eventos da Outbox.

## 3. Requisitos funcionais

### FR-001 — Executar com múltiplas instâncias reais

QUANDO o cenário de resiliência for executado

O SISTEMA DEVE iniciar pelo menos três instâncias independentes do consumidor SQS, compartilhando PostgreSQL e as filas locais, sem depender de lock em memória para garantir a correção.

Cada instância deve usar o mesmo `consumerName` lógico e o mesmo schema persistente de Inbox.

### FR-002 — Deduplicar entregas concorrentes

QUANDO duas ou mais instâncias receberem simultaneamente a mesma mensagem, com o mesmo `messageId` e `payloadHash`

O SISTEMA DEVE permitir no máximo um processamento financeiro efetivo, um resultado terminal de Inbox, os lançamentos financeiros esperados e os eventos de Outbox esperados.

As demais instâncias devem reconhecer replay, conflito transitório de persistência ou estado já processado e não podem criar novo efeito financeiro.

### FR-003 — Recuperar crash antes do commit

QUANDO o processo falhar antes do commit da Unit of Work

O SISTEMA DEVE deixar a mensagem elegível para redelivery, sem Inbox confirmado, débito/crédito parcial, ledger órfão ou Outbox financeiro parcial.

Uma nova instância deve processar a mensagem de forma completa e única.

### FR-004 — Recuperar crash depois do commit e antes do ack

QUANDO o PostgreSQL confirmar Inbox e efeitos financeiros, mas o processo cair antes do `DeleteMessage`/`ack`

O SISTEMA DEVE aceitar a redelivery e reconhecer o Inbox já processado, sem repetir wallet, ledger, versão, transação financeira ou Outbox.

O resultado persistido deve continuar auditável após o reinício.

### FR-005 — Recuperar Inbox em processamento

QUANDO uma instância morrer deixando uma mensagem com estado não terminal de Inbox

O SISTEMA DEVE permitir que outra instância recupere a mensagem depois da política de visibilidade/lease definida, sem bloquear indefinidamente o processamento.

O mecanismo de recuperação não pode transformar um estado `PROCESSING` sem commit em sucesso financeiro.

### FR-006 — Reiniciar sem perder mensagens confirmadas

QUANDO o serviço for encerrado e iniciado novamente

O SISTEMA DEVE recuperar mensagens que não receberam `ack`, preservar os registros confirmados e manter a consistência financeira e da Outbox.

Mensagens confirmadas não devem ser reaplicadas; mensagens não confirmadas devem permanecer disponíveis para redelivery.

### FR-007 — Encerrar com `SIGTERM`

QUANDO uma instância receber `SIGTERM`

O SISTEMA DEVE parar de iniciar novas mensagens, aguardar as mensagens em voo até o limite operacional e confirmar apenas aquelas cujo commit foi concluído.

Mensagens que não puderem concluir devem permanecer disponíveis para redelivery ou ter sua visibilidade devolvida explicitamente.

### FR-008 — Preservar classificação de falhas

QUANDO ocorrer uma falha durante um cenário de concorrência, crash ou reinício

O SISTEMA DEVE manter a classificação existente:

- resultado de negócio persistido: `ack`;
- falha transitória antes do commit: sem `ack`, com retry/backoff;
- falha permanente ou poison message: DLQ sem efeito financeiro indevido.

Esta feature não pode transformar falha de infraestrutura em rejeição financeira nem ocultar falha de entrega como sucesso.

### FR-009 — Validar a invariável financeira final

QUANDO cada cenário terminar

O SISTEMA DEVE verificar, no PostgreSQL, que o saldo materializado da wallet é igual ao saldo reconstruído a partir do ledger e que a quantidade de lançamentos corresponde às transações efetivamente aplicadas.

Para mensagens duplicadas, a verificação deve incluir a ausência de segundo lançamento, segunda alteração de versão e segundo evento financeiro equivalente.

### FR-010 — Fornecer execução repetível

QUANDO um desenvolvedor ou pipeline executar a verificação de resiliência

O SISTEMA DEVE oferecer um comando documentado que inicialize os containers necessários, execute os cenários e produza resultado determinístico com diagnóstico suficiente para falhas.

O harness deve limpar ou isolar os dados de cada cenário sem apagar dados fora do escopo do teste.

### FR-011 — Observar falhas de entrega

QUANDO ocorrer duplicidade, retry, redelivery, crash recovery, shutdown ou DLQ

O SISTEMA DEVE registrar logs estruturados e métricas que permitam identificar instância, `consumerName`, `messageId`, `correlationId`, tentativa, classificação e resultado, sem expor payload financeiro completo ou segredos.

## 4. Modelo operacional

### 4.1 Componentes compartilhados

Os cenários devem usar:

- PostgreSQL real compartilhado pelas instâncias;
- `wager-transactions.fifo` e `wager-transactions-dlq.fifo` reais no LocalStack/MiniStack;
- Inbox persistente com unicidade por `(consumerName, messageId)`;
- o mesmo `ProcessWagerTransactionUseCase` usado pelo HTTP;
- Outbox persistente e seus efeitos observáveis no banco;
- três instâncias independentes do consumidor, quando o cenário exigir concorrência entre processos.

### 4.2 Pontos de injeção de falha

As falhas controladas devem ser habilitadas apenas no ambiente de teste, por adapter, hook ou configuração explicitamente restrita ao harness. Não deve existir endpoint público para matar processamento ou forçar commit parcial.

Os pontos mínimos são:

1. antes do commit SQL;
2. depois do commit SQL e antes do `ack`;
3. durante uma mensagem em voo, antes do shutdown;
4. após a publicação da Outbox e antes da confirmação do registro, quando o cenário da Outbox for incluído na regressão.

O teste deve distinguir claramente falha antes do commit de falha depois do commit.

### 4.3 Estados esperados

| Momento da falha | Inbox | Efeito financeiro | Próxima entrega |
|---|---|---|---|
| Antes do commit | não confirmado | nenhum efeito parcial | processa integralmente |
| Depois do commit, antes do ack | processado | exatamente um efeito | replay seguro |
| Durante `SIGTERM`, antes do commit | não confirmado | nenhum efeito parcial | redelivery |
| Durante `SIGTERM`, depois do commit | processado | exatamente um efeito | ack ou replay seguro |

## 5. Regras de negócio e operação

### BR-001 — Banco como fonte da verdade

Locks, deduplicação FIFO, visibilidade e estado em memória são mecanismos operacionais. A garantia final deve vir das constraints, transações, Inbox, idempotência, optimistic locking e ledger persistidos.

### BR-002 — Mesmo consumidor lógico

Todas as instâncias da mesma versão devem usar o mesmo `consumerName`. Alterar esse valor equivale a alterar a chave de deduplicação e exige decisão explícita.

### BR-003 — Ack pós-commit

Nenhum caminho de sucesso pode executar `ack` antes da confirmação da Unit of Work. O crash entre commit e ack deve ser tratado como redelivery esperada, não como erro de consistência.

### BR-004 — Sem segundo efeito financeiro

Uma mesma mensagem SQS não pode criar mais de uma transação financeira efetiva, lançamento de ledger por efeito ou avanço de versão correspondente.

### BR-005 — Sem lock global em memória

A solução deve manter processamento paralelo de wallets distintas. Um mutex global no processo não é critério de correção e não pode ser usado para mascarar a ausência de coordenação persistente.

### BR-006 — Backoff e DLQ existentes

Os cenários devem respeitar as políticas já aprovadas de retry, visibilidade, backoff e DLQ. A feature não altera os intervalos de negócio nem o TTL de referências pendentes.

### BR-007 — Dados isolados por cenário

Cada cenário deve usar identificadores únicos e validar somente suas próprias mensagens, transações, wallets, ledger, Inbox e Outbox. A limpeza deve ser transacional ou limitada aos identificadores criados pelo cenário.

## 6. Observabilidade

Os logs dos cenários devem permitir reconstruir a sequência:

```text
receive -> claim/process -> commit ou rollback -> ack/redelivery -> replay ou novo processamento
```

As métricas mínimas observadas são:

- mensagens recebidas;
- replays/deduplicações;
- retries e redeliveries;
- conflitos de Inbox;
- conflitos de optimistic locking;
- mensagens enviadas para DLQ;
- mensagens concluídas durante shutdown;
- mensagens devolvidas para redelivery;
- latência de processamento;
- diferença final entre saldo materializado e saldo reconstruído.

Nenhuma métrica deve usar `messageId`, `transactionId`, `walletId` ou payload como tag de alta cardinalidade.

## 7. Critérios de aceite

### AC-001 — Três instâncias

Dado um ambiente com três instâncias independentes e uma fila SQS compartilhada

Quando forem enviadas mensagens para wallets iguais e diferentes

Então as wallets diferentes poderão ser processadas em paralelo, a wallet compartilhada permanecerá consistente e nenhuma mensagem terá efeito financeiro duplicado.

### AC-002 — Entrega duplicada simultânea

Dado o mesmo `messageId` entregue a duas ou mais instâncias simultaneamente

Quando todas tentarem processar a mensagem

Então somente um efeito financeiro será confirmado, o Inbox terá um resultado terminal e todas as instâncias terminarão sem criar segundo ledger.

### AC-003 — Crash antes do commit

Dado um crash injetado antes do commit

Quando outra instância receber a mensagem novamente

Então o processamento completo poderá ocorrer e não existirão registros financeiros parciais do primeiro processo.

### AC-004 — Crash depois do commit e antes do ack

Dado um crash injetado depois do commit SQL e antes do `ack`

Quando a mensagem for reentregue

Então o Inbox será reconhecido como processado, nenhum novo débito/crédito/ledger/Outbox será criado e a invariável financeira permanecerá verdadeira.

### AC-005 — Reinício do serviço

Dado um processo encerrado durante uma entrega

Quando o serviço for reiniciado

Então mensagens não confirmadas poderão ser reprocessadas, mensagens confirmadas não serão reaplicadas e não haverá estado financeiro órfão.

### AC-006 — `SIGTERM` durante processamento

Dado uma mensagem em voo durante `SIGTERM`

Quando o shutdown for iniciado

Então novas mensagens não serão iniciadas, o processamento confirmado poderá receber `ack` e o processamento não confirmado ficará disponível para redelivery.

### AC-007 — Falha transitória

Dado um erro transitório antes do commit

Quando a mensagem for tentada novamente

Então não haverá efeito parcial e a política existente de retry/backoff será respeitada.

### AC-008 — Falha permanente

Dado um envelope inválido ou poison message

Quando a política classificar a falha como permanente

Então a mensagem seguirá para a DLQ, sem alterar saldo ou ledger, com diagnóstico estruturado.

### AC-009 — Invariável final

Dado qualquer cenário aprovado de concorrência, redelivery, crash ou restart

Quando a verificação terminar

Então `wallet.balance` será igual ao saldo reconstruído do ledger, as transações terminais estarão auditáveis e a Outbox persistida não terá eventos financeiros duplicados.

### AC-010 — Execução repetível

Dado um ambiente limpo ou isolado

Quando o comando de resiliência for executado duas vezes

Então ambos os ciclos terminarão com o mesmo conjunto de invariantes, sem depender de mensagens residuais de execuções anteriores.

## 8. Casos de erro e edge cases

- duas instâncias tentam inserir o mesmo Inbox ao mesmo tempo;
- a instância vencedora cai depois do commit e antes do ack;
- a instância perde a conexão com PostgreSQL antes do commit;
- uma mensagem fica em `PROCESSING` e a lease/visibilidade expira;
- o processo recebe `SIGTERM` enquanto aguarda PostgreSQL;
- o processo recebe `SIGTERM` enquanto aguarda SQS;
- a mensagem é redeliverada várias vezes depois de um resultado terminal;
- o mesmo `messageId` chega com payload diferente;
- a fila contém mensagens de wallets distintas durante uma falha de uma wallet quente;
- o broker fica indisponível durante o shutdown;
- o publisher da Outbox publica antes de cair e a confirmação do registro não acontece;
- o teste é interrompido e precisa ser repetido sem interpretar dados de outra execução;
- a DLQ contém mensagens de execuções anteriores;
- uma métrica ou logger falha e não deve mudar o resultado financeiro.

## 9. Fora de escopo desta feature

- Alterar regras financeiras, cálculos monetários ou contratos HTTP.
- Criar um segundo caso de uso para SQS.
- Trocar Inbox por cache, FIFO ou lock em memória.
- Implementar autenticação ou autorização.
- Criar dashboard ou integração obrigatória com OpenTelemetry.
- Alterar o backoff ou TTL já aprovados.
- Criar um endpoint público para injeção de falhas.
- Prometer exatamente uma entrega no SQS ou na Outbox.
- Teste de carga de dois minutos e relatório de p50/p95/p99; esse será tratado como entrega operacional separada após os cenários de resiliência.
- Alterar o `README.md` nesta rodada.

## 10. Suposições, perguntas abertas e sugestões

### Decisões fundamentadas no README e na arquitetura

- [x] A unidade de concorrência permanece `walletId`.
- [x] PostgreSQL e SQS devem ser reais em containers durante a verificação.
- [x] O Inbox persistente continua sendo a fonte da deduplicação.
- [x] O `ack` ocorre somente depois do commit.
- [x] Redelivery após commit é esperada e deve ser idempotente.
- [x] A invariável final compara saldo materializado com saldo reconstruído do ledger.
- [x] A autenticação continua fora do escopo.

### Sugestões para aprovação

- [x] **Orquestração:** executar os cenários com Docker Compose e três serviços de aplicação independentes, mantendo PostgreSQL e LocalStack compartilhados.
- [x] **Injeção de crash:** usar um hook somente de teste, configurado por variável de ambiente, que encerra o processo em pontos determinísticos; não adicionar rota administrativa.
- [x] **Ack observável:** usar um adapter SQS instrumentável no harness para bloquear ou sinalizar o intervalo entre commit e `DeleteMessage`.
- [x] **Recuperação de `PROCESSING`:** usar lease/visibilidade persistente e comprovar que uma mensagem abandonada não fica bloqueada indefinidamente.
- [x] **Comando:** adicionar `bun run test:resilience` para executar somente esta matriz, deixando `bun run test:load` para a entrega de carga.

Estas sugestões precisam ser aprovadas antes do plano e das tarefas. Nenhuma delas deve ser implementada silenciosamente se alterar schema, configuração pública ou ciclo de vida do processo.

## 11. Definition of Done desta feature

- [x] Esta Spec foi revisada e aprovada.
- [x] A matriz de cenários de três instâncias foi executada com PostgreSQL e LocalStack/MiniStack reais.
- [x] Entregas duplicadas concorrentes produziram no máximo um efeito financeiro.
- [x] Crash antes do commit permitiu redelivery sem efeitos parciais.
- [x] Crash depois do commit e antes do ack produziu replay seguro.
- [x] Reinício recuperou mensagens não confirmadas sem reaplicar mensagens confirmadas.
- [x] `SIGTERM` concluiu ou devolveu mensagens em voo corretamente.
- [x] Retry, DLQ e classificação de falhas permaneceram compatíveis com as regras existentes.
- [x] Cada cenário validou `wallet.balance == saldo reconstruído pelo ledger`.
- [x] Logs e métricas permitiram diagnosticar a sequência de entrega sem vazar payload sensível.
- [x] O comando de execução é repetível e isola os dados dos cenários.
- [x] Typecheck, build e regressão financeira passaram.
- [x] O plano e as tarefas foram executados uma a uma.
- [ ] Eu revisei e aprovei antes de considerar a feature pronta para a próxima fase.
