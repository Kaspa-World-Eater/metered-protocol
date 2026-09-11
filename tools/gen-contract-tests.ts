/**
 * `npm run contracts:gen` -- generate the covenant's simulator suite, with REAL signatures.
 *
 * Why this exists. Both entry points check a signature before doing anything else, and the
 * SilverScript simulator verifies signatures for real -- it hands `sig`/`datasig` to the VM as
 * opaque blobs. So a hand-written test file cannot execute a single line of this contract.
 * kaspa-depin never tested a signature path for exactly this reason; its only suite covers
 * `topUp`, which needs no key.
 *
 * The two entries need different treatment. `settle` uses `checkMsgSig` (OpCheckSigFromStack),
 * which verifies a signature over SUPPLIED DATA -- the signed message is just the 32-byte
 * settlement digest, so it can be signed here and now. `expire` uses `checkSig`, which covers the
 * spending transaction, and that needs the two-pass harness in tools/sighash.ts.
 *
 * The settle signatures come from src/encoding.ts -- the same code the protocol signs with. If the
 * covenant and the encoder ever disagree about the 72-byte preimage of SPEC.md 3.4.1, these tests
 * fail. That is the point: this is a conformance test between two independent implementations of
 * the same spec, not a mock of either.
 */
import { writeFileSync } from 'node:fs';
import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import { signState, settlementPreimage } from '../src/encoding.js';
import { buildExpireCases } from './expire-cases.js';
import { settleArgs } from './sigscript.js';
import { profileFromArgv, COVENANT_ID } from './covenant-profile.js';
import {
  BUYER_SK, PROVIDER_SK, STRANGER_SK, BUYER_PK, PROVIDER_PK, STRANGER_PK,
  SESSION_ID, WINDOW, FUNDED, FEE, PARTIES, ctor, x, state, type Case, type State,
} from './fixtures.js';

const PROFILE = profileFromArgv();

/** This suite's session, in whichever field names the profile's covenant uses. */
const sessionState = (seq: number, sompi: number, sessionId = SESSION_ID) =>
  PROFILE.outState({ parties: PARTIES, sessionId, window: WINDOW, seq, sompi });

/**
 * KIP-20 bindings for a settle. Argent's `emits next` lowers to OpAuthOutputCount == 1, so its
 * continuation output must be AUTHORISED by the spending input rather than merely sitting at
 * index 0. The hand-written covenant asks for no binding and gets none.
 */
const bindInput = () => (PROFILE.binds ? { covenant_id: COVENANT_ID } : {});
const bindOutput = () => (PROFILE.binds ? { covenant_id: COVENANT_ID, authorizing_input: 0 } : {});

/** The arguments `settle` takes, signed by whichever keys the case calls for. */
function signedSettleArgs(s: State, buyerSk = BUYER_SK, providerSk = PROVIDER_SK, buyerPk = BUYER_PK, providerPk = PROVIDER_PK) {
  return settleArgs(s, buyerPk, providerPk, signState(s, buyerSk), signState(s, providerSk));
}

/** A settle spends the covenant and hands it straight back, carrying the new claim. */
function settleTx(pendingSeq: number, pendingSompi: number, s: State, outValue = FUNDED - FEE, outState?: unknown) {
  return {
    active_input_index: 0,
    inputs: [{ utxo_value: FUNDED, constructor_args: ctor(pendingSeq, pendingSompi), ...bindInput() }],
    outputs: [{
      value: outValue,
      constructor_args: ctor(pendingSeq, pendingSompi),
      state: outState ?? sessionState(s.seq, s.cumulativeSompi),
      ...bindOutput(),
    }],
  };
}

const digestOf = (s: State) => bytesToHex(blake3(settlementPreimage(s as unknown as Record<string, unknown>), { dkLen: 32 }));

const FIRST = state(0, 550, 1_000_000);
const SECOND = state(1, 1100, 2_000_000, digestOf(FIRST));
const OTHER_ID = 'c3'.repeat(16);
const OTHER_SESSION = ctor(-1, 0).map((v, i) => (i === 1 ? x(OTHER_ID) : v));

const settleCases: Case[] = [
  {
    name: 'the first claim: a doubly-signed State at seq 0 posts, and pays nobody',
    function: 'settle',
    constructor_args: ctor(-1, 0),
    args: signedSettleArgs(FIRST),
    expect: 'pass',
    tx: settleTx(-1, 0, FIRST),
  },
  {
    name: 'SUPERSEDE: a strictly higher seq replaces the pending claim',
    function: 'settle',
    constructor_args: ctor(0, 1_000_000),
    args: signedSettleArgs(SECOND),
    expect: 'pass',
    tx: settleTx(0, 1_000_000, SECOND),
  },
  {
    name: 'P6/B5 THE STALE CLOSE: re-posting the SAME seq over a pending claim is refused',
    function: 'settle',
    constructor_args: ctor(0, 1_000_000),
    args: signedSettleArgs(FIRST),
    expect: 'fail',
    tx: settleTx(0, 1_000_000, FIRST),
  },
  {
    name: 'a LOWER seq than the pending claim is refused -- supersede is strict, not >=',
    function: 'settle',
    constructor_args: ctor(5, 9_000_000),
    args: signedSettleArgs(FIRST),
    expect: 'fail',
    tx: settleTx(5, 9_000_000, FIRST),
  },
  {
    name: 'THE FORGERY: a State signed by a stranger instead of the buyer is refused',
    function: 'settle',
    constructor_args: ctor(-1, 0),
    args: signedSettleArgs(FIRST, STRANGER_SK, PROVIDER_SK, STRANGER_PK, PROVIDER_PK),
    expect: 'fail',
    tx: settleTx(-1, 0, FIRST),
  },
  {
    name: 'ONE SIGNATURE IS NOT A STATE: the provider signing both halves is refused',
    function: 'settle',
    constructor_args: ctor(-1, 0),
    args: signedSettleArgs(FIRST, PROVIDER_SK, PROVIDER_SK, PROVIDER_PK, PROVIDER_PK),
    expect: 'fail',
    tx: settleTx(-1, 0, FIRST),
  },
  {
    name: 'X1 CROSS-SESSION REPLAY: a State signed for another session is refused',
    function: 'settle',
    constructor_args: OTHER_SESSION,
    args: signedSettleArgs(FIRST),
    expect: 'fail',
    tx: {
      active_input_index: 0,
      inputs: [{ utxo_value: FUNDED, constructor_args: OTHER_SESSION, ...bindInput() }],
      outputs: [{
        value: FUNDED - FEE,
        constructor_args: OTHER_SESSION,
        state: sessionState(FIRST.seq, FIRST.cumulativeSompi, OTHER_ID),
        ...bindOutput(),
      }],
    },
  },
  {
    name: 'THE DRAIN: a settle keeping more than the fee instead of returning the funds is refused',
    function: 'settle',
    constructor_args: ctor(-1, 0),
    args: signedSettleArgs(FIRST),
    expect: 'fail',
    tx: settleTx(-1, 0, FIRST, FUNDED - FEE - 1),
  },
  {
    name: 'THE LIE: a settle whose carried state does not match the State it verified is refused',
    function: 'settle',
    constructor_args: ctor(-1, 0),
    args: signedSettleArgs(FIRST),
    expect: 'fail',
    tx: settleTx(-1, 0, FIRST, FUNDED - FEE, sessionState(FIRST.seq, 9_000_000)),
  },
];

/**
 * THE CASE THAT JUSTIFIES THE 16 BYTES, and it can only be written against Argent.
 *
 * In the hand-written covenant `sessionId` is a constructor constant, so a continuation cannot be
 * ASKED to rewrite it -- the field is not in the state block, and the case does not exist. In
 * Argent it is state, `become` rewrites the whole of it, and the compiler emits a continuation
 * that checks every field. That is what the extra 16 bytes bought, and without
 * this case that claim is an assertion about a compiler rather than a measurement of one.
 *
 * Verified to refuse at `validateOutputState`, with the covenant's own computed `next_state`
 * carrying the original session_id against an output claiming another.
 */
const identityCases: Case[] = PROFILE.identityInState
  ? [{
      name: 'IDENTITY DRIFT: a continuation that rewrites the session_id it carries is refused',
      function: 'settle',
      constructor_args: ctor(-1, 0),
      args: signedSettleArgs(FIRST),
      expect: 'fail',
      tx: settleTx(-1, 0, FIRST, FUNDED - FEE, sessionState(FIRST.seq, FIRST.cumulativeSompi, 'c3'.repeat(16))),
    }]
  : [];

const cases = [...settleCases, ...identityCases, ...buildExpireCases(PROFILE.contract)];
writeFileSync(PROFILE.suite, `${JSON.stringify({ tests: cases }, null, 2)}\n`);
console.log(`wrote ${PROFILE.suite} -- ${cases.length} cases  [${PROFILE.key}: ${PROFILE.contract}]`);
console.log(`  session  ${SESSION_ID}  window ${WINDOW}  funded ${FUNDED}`);
console.log(`  parties  ${PARTIES}`);
