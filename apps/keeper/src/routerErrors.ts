/**
 * Custom errors declared by LimitOrderRouter.sol, expressed as an ABI
 * fragment so viem can decode revert selectors at runtime. Without
 * these entries, a revert like `InsufficientOutput(received, minRequired)`
 * surfaces only as `0x2c19b8b8 — Unable to decode signature`, which:
 *   1. Makes log triage impossible without a 4byte lookup.
 *   2. Defeats `classifyFailure()` semantic matching — `permanent` vs
 *      transient gets decided on opaque text instead of the error name.
 *
 * Mirror the Solidity source 1:1. Any new `error X(...)` declaration in
 * contracts/src/LimitOrderRouter.sol MUST be appended here in the same
 * order — keeping the file diff small is the cheapest review aid.
 *
 * Source of truth: contracts/src/LimitOrderRouter.sol lines ~266-288.
 */
export const ROUTER_ERRORS_ABI = [
  { type: 'error', name: 'UnauthorizedKeeper', inputs: [{ name: 'keeper', type: 'address' }] },
  {
    type: 'error',
    name: 'OrderExpired',
    inputs: [
      { name: 'deadline', type: 'uint256' },
      { name: 'currentTime', type: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'NonceAlreadyUsed',
    inputs: [
      { name: 'maker', type: 'address' },
      { name: 'nonce', type: 'uint256' },
    ],
  },
  { type: 'error', name: 'InvalidSignature', inputs: [] },
  {
    type: 'error',
    name: 'SignerMismatch',
    inputs: [
      { name: 'recovered', type: 'address' },
      { name: 'expected', type: 'address' },
    ],
  },
  { type: 'error', name: 'InvalidOrderType', inputs: [{ name: 'orderType', type: 'uint8' }] },
  { type: 'error', name: 'ZeroAddress', inputs: [] },
  { type: 'error', name: 'InvalidAmount', inputs: [] },
  {
    type: 'error',
    name: 'InsufficientOutput',
    inputs: [
      { name: 'received', type: 'uint256' },
      { name: 'minRequired', type: 'uint256' },
    ],
  },
  { type: 'error', name: 'AggregatorCallFailed', inputs: [{ name: 'returnData', type: 'bytes' }] },
  {
    type: 'error',
    name: 'FeeTooHigh',
    inputs: [
      { name: 'requested', type: 'uint16' },
      { name: 'max', type: 'uint16' },
    ],
  },
  {
    type: 'error',
    name: 'ScheduledTooEarly',
    inputs: [
      { name: 'earliestExecAt', type: 'uint64' },
      { name: 'currentTime', type: 'uint64' },
    ],
  },
  {
    type: 'error',
    name: 'ScheduledExpired',
    inputs: [
      { name: 'endTime', type: 'uint64' },
      { name: 'currentTime', type: 'uint64' },
    ],
  },
  {
    type: 'error',
    name: 'ScheduledExhausted',
    inputs: [
      { name: 'slicesExecuted', type: 'uint16' },
      { name: 'maxSlices', type: 'uint16' },
    ],
  },
  {
    type: 'error',
    name: 'ScheduledIntervalTooShort',
    inputs: [
      { name: 'requested', type: 'uint64' },
      { name: 'min', type: 'uint64' },
    ],
  },
  {
    type: 'error',
    name: 'ScheduledMaxSlicesTooHigh',
    inputs: [
      { name: 'requested', type: 'uint16' },
      { name: 'max', type: 'uint16' },
    ],
  },
  {
    type: 'error',
    name: 'ScheduledBadWindow',
    inputs: [
      { name: 'startTime', type: 'uint64' },
      { name: 'endTime', type: 'uint64' },
    ],
  },
  { type: 'error', name: 'NativeWrappedNotConfigured', inputs: [] },
  {
    type: 'error',
    name: 'KeeperRefillExceedsCap',
    inputs: [
      { name: 'requested', type: 'uint256' },
      { name: 'windowRemaining', type: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'InsufficientAccumulatedNative',
    inputs: [
      { name: 'available', type: 'uint256' },
      { name: 'requested', type: 'uint256' },
    ],
  },
  { type: 'error', name: 'NativeTransferFailed', inputs: [] },
] as const;
