# Polyorder

Limit orders and stop-loss execution layer for Polygon DEXes.

## Architecture

Monorepo cu **pnpm workspaces + Turborepo**:

```
polyorder/
├── apps/
│   ├── web/         React + Vite + Tailwind + shadcn/ui + wagmi/viem
│   ├── api/         NestJS + Fastify + Prisma + Postgres
│   └── keeper/      Node.js worker — chain listener + order executor
├── contracts/       Foundry workspace (Solidity 0.8.20+)
├── packages/
│   ├── shared/      Zod schemas + TS types shared across apps
│   ├── abi/         Contract ABIs exported from contracts/
│   └── ui/          (Optional) shadcn components reusable
└── docs/            Architecture, deployment, dev setup
```

## Stack

| Layer | Tech |
|-------|------|
| Smart contracts | Solidity 0.8.20+ / Foundry / OpenZeppelin v5 |
| Backend | NestJS (Fastify adapter) + TypeScript + Prisma |
| Database | PostgreSQL 16 |
| Frontend | React 19 + Vite + Tailwind 4 + shadcn/ui |
| Web3 client | viem + wagmi + RainbowKit |
| Validation | Zod (shared FE + BE) |
| Monorepo | pnpm workspaces + Turborepo |
| Auth | Wallet signature + JWT (Argon2id for any password fields) |
| Hosting | Self-hosted (Caddy reverse proxy + Let's Encrypt) |

## Quick start

```bash
# Install all workspace deps
pnpm install

# Run all apps in dev mode (parallel via Turborepo)
pnpm dev

# Build all
pnpm build

# Lint everything
pnpm lint

# Test everything
pnpm test
```

## Status

🚧 **Phase 0**: Project skeleton (current)

See [docs/ROADMAP.md](./docs/ROADMAP.md) for full timeline.

## License

MIT
