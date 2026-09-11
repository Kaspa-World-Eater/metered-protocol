/**
 * Settling a metered session on Kaspa -- the half of the protocol that consensus enforces.
 *
 * SEPARATE FROM THE MAIN ENTRY POINT ON PURPOSE. `import 'metered'` pulls in the messages, the
 * meters and the HTTP layer, and nothing else: a buyer that only speaks the protocol should not
 * have to load a WASM SDK to do it. Everything here needs that SDK, and needs `silverc` to compile
 * a covenant carrying this session's own identity, so it lives behind `metered/chain` where the
 * cost is opt-in.
 *
 * The drivers are deliberately NOT here. `tools/demo.ts` and `tools/live-*.ts` demonstrate these
 * operations and print things; what a program links against is the operations.
 */
export {
  openCovenant, fundCovenant, settleClaim, closeCovenant,
  SETTLE_FEE, CLOSE_FEE, FUND_FEE,
  type Opened, type Claim, type Closed,
} from './session-chain.js';
export { loadSdk, loadAnchorKey, anchorAddress, type Network } from './kaspa.js';
export { signatureScript, actionScript, settleArgs, encodeNumber, type Arg } from './sigscript.js';
export { awaitUtxo, awaitWindow, closeOutputs, withState, type Any } from './live-steps.js';
export { covenantAddress, compileWithState } from './covenant.js';
