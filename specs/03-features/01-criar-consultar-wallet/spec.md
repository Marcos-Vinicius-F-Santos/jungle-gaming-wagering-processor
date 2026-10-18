# Spec da Feature — Criar e consultar Wallet com saldo inicial

Status: Concluída e aprovada em 2026-10-15
Projeto: Distributed Wagering Processor
Onde vive no código: `src/modules/wallets/` e adapters HTTP/persistência correspondentes
Spec do produto: [`../../01-produto/spec.md`](../../01-produto/spec.md)
Arquitetura: [`../../02-arquitetura/arquitetura.md`](../../02-arquitetura/arquitetura.md)

## 1. Objetivo

Permitir criar uma wallet para um player em uma moeda e consultar seu saldo materializado e sua versão.

Esta é a primeira fatia vertical do produto. Ela estabelece `Money`, o aggregate `Wallet`, a unicidade de `(playerId, currency)`, a transação interna `OPENING` quando houver saldo inicial positivo e o primeiro lançamento imutável do ledger.

## 2. Como funciona hoje

O projeto é greenfield. Não existe comportamento anterior de wallet que precise ser preservado ou alterado.

## 3. Requisitos funcionais

### FR-001 — Criar wallet

QUANDO o cliente enviar `POST /wallets` com `playerId` UUID e `initialBalance` válidos

O SISTEMA DEVE criar uma wallet com identificador interno, player, moeda, saldo inicial e `version = 1`.

O identificador interno da wallet deve ser gerado como UUIDv7, conforme o formato de identificadores exemplificado no README do desafio.

### FR-002 — Persistir saldo inicial positivo

QUANDO a wallet for criada com saldo inicial maior que zero

O SISTEMA DEVE persistir, na mesma transação SQL, a wallet, uma transação interna `OPENING` e um `WalletLedgerEntry` de direção `CREDIT`.

### FR-003 — Criar wallet sem saldo inicial

QUANDO a wallet for criada com saldo inicial `0.00`

O SISTEMA DEVE criar a wallet com saldo zero e não deve gerar lançamento financeiro sem efeito.

### FR-004 — Proteger wallet duplicada

QUANDO já existir uma wallet para o mesmo `(playerId, currency)`

O SISTEMA DEVE rejeitar a criação como conflito e não deve criar uma segunda wallet, `OPENING` ou lançamento de ledger.

### FR-005 — Consultar wallet

QUANDO o cliente enviar `GET /wallets/:walletId` para uma wallet existente

O SISTEMA DEVE retornar o identificador, `playerId`, saldo, moeda e `version` persistidos.

### FR-006 — Informar wallet inexistente

QUANDO o cliente consultar um `walletId` que não existe

O SISTEMA DEVE retornar uma resposta de recurso não encontrado sem alterar o banco.

### FR-007 — Validar dinheiro

QUANDO o cliente enviar um saldo inicial inválido

O SISTEMA DEVE rejeitar a requisição antes de persistir qualquer wallet, transação ou lançamento.

São inválidos, conforme o contrato do produto, string vazia, `NaN`, `Infinity`, notação científica, mais de duas casas decimais e valores negativos.

### FR-008 — Garantir atomicidade

QUANDO ocorrer qualquer falha durante a criação da wallet, do `OPENING` ou do lançamento

O SISTEMA DEVE desfazer todas as escritas da operação, sem deixar wallet parcial, `OPENING` órfão ou ledger inconsistente.

### FR-009 — Proteger concorrência na criação

QUANDO duas ou mais requisições tentarem criar simultaneamente uma wallet para o mesmo `(playerId, currency)`

O SISTEMA DEVE permitir no máximo uma criação confirmada, usando a constraint de unicidade do PostgreSQL como garantia final.

### FR-010 — Normalizar moeda

QUANDO o cliente enviar uma moeda em caixa baixa ou mista, mas com código ISO-4217 válido

O SISTEMA DEVE normalizar o código para maiúsculas antes da validação de domínio e persistência.

QUANDO a moeda não for um código ISO-4217 de três letras

O SISTEMA DEVE rejeitar a requisição com `400`.

## 4. Regras de negócio

### BR-001 — Representação monetária

O valor deve ser recebido e serializado como string decimal com duas casas e persistido com precisão exata em `NUMERIC(19,2)`. A moeda deve ser persistida em coluna separada.

### BR-002 — Saldo não negativo

O saldo inicial não pode ser negativo. A validação deve existir no domínio e ser reforçada por constraint do banco.

### BR-003 — Moeda da wallet

Uma wallet é identificada pelo par `(playerId, currency)`. A mesma pessoa pode ter wallets em moedas diferentes, mas não duas wallets na mesma moeda. O `playerId` de entrada deve ser UUID.

### BR-003.1 — Formato da moeda

O código de moeda deve ser ISO-4217 com três letras. A camada HTTP normaliza o valor para maiúsculas antes de passá-lo ao caso de uso; valores que não sejam ISO-4217 são rejeitados.

### BR-004 — Versão inicial

Uma wallet recém-criada começa com `version = 1`. A criação não faz optimistic locking retry; a unicidade é garantida pela constraint do banco.

### BR-005 — `OPENING` interno

`OPENING` não é aceito como entrada da API. Ele é criado internamente quando `initialBalance.amount` for maior que zero.

### BR-006 — Ledger imutável

O `OPENING` positivo gera exatamente um lançamento `CREDIT`, com `balanceBefore = 0.00` e `balanceAfter = initialBalance`. Lançamentos não podem ser atualizados ou excluídos.

### BR-007 — Atomicidade

Wallet, `OPENING` e ledger devem ser confirmados ou desfeitos juntos na mesma transação SQL.

### BR-008 — Identificador interno

IDs internos de wallet devem ser UUIDv7. O formato favorece ordenação temporal e segue o padrão de identificadores usado nos exemplos do desafio.

## 5. Contrato HTTP

### Criar

```http
POST /wallets
Content-Type: application/json
```

```json
{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": {
    "amount": "1000.00",
    "currency": "BRL"
  }
}
```

Resposta de sucesso:

```json
{
  "id": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "balance": {
    "amount": "1000.00",
    "currency": "BRL"
  },
  "version": 1
}
```

Status recomendado:

- `201` para criação confirmada;
- `400` para payload ou dinheiro inválido;
- `409` para wallet duplicada;
- `503` para falha transitória de infraestrutura sem confirmação do commit.

### Consultar

```http
GET /wallets/:walletId
```

Resposta de sucesso: o mesmo formato de wallet mostrado acima. Para `walletId` inexistente, retornar `404`.

Nesta feature, a consulta pública do ledger fica fora do endpoint de criação/consulta de wallet; a existência e a consistência do `OPENING` serão verificadas por testes de integração e pelo endpoint de ledger previsto para uma feature posterior.

## 6. Critério de aceite

### AC-001 — criação com saldo inicial positivo

Dado um `playerId` sem wallet em `BRL`

Quando o cliente enviar `POST /wallets` com `initialBalance.amount = "1000.00"` e `currency = "BRL"`

Então o sistema deve retornar `201`, criar a wallet com saldo `1000.00` e `version = 1`, persistir uma transação `OPENING` e persistir exatamente um crédito no ledger com saldo anterior `0.00` e posterior `1000.00`.

### AC-002 — criação com saldo zero

Dado um `playerId` sem wallet em `BRL`

Quando o cliente enviar `POST /wallets` com `initialBalance.amount = "0.00"`

Então o sistema deve criar a wallet com saldo `0.00` e `version = 1`, sem criar lançamento de ledger sem efeito.

### AC-003 — consulta de wallet existente

Dado uma wallet criada com saldo inicial `1000.00 BRL`

Quando o cliente enviar `GET /wallets/:walletId`

Então o sistema deve retornar `200` com `id`, `playerId`, saldo `1000.00 BRL` e `version = 1`.

### AC-004 — wallet duplicada

Dado que já existe uma wallet para o mesmo `playerId` e `currency`

Quando o cliente tentar criá-la novamente

Então o sistema deve retornar `409` e não deve criar nova wallet, `OPENING` ou lançamento de ledger.

### AC-005 — dinheiro inválido

Dado um payload com valor negativo, mais de duas casas, notação científica ou moeda ausente

Quando o cliente enviar `POST /wallets`

Então o sistema deve retornar `400` e não deve persistir nenhuma parte da operação.

### AC-006 — wallet inexistente

Dado um `walletId` que não está persistido

Quando o cliente enviar `GET /wallets/:walletId`

Então o sistema deve retornar `404` sem alterar o banco.

### AC-007 — criação concorrente

Dado que não existe wallet para um `playerId` e uma moeda

Quando duas requisições válidas forem processadas simultaneamente

Então no máximo uma deve retornar sucesso, a outra deve retornar conflito e o banco deve conter uma única wallet, um único `OPENING` e um único lançamento inicial.

### AC-008 — UUID e normalização de moeda

Dado um `playerId` UUID e uma moeda válida enviada como `brl`

Quando o cliente enviar `POST /wallets`

Então o sistema deve aceitar a requisição, persistir a moeda como `BRL` e retornar um identificador de wallet UUIDv7.

### AC-009 — moeda inválida

Dado um valor de moeda com tamanho diferente de três letras ou que não corresponda a um código ISO-4217

Quando o cliente enviar `POST /wallets`

Então o sistema deve retornar `400` e não deve persistir wallet, `OPENING` ou ledger.

## 7. Casos de erro / edge cases

- `playerId` ausente, não-UUID ou inválido conforme o DTO → `400`, sem escrita.
- `initialBalance` ausente ou incompleto → `400`, sem escrita.
- moeda em formato ISO-4217 válido, mas em caixa baixa/mista → normalizar para maiúsculas e prosseguir.
- moeda ausente, com tamanho diferente de três letras ou que não seja ISO-4217 → `400`, sem escrita.
- `amount` como número JSON em vez de string → `400`, sem escrita.
- falha de conexão ou timeout no PostgreSQL antes do commit → `503`, sem garantir sucesso ao cliente.
- erro depois do commit, mas antes da resposta HTTP → uma repetição deve ser tratada pela consulta/identidade da wallet sem criar nova wallet.
- duas wallets do mesmo player em moedas diferentes → permitido.
- duas requisições concorrentes com mesmo player e moeda → uma única criação confirmada pela constraint.

## 8. Fora de escopo desta feature

- processamento de `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`;
- idempotência por `Idempotency-Key` para transações de aposta;
- consumo SQS, Inbox, Outbox e workers;
- autenticação;
- endpoint público de consulta paginada do ledger;
- reconciliação;
- optimistic locking durante alterações de saldo posteriores;
- teste de carga completo. Esta feature deve ter testes de integração e concorrência de criação; o teste de carga pertence à entrega definida na arquitetura.

## 9. Suposições e perguntas abertas

- [x] `playerId` será obrigatoriamente UUID.
- [x] A API normalizará moedas válidas para maiúsculas e rejeitará valores que não sejam códigos ISO-4217 de três letras.
- [x] IDs internos serão gerados como UUIDv7, seguindo o formato exemplificado no README do desafio.
- [x] Para esta feature, os status definitivos são `201`, `400`, `404`, `409` e `503`, conforme o tipo de resultado. Outros status do README permanecem aplicáveis às features que tiverem rejeição de negócio ou processamento pendente.

Não há perguntas abertas específicas desta feature nesta rodada. Qualquer decisão posterior que altere schema, contrato público ou limite de módulo deve ser registrada antes da implementação.

## 10. Definition of Done desta feature

- [x] Esta spec foi revisada e aprovada.
- [x] O plano e as tarefas foram criados e aprovados.
- [x] Migration reversível cria wallet, transação `OPENING` e ledger com constraints necessárias.
- [x] `Money`, `Wallet`, `WagerTransaction` e `WalletLedgerEntry` têm testes unitários das regras usadas nesta feature.
- [x] Criação positiva, criação zero, consulta, duplicidade, payload inválido e wallet inexistente foram testados.
- [x] Concorrência real na criação confirma no máximo uma wallet e um `OPENING`.
- [x] A atomicidade foi verificada com PostgreSQL real.
- [x] Features existentes continuam funcionando; neste projeto greenfield, a regressão mínima é a execução completa dos testes existentes.
- [x] Eu revisei e aprovei antes de considerar a feature pronta para a próxima fase.
