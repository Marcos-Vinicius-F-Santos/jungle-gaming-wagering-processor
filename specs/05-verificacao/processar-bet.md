# Verificação Operacional — Processar BET

Status: Verificação executada — aguardando revisão e aprovação de Marcos.

## Pré-requisitos

- Bun 1.4.3 instalado.
- Docker Desktop/PostgreSQL local disponível.
- Dependências instaladas com o lockfile do projeto.
- O banco deve estar com as migrations aplicadas.

## Comandos executados

Na raiz `E:\Projects\jungleGaming`:

```bash
bun run migration:down
bun run migration:up
bun run typecheck
bun run build
bun run test
```

O ciclo `down/up` da migration `Migration20261015200000` passou. Typecheck, build e a suíte completa passaram com 46 testes e 0 falhas.

## Roteiro funcional

1. Criar uma wallet positiva com `POST /wallets`.
2. Enviar `POST /wagering/transactions` com `kind = BET`, `money.amount` como string e `Idempotency-Key`.
3. Confirmar `201`, `PROCESSED`, saldo resultante e um único `DEBIT`.
4. Repetir a mesma requisição e confirmar `200`, `idempotentReplay = true` e o snapshot original.
5. Reutilizar a key com payload diferente e confirmar `409`, sem novo efeito.
6. Enviar BET acima do saldo e confirmar `422/INSUFFICIENT_FUNDS`, sem débito.
7. Enviar wallet inexistente e confirmar `404`, sem transação financeira persistida.
8. Confirmar `400` para payload inválido ou key ausente.
9. Confirmar `503` para esgotamento de optimistic locking.

## Regras de recuperação

- Não editar schema diretamente; usar migration reversível.
- Se a migration falhar antes da conclusão, investigar o banco e executar o caminho de rollback aprovado antes de reaplicar.
- Falha durante BET deve fazer rollback integral de transação, wallet e ledger.
- Nunca alterar ou apagar lançamento do ledger para corrigir saldo.
- Uma resposta não confirmada deve ser reprocessada com a mesma `Idempotency-Key`; o replay deve devolver o resultado persistido sem novo débito.
- Não há procedimento de deploy nesta rodada.
