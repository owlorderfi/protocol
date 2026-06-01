# OwlOrderFi

Self-custodial limit, DCA, TWAP and ladder orders on EVM L2s.

Users sign an off-chain order intent (price trigger, time schedule,
ladder distribution, or a combination). The router contract enforces
what the user signed on-chain when a keeper bot executes. Funds stay
in the user's wallet between trades — the router holds nothing.

Four execution modes:

- **Limit** — fire when a price trigger is hit.
- **DCA** — execute a fixed amount on a recurring schedule over a
  period you set.
- **TWAP** — split a large order into N slices over a bounded window
  to minimize market impact.
- **Ladder** — place a series of limit rungs across a price range to
  scale in or out gradually.

All four share the same EIP-712 signature flow and fee model. DCA and
TWAP share a single `executeScheduledOrder` contract primitive; limit
and ladder rungs share `executeLimitOrder`.

---

> **Status** — live on Base + Polygon mainnets since 2026-05-31.
>
> The source is open and stays that way. Every contract change runs
> through Slither and Aderyn static analysis (baselines committed under
> `contracts/audit/`) and an independent reviewer pass before deploy.
> A third-party audit is on the roadmap as revenue allows. Until then,
> review what's relevant to your level of comfort — see
> [SECURITY.md](./SECURITY.md) for the vulnerability disclosure process.

---

## How it works

1. **User signs an order off-chain** — token in, token out, amount,
   minimum output, trigger price. Signature is an EIP-712 typed-data
   message; the router contract verifies it on execution.
2. **Keeper monitors prices** — polls Uniswap V3 QuoterV2 on-chain.
   When the trigger condition is met, it builds an execute transaction.
3. **Router executes** — pulls the user's tokens via the signed
   approval, swaps through the best-priced route (single-hop or
   multi-hop across V3 fee tiers), and enforces the user-signed
   `minAmountOut`. If the actual output would fall below that, the
   transaction reverts. The user's funds are never at risk of slippage
   beyond what they signed.
4. **Free cancel anytime** — off-chain cancel by deleting the order
   record; on-chain `cancelOrder` invalidates the nonce so a stale
   signature cannot be replayed.

## Repository layout

```text
owlorderfi/
├── apps/
│   ├── web/         React + Vite + Tailwind + wagmi/viem + RainbowKit
│   ├── api/         NestJS (Fastify) + Prisma + PostgreSQL
│   └── keeper/      Node.js worker — price polling + order execution
├── contracts/
│   ├── src/         Solidity 0.8.20+ — LimitOrderRouter, libraries
│   ├── test/        Foundry tests (forge test)
│   ├── script/      Foundry deployment scripts
│   └── audit/       Static-analysis reports (Slither, Aderyn)
├── packages/
│   └── shared/      Zod schemas + TypeScript types shared FE ↔ BE
├── docker-compose.yml   PostgreSQL for local development
└── package.json         pnpm workspaces + Turborepo
```

## Tech stack

| Layer | Tech |
| --- | --- |
| Smart contracts | Solidity 0.8.20+, Foundry, OpenZeppelin v5 |
| Backend | NestJS (Fastify), TypeScript, Prisma |
| Database | PostgreSQL 16 |
| Frontend | React 18, Vite, Tailwind 3 |
| Web3 client | viem + wagmi + RainbowKit |
| Validation | Zod (shared frontend ↔ backend) |
| Auth | SIWE-style wallet signature + JWT (no passwords; nonce-based, single-use) |
| Monorepo | pnpm workspaces + Turborepo |

## Quick start (local development)

Requirements: Node.js 22+, pnpm 11+, Docker (for PostgreSQL), Foundry
(for the contracts), a local Anvil instance.

```bash
# 1. Install dependencies
pnpm install

# 2. Start PostgreSQL
docker compose up -d

# 3. Copy env templates and fill in placeholders
cp .env.example .env
cp apps/api/.env.example apps/api/.env
cp apps/keeper/.env.example apps/keeper/.env
cp contracts/.env.example contracts/.env

# 4. Build everything
pnpm build

# 5. Run all apps in dev mode (parallel via Turborepo)
pnpm dev

# 6. Run tests
pnpm test                    # JS/TS tests
forge test --root contracts  # Solidity tests
```

The frontend defaults to `http://localhost:5173`, the API to `:4001`,
and the keeper's health endpoint to `:4002`.

## Features

| Feature | Description |
| --- | --- |
| Self-custody | Funds stay in your wallet between trades; the router holds nothing |
| Signed orders (EIP-712) | `minAmountOut` is signed off-chain; the contract enforces it on-chain |
| Aggregator allowlist | Swaps route only through an owner-curated set of routers — never arbitrary calldata |
| Best-rate routing | Quotes all four Uniswap V3 fee tiers + multi-hop paths and picks the highest output |
| Adaptive slippage | Recommendation scales with the pool's recent volatility |
| Tiered fees | 30 bps default; drops to 15 bps on larger orders |
| Tx-cost covered by keeper | The user never funds a keeper wallet or manages gas |
| Always cancellable | Free off-chain cancel; on-chain cancel invalidates the nonce |
| Emergency pause | Operator can halt execution in seconds (`Pausable`); cancels stay enabled |
| Jurisdictional access control | Cloudflare-edge geo-block (OFAC Big 4 + EU sanctioned sub-national regions) + frontend overlay |
| Smart-account ready | EIP-7702 delegated EOAs supported via a dedicated unwrap path |

## Security

- Static analysis baselines (Slither, Aderyn) live under
  `contracts/audit/` and are reproducible from the working tree.
- Server-side jurisdictional access check lives in `apps/api/src/geo/`
  (paired with edge-level Cloudflare custom rules at deploy time).
- See [SECURITY.md](./SECURITY.md) for the vulnerability disclosure
  process.

## License

[Business Source License 1.1](./LICENSE) — source-available with a
two-year non-compete window. Converts to MIT on the Change Date listed
in the LICENSE file. Non-commercial, educational, and research use is
granted immediately.
