/**
 * Settling a metered session through the kaspa-x402 escrow -- the rail, as a program links to it.
 *
 * `metered-protocol/rail`. Everything here needs the Kaspa WASM SDK, so it lives behind its own
 * entry point for the same reason `./chain` did: a buyer or seller that only speaks the protocol
 * should not have to load it. Unlike `./chain`, nothing here is a covenant of this project's --
 * the escrow, its script, its transaction shapes and its compute budgets are kaspa-x402.org's, and
 * this is the glue between a metered State and their voucher, and between their artifacts and a
 * node. See docs/RAIL.md.
 *
 * `./chain` -- metered's own covenant -- is superseded by this and retained only for the record.
 */
export {
  openChannel, claimChannel, refundChannel, channelVerifier, proposalFor, escrowParams, redeemScriptFor,
  CLAIM_COMPUTE_BUDGET, CLAIM_SCRIPT_UNITS, REFUND_COMPUTE_BUDGET, REFUND_SCRIPT_UNITS,
  type Channel,
} from './rail-chain.js';
export { loadSdk, loadAnchorKey, type Network } from './kaspa.js';
export { awaitUtxo, type Any } from './live-steps.js';
export { referenceToSdk, submitReference } from './rail-sdk.js';
export { spendWallet, FEE_PER_INPUT, type Spend } from './wallet.js';
