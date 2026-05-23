# Security Policy

Polyorder is experimental software in active development. It has **not
yet been audited by a third party** and is currently deployed only on
testnets. Do not use it with funds you cannot afford to lose.

That said, we take security reports seriously and respond to every
credible one.

## Reporting a vulnerability

**Please do not open public GitHub issues for security bugs.**

Use [GitHub Security Advisories](https://github.com/blueradu/polyorder/security/advisories/new)
to submit a private report. We receive a notification and respond.

A good report includes:

- The affected component (smart contract, API, keeper, web)
- Steps to reproduce
- Impact assessment (what an attacker could achieve)
- Suggested fix, if you have one

If you cannot use GitHub Security Advisories for any reason, open a
draft pull request that includes only a placeholder file with a
contact method, and we will reach out off-band.

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
