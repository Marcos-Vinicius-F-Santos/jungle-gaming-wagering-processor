# Spec da Feature — Teste de carga e capacidade operacional

Status: Implementação verificada — aguardando aprovação final  
Projeto: Distributed Wagering Processor  
Feature anterior: [`../11-resiliencia-sqs-inbox/spec.md`](../11-resiliencia-sqs-inbox/spec.md)  
Arquitetura: [`../../../ARCHITECTURE.md`](../../../ARCHITECTURE.md)  
README de referência: [`../../../README.md`](../../../README.md)  

> Esta feature mede o comportamento do sistema sob carga realista usando PostgreSQL, LocalStack e três instâncias da aplicação. Ela não altera regras financeiras, contratos HTTP, políticas de retry/DLQ ou a semântica do processamento; seu resultado é um experimento reproduzível de capacidade, latência e degradação.

## 1. Objetivo

Criar uma execução reproduzível de carga que permita observar throughput, latência, erros e sinais de contenção nas rotas financeiras HTTP, no processamento SQS/Inbox e na publicação da Outbox.

O teste deve produzir evidência suficiente para responder:

- qual volume sustentado foi obtido no ambiente medido;
- como a latência se distribuiu, incluindo p50, p95 e p99;
- se a concorrência sobre uma wallet provoca conflitos, saldo negativo ou duplicidade;
- se a carga gera redelivery, retry, DLQ ou backlog indevido;
- quanto tempo os eventos da Outbox levam para serem publicados;
- quais limites do ambiente impedem extrapolar o resultado para produção.

Não existe meta fixa de RPS. A qualidade da metodologia, a honestidade das limitações e a preservação das invariantes pesam mais que um número bruto de throughput.

## 2. Como funciona hoje

O projeto possui:

- endpoints HTTP para criação de wallet, submissão de transações, consultas e reconciliação;
- processamento financeiro síncrono com idempotência, optimistic locking, ledger e Outbox;
- consumidor SQS com Inbox persistente, lease, redelivery, retry e DLQ;
- publisher da Outbox e três instâncias reais no Compose de resiliência;
- harness repetível para cenários de concorrência, crash, restart, `SIGTERM` e falhas transitórias/permanentes;
- `bun run test:resilience` para a matriz de resiliência.

Ainda não existe `bun run test:load`, nem relatório padronizado com throughput, percentis, erros, conflitos de concorrência e outbox lag.

## 3. Requisitos funcionais

### FR-001 — Executar em infraestrutura real

O SISTEMA DEVE executar a carga contra PostgreSQL, LocalStack/MiniStack e três instâncias independentes da aplicação em Docker Compose. O caminho financeiro principal não pode ser substituído por mocks ou adapters em memória.

### FR-002 — Isolar dados da execução

Cada execução DEVE possuir um `runId` único e dados próprios para wallets, providers, transações, mensagens e eventos. A execução não pode depender de mensagens residuais nem apagar dados pertencentes a outras execuções.

### FR-003 — Oferecer cenários configuráveis

O comando DEVE permitir selecionar cenário, duração, aquecimento, concorrência e taxa de chegada por variáveis de ambiente ou argumentos documentados. Os valores padrão DEVEM ser os aprovados nesta Spec: 30 segundos de aquecimento e 2 minutos de medição por cenário.

### FR-004 — Medir throughput

O relatório DEVE registrar operações aceitas e concluídas por segundo, total enviado, total concluído, total rejeitado, total pendente e total que terminou em erro. A unidade usada em cada métrica DEVE ser explícita.

### FR-005 — Medir latência

O relatório DEVE registrar pelo menos p50, p95 e p99 da latência de cada cenário. A origem e o fim de cada medição DEVEM ser definidos, distinguindo quando possível:

- latência de resposta HTTP;
- latência de processamento financeiro;
- latência de entrega SQS até estado terminal;
- latência de publicação da Outbox.

### FR-006 — Medir erros e retries

O teste DEVE classificar erros por categoria, sem considerar toda resposta não-2xx como falha indistinta. O relatório DEVE distinguir payload inválido, conflito de idempotência, rejeição de negócio, falha de infraestrutura, timeout, retry, redelivery e DLQ.

### FR-007 — Medir contenção de concorrência

O teste DEVE registrar conflitos de optimistic locking, retries de concorrência e falhas de claim/lease quando disponíveis. O cenário de wallet quente DEVE exercer operações simultâneas sobre a mesma wallet, sem permitir saldo negativo ou efeito financeiro duplicado.

### FR-008 — Medir Outbox lag

O teste DEVE registrar a quantidade de eventos pendentes e o atraso entre `occurredAt` e publicação confirmada. O relatório DEVE indicar o maior lag observado e, quando aplicável, o backlog no início, durante e ao final da medição.

### FR-009 — Validar invariantes financeiras

Ao final de cada cenário, o harness DEVE verificar, no mínimo:

- `wallet.balance == saldo reconstruído pelo ledger`;
- nenhum débito ou crédito duplicado para a mesma operação;
- no máximo um efeito financeiro por chave de idempotência e transação externa;
- Inbox e Outbox sem duplicidade financeira incompatível;
- ausência de saldo negativo;
- ausência de mensagens inesperadas na DLQ.

### FR-010 — Produzir relatório reproduzível

O comando `bun run test:load` DEVE emitir resumo em terminal e salvar relatório estruturado contendo configuração, ambiente, duração, métricas, invariantes, falhas e limitações. O formato deve permitir comparação entre execuções sem depender de leitura manual dos logs completos.

### FR-011 — Respeitar desligamento e limpeza segura

O teste DEVE encerrar os geradores, aguardar a drenagem observável dentro do limite configurado e preservar diagnóstico em caso de falha. A limpeza só pode remover dados criados pelo próprio `runId` ou usar ambiente isolado descartável, sem apagar volumes ou dados fora do escopo.

## 4. Modelo de execução

### 4.1 Ciclo de cada cenário

Cada cenário deve seguir este ciclo:

1. validar dependências e registrar versões/configuração;
2. subir ou confirmar PostgreSQL, LocalStack/MiniStack e três instâncias;
3. criar dados exclusivos do `runId`;
4. executar aquecimento de 30 segundos sem compor os resultados principais;
5. executar medição por 2 minutos;
6. parar a geração de novas operações;
7. aguardar processamento, publicação e estabilização dentro do timeout;
8. consultar métricas e invariantes no banco e nas filas;
9. salvar o relatório e registrar o resultado do cenário;
10. limpar somente os dados ou serviços isolados da execução.

### 4.2 Cenários mínimos

#### Cenário A — Throughput distribuído

Enviar operações válidas para wallets distintas, distribuídas entre as três instâncias, medindo o caminho assíncrono SQS/Inbox e a publicação da Outbox. O objetivo é estimar throughput sustentado sem transformar uma única wallet em gargalo artificial.

#### Cenário B — Wallet quente e concorrência

Enviar operações concorrentes para uma mesma wallet com saldo suficiente e chaves únicas. O objetivo é medir contenção, retries de optimistic locking e latência sob disputa, preservando um resultado financeiro determinístico.

#### Cenário C — Replay e redelivery controlados

Reenviar operações idempotentes e provocar redelivery dentro do mecanismo já existente, sem usar fault injection de produção. O objetivo é medir o custo operacional de replay, confirmar ausência de segundo efeito e observar Inbox, retries e métricas de diagnóstico.

#### Cenário D — Outbox sob carga

Gerar operações que produzam eventos e observar o publisher concorrente. O objetivo é medir backlog, throughput de publicação, p95/p99 do Outbox lag e comportamento quando a publicação fica temporariamente mais lenta que a produção.

Os cenários podem compartilhar a infraestrutura, mas os dados e os relatórios devem permanecer identificáveis por `runId` e `scenarioId`.

## 5. Métricas e relatório

O relatório deve conter, por cenário:

| Grupo | Métricas mínimas |
|---|---|
| Execução | `runId`, `scenarioId`, commit/build, data, duração, aquecimento, concorrência, taxa configurada e instâncias |
| Throughput | enviadas/s, aceitas/s, processadas/s, publicadas/s, totais e backlog final |
| Latência | HTTP p50/p95/p99, processamento p50/p95/p99, SQS p50/p95/p99, Outbox lag p50/p95/p99 quando mensurável |
| Correção | saldo final, saldo reconstruído, transações, ledger, Inbox, Outbox, replays e duplicidades |
| Concorrência | lock conflicts, retries, claims rejeitados, leases recuperadas e redeliveries |
| Falhas | respostas por classe, timeouts, falhas de infraestrutura, retries, DLQ e mensagens não drenadas |
| Recursos | CPU/memória das instâncias, PostgreSQL, LocalStack e limites relevantes do host, quando disponíveis |

O relatório DEVE separar:

- resultado medido;
- erro de medição ou dado incompleto;
- inferência sobre gargalo;
- limitação que impede generalização.

Nenhum relatório deve incluir segredos, receipt handles, payload financeiro completo ou dados pessoais desnecessários.

## 6. Regras de negócio e operação

### BR-001 — O teste não altera a regra financeira

O teste de carga não pode criar uma segunda implementação financeira, relaxar validações, desabilitar idempotência, reduzir a proteção de concorrência ou alterar o contrato HTTP/SQS para obter maior throughput.

### BR-002 — Infraestrutura real

PostgreSQL e LocalStack/MiniStack permanecem como dependências reais do caminho exercitado. Mocks podem existir somente para telemetria auxiliar que não substitua o fluxo sob medição.

### BR-003 — Sem meta artificial de RPS

Não haverá um limiar universal de aprovação. A taxa deve ser informada, controlada e comparável; o relatório deve explicar saturação, rejeições e limites observados.

### BR-004 — Invariantes têm precedência

Um cenário com throughput alto, mas que viole saldo, ledger, Inbox, Outbox ou idempotência, é falha independentemente do número de operações por segundo.

### BR-005 — Dados e carga são controláveis

O gerador deve possuir limite de concorrência, taxa e duração para evitar consumo ilimitado de recursos. Toda execução deve poder ser interrompida com segurança.

### BR-006 — Logs e métricas de baixa cardinalidade

Identificadores individuais podem existir no diagnóstico amostrado, mas não devem ser usados como tags de alta cardinalidade em métricas agregadas. Payload financeiro completo e segredos não podem ser registrados.

## 7. Critérios de aceite

### AC-001 — Execução real

Dado um ambiente Docker Compose válido, quando `bun run test:load` for executado, então PostgreSQL, LocalStack/MiniStack e três instâncias reais participarão do cenário sem substituir o fluxo por mocks.

### AC-002 — Ciclo padronizado

Dado um cenário habilitado, quando a medição iniciar, então haverá 30 segundos de aquecimento, 2 minutos de medição e uma fase explícita de drenagem/validação.

### AC-003 — Relatório de latência

Dado um cenário concluído, então o relatório conterá p50, p95 e p99 para as latências aplicáveis, com unidade, origem e fim da medição.

### AC-004 — Relatório de throughput e erros

Dado um cenário concluído, então o relatório conterá throughput, totais, taxa de erro e classificação de rejeições, retries, redeliveries e DLQ.

### AC-005 — Wallet quente sem corrupção

Dado o cenário de concorrência sobre uma mesma wallet, então não haverá saldo negativo, débito/crédito duplicado ou divergência entre saldo materializado e ledger.

### AC-006 — Replay sem segundo efeito

Dado o cenário de replay/redelivery, então operações repetidas manterão um único efeito financeiro e o relatório registrará o custo de replay observado.

### AC-007 — Outbox observável

Dado o cenário de Outbox sob carga, então o relatório conterá backlog e outbox lag, e eventos financeiros não serão publicados com duplicidade incompatível.

### AC-008 — Execução repetível

Dado o mesmo ambiente e configuração, quando o comando for executado novamente com outro `runId`, então a execução não dependerá de dados residuais e produzirá relatório comparável.

### AC-009 — Falha de capacidade é diagnosticável

Dado que o ambiente sature ou o cenário falhe, então o comando terminará com diagnóstico estruturado, preservará o relatório parcial e não declarará sucesso quando uma invariante não puder ser verificada.

### AC-010 — Limpeza segura

Dado um cenário concluído ou interrompido, então a limpeza removerá somente recursos da execução ou do ambiente isolado, sem apagar volumes ou dados externos ao teste.

## 8. Casos de erro e edge cases

- PostgreSQL indisponível antes do aquecimento;
- LocalStack/MiniStack indisponível antes ou durante a medição;
- uma das três instâncias ficar unhealthy;
- gerador atingir timeout ou limite de memória;
- fila não drenar dentro do timeout;
- aumento de backlog da Outbox durante a medição;
- lock conflicts acima do esperado, sem violação financeira;
- resposta HTTP perdida após commit e reenviada pelo gerador;
- redelivery ou replay acima do padrão;
- DLQ não vazia ao final;
- percentis sem amostras suficientes;
- relatório parcial após interrupção ou `SIGTERM`.

## 9. Fora de escopo desta feature

- teste de produção ou de serviços externos reais;
- definição de SLO, meta universal de RPS ou capacidade comercial;
- otimização automática de queries, índices ou pool;
- alteração de regras financeiras, contrato HTTP, envelope SQS, retry, DLQ ou TTL;
- autenticação, autorização ou criação de usuários;
- teste de longa duração contínua, soak test ou chaos test além dos cenários definidos;
- dashboard permanente ou sistema de observabilidade de produção;
- apagar volumes Docker ou dados que não pertençam à execução.

## 10. Suposições, perguntas abertas e sugestões

### Decisões fundamentadas no README e na arquitetura

- O README classifica o teste de carga como diferencial opcional e não define meta de RPS.
- O `ARCHITECTURE.md` define aquecimento de 30 segundos, medição de 2 minutos por cenário, Compose, PostgreSQL, LocalStack e três instâncias.
- O comando público será `bun run test:load`, conforme o README.
- O resultado deve registrar throughput, p50/p95/p99, taxa de erro, conflitos de concorrência e outbox lag.
- A invariável financeira continua sendo `wallet.balance == saldo reconstruído pelo ledger`.
- O health permanece aberto e a autenticação continua fora desta feature.

### Sugestões para aprovação

- [x] Aprovar os quatro cenários mínimos: throughput distribuído, wallet quente, replay/redelivery e Outbox sob carga.
- [x] Aprovar relatório em JSON para dados estruturados e Markdown/texto para resumo humano.
- [x] Aprovar execução padrão sequencial por cenário, com opção explícita de selecionar um cenário isolado.
- [x] Aprovar que a primeira implementação use apenas limites configuráveis, sem meta fixa de RPS.
- [x] Aprovar que falha de invariantes seja bloqueadora mesmo quando as métricas de capacidade forem boas.

## 11. Definition of Done desta feature

- [ ] `bun run test:load` existe e está documentado.
- [ ] Os quatro cenários mínimos executam com PostgreSQL, LocalStack/MiniStack e três instâncias reais.
- [ ] Cada cenário executa aquecimento, medição e drenagem conforme esta Spec.
- [ ] Relatórios registram throughput, p50/p95/p99, erros, conflitos, retries, DLQ e outbox lag.
- [ ] O cenário de wallet quente preserva saldo, ledger e idempotência.
- [ ] O cenário de replay/redelivery não cria segundo efeito financeiro.
- [ ] A execução é repetível e isola dados por `runId`.
- [ ] Falhas produzem relatório parcial e código de saída não-zero quando aplicável.
- [ ] Não há alteração de regras financeiras ou contratos públicos.
- [ ] Metodologia, ambiente, resultados e limitações estão documentados no `ARCHITECTURE.md` ou relatório da entrega.
- [ ] A Spec, o plano e as tarefas foram revisados e aprovados antes da implementação.
