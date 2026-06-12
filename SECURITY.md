# Security Policy

OwlOrderFi is open-source and the source is the audit you have today.
Static-analyzer reports (Slither, Aderyn) are committed under
[`contracts/audit/`](./contracts/audit) and reproducible from the
working tree; every contract change runs through them before deploy.
A third-party audit is on the roadmap as revenue allows.

Security reports from anyone reviewing the code or running a deployment
are welcome and taken seriously. We respond to every credible one.

## Order cancellation guarantee

Cancellation is a custody-adjacent promise, so we state exactly what the
code guarantees:

- **Cancel before execution begins → execution is guaranteed not to
  happen.** An off-chain cancel and the keeper's "begin executing" step
  are mutually exclusive: both are a single atomic compare-and-swap on
  the same order row, so exactly one wins. If your cancel wins, the
  keeper's attempt to claim the order returns zero rows and it skips the
  order entirely — no swap is ever built or broadcast.

- **Cancel while the keeper is already executing → best-effort
  cooperative abort.** Once the keeper has claimed an order, your cancel
  is recorded as an abort request rather than refused. The keeper
  re-reads that request as late as possible — immediately before
  broadcasting the transaction — and stops if the swap has not gone out
  yet, cancelling the order for free with no on-chain transaction. The
  only way this loses is if the swap is already broadcast, a sub-second
  window, in which case the order fills.

- **Scheduled (TWAP / DCA) slices** apply the same last-mile re-check
  before each slice is broadcast.

- **On-chain cancel is always final.** Calling
  `LimitOrderRouter.cancelOrder(nonce)` from your wallet consumes the
  nonce on-chain, so no future execution of that order is possible
  regardless of keeper or API state. Use it when you want a guarantee
  that does not depend on our infrastructure.

We never knowingly execute an order you cancelled before execution
began. A report of an order that filled after a confirmed
pre-execution cancel is treated as Critical.

## Reporting a vulnerability

**Please do not open public GitHub issues for security bugs.**

Preferred channel — [GitHub Security Advisories](https://github.com/owlorderfi/protocol/security/advisories/new).
Submit a private report; we receive a notification and respond.

Alternative — email <security@owlorderfi.com> (forwarded to the
maintainer). Use this if you don't have a GitHub account or prefer
to stay outside the platform. PGP-encrypted reports welcome; key on
request.

A good report includes:

- The affected component (smart contract, API, keeper, web)
- Steps to reproduce
- Impact assessment (what an attacker could achieve)
- Suggested fix, if you have one

## Response timeline

| Severity | First response | Fix target |
|---|---|---|
| Critical (funds at risk) | Within 24 hours | Within 7 days |
| High (degraded safety guarantees) | Within 72 hours | Within 30 days |
| Medium / Low | Within 1 week | Best effort |

We acknowledge receipt before triaging, so you know the report did not
get lost.

## Disclosure

We follow coordinated disclosure:

1. You report privately.
2. We confirm, triage, and develop a fix.
3. We notify any deployed users (if applicable) and ship the fix.
4. After a reasonable window (typically 30 days, or sooner if the fix
   is already deployed), the advisory becomes public.

You will be credited in the advisory unless you ask to remain
anonymous.

## Bounty

We do not currently fund a bug bounty program. We do offer:

- Public credit in the security advisory
- A mention in the repository's `THANKS` file once we have enough
  contributors to warrant one
- Coordination with prospective post-audit bounty providers if a
  formal program is set up later

## Scope

In scope:

- Smart contracts in `contracts/src/`
- API code in `apps/api/`
- Keeper bot code in `apps/keeper/`
- Frontend code in `apps/web/`
- Anything that could lead to loss of user funds, unauthorized order
  execution, fee theft, or denial of service

Out of scope:

- Theoretical attacks without a working proof of concept
- Vulnerabilities in third-party dependencies that have already been
  reported upstream
- Attacks requiring physical access or social engineering of the
  operator
- Issues in test infrastructure, local development tooling, or
  example configuration
- Self-XSS, clickjacking on pages with no sensitive actions, and
  similar low-impact web findings
- DOS via spam transactions on testnet
