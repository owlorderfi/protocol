# Static-analysis delta — 2026-07-27 (audit #1 TWAP + #4 + #6b)

Baseline compared against: `*-2026-05-30-a14.*`.

Contract count rose 23 → 26 (new `TwapOracle` library plus two test mocks),
so raw result counts are not comparable. What matters is which detector
classes are NEW.

## Slither — 2 new classes, both judged benign

| Class | Where | Judgement |
|---|---|---|
| `unused-return` | `TwapOracle.consult` reading `slot0()` / `observations()` / `observe()` | **False positive.** Standard tuple destructuring — we bind only the components we need and discard the rest positionally. There is no ignored error channel; these are `view` reads whose full tuple is irrelevant. |
| `dangerous-strict-equalities` | `refillKeeper`, `windowRemaining == 0` | **Benign.** `windowRemaining` comes from `cap > charged ? cap - charged : 0`, so it is exactly zero or strictly positive — the equality is precise, not an approximation of a balance. Newly flagged only because the computation moved into `_refillAllowance()`, which changed Slither's dataflow view; the same comparison existed before. |

`divide-before-multiply` inside `getSqrtRatioAtTick` is pre-existing in the
baseline and inherent to Uniswap's own algorithm — the port is verbatim and
must not be "fixed".

## Aderyn — 0 High (unchanged), 1 new Low class

| Class | Where | Judgement |
|---|---|---|
| `L-2: Internal Function Used Only Once` | `TwapOracle.getQuoteAtTick` | **Declined.** It mirrors the canonical `OracleLibrary.getQuoteAtTick` surface and is exercised directly by the fork tests. Inlining it would make the port harder to diff against upstream, which is the property the whole file is optimised for. |

Every other Low is the baseline set with shifted numbering.
