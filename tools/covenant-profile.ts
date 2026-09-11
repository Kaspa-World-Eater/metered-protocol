/**
 * The two covenants this project holds, described well enough for ONE test generator to drive both.
 *
 * `contracts/metered_session.sil` is hand-written and proven on chain. `contracts/metered.ag` is
 * the Argent port, which compiles THROUGH SilverScript to 520 bytes. They implement the same
 * SPEC.md rules and differ in exactly two ways that a test file can see:
 *
 *   THE STATE SPAN. The hand-written covenant carries `parties`, `sessionId` and `window` as
 *   CONSTRUCTOR CONSTANTS and only `pendingSeq`/`pendingSompi` as state, so a continuation re-emits
 *   18 bytes. Argent has no per-instance immutable parameter -- everything an instance is
 *   configured with lives in `state` and `become` rewrites all of it -- so its continuation
 *   re-emits all five fields, and the COMPILER checks the session's identity is preserved where
 *   the hand-written version trusted the author. That is what the 16 bytes bought.
 *
 *   THE OUTPUT AUTHORISATION. Argent's `settle` lowers `emits next` to a real KIP-20 check,
 *   `OpAuthOutputCount(activeInput) == 1`, so its continuation output MUST carry a covenant
 *   binding or the entry cannot run at all. The hand-written version constrains `outputs[0]` by
 *   convention instead. `expire` is the mirror image: `emits {}` lowers to a count of ZERO, which
 *   is what an unbound P2PK payout already is, so it needs no binding either way.
 *
 * A profile rather than a second generator, because the cases ARE the same cases -- forking them
 * would let the two covenants drift apart silently, which is the one thing this suite exists to
 * prevent.
 */
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
/**
 * Paths are resolved against the PACKAGE, not the working directory.
 *
 * They used to be plain relative strings, which worked for as long as everything that compiled a
 * covenant was run from the root of this repository. The first program to depend on metered from
 * outside it got "failed to read contracts/metered_session.sil" -- because the file was exactly
 * where it always is, and the process was somewhere else.
 */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const inPackage = (p: string): string => join(PACKAGE_ROOT, p);

/** Everything either covenant's continuation can depend on. */
export interface SessionState {
  parties: string;
  sessionId: string;
  window: number;
  seq: number;
  sompi: number;
}

export interface CovenantProfile {
  /** The source to compile before running, when the contract is generated rather than written. */
  source?: string;
  key: string;
  /** The SilverScript the simulator executes. For Argent that is argentc's generated output. */
  contract: string;
  suite: string;
  /**
   * The continuation state `validateOutputState` checks, in this covenant's own field names.
   *
   * Takes the WHOLE session rather than just the mutable pair, because Argent's state carries the
   * session's identity too. Reaching for fixture constants here instead cost a failed pre-flight:
   * the live tools use their own parties and window, and a state block built from test values
   * describes a different session -- which is precisely what validateOutputState exists to refuse.
   */
  outState(session: SessionState): Record<string, unknown>;
  /** Whether a settle's continuation output needs a KIP-20 covenant binding. */
  binds: boolean;
  /**
   * Whether the session's identity lives in the STATE rather than in constructor constants.
   * When it does, a continuation can be asked to rewrite it, so the refusal can be tested;
   * when it does not, the case cannot be expressed at all -- the field is not in the state block.
   */
  identityInState: boolean;
}

/** Any 32 bytes: a covenant id only has to be CONSISTENT between an input and the outputs it authorises. */
export const COVENANT_ID = `0x${'7c'.repeat(32)}`;

export const HAND_WRITTEN: CovenantProfile = {
  key: 'sil',
  contract: inPackage('contracts/metered_session.sil'),
  suite: inPackage('contracts/metered_session.tests.json'),
  outState: ({ seq, sompi }) => ({ pendingSeq: seq, pendingSompi: sompi }),
  binds: false,
  identityInState: false,
};

export const ARGENT: CovenantProfile = {
  key: 'ag',
  source: inPackage('contracts/metered.ag'),
  contract: inPackage('build/ag/sil/MeteredSession.sil'),
  suite: inPackage('contracts/metered_ag.tests.json'),
  outState: ({ parties, sessionId, window, seq, sompi }) => ({
    parties: `0x${parties}`,
    session_id: `0x${sessionId}`,
    window,
    pending_seq: seq,
    pending_sompi: sompi,
  }),
  binds: true,
  identityInState: true,
};

export const PROFILES: Record<string, CovenantProfile> = { sil: HAND_WRITTEN, ag: ARGENT };

/** `--profile ag`, defaulting to the covenant that is actually proven on chain. */
export function profileFromArgv(argv: string[] = process.argv): CovenantProfile {
  const i = argv.indexOf('--profile');
  const key = i >= 0 ? argv[i + 1] : undefined;
  if (!key) return HAND_WRITTEN;
  const profile = PROFILES[key];
  if (!profile) throw new Error(`unknown profile ${key}; expected one of ${Object.keys(PROFILES).join(', ')}`);
  return profile;
}
