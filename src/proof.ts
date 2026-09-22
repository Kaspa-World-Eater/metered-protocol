/**
 * A live proof that outlives the explorer.
 *
 * "Proven live" is a claim a stranger can check. On 2026-09-22 every id from the first rail runs
 * (2026-09-11/12) returned 404 from api-tn10.kaspa.org, because the public index does not reach
 * back that far -- so a full id in a README was, ten days later, still only the author's word.
 * This is the record that does not need an index: the reference transaction itself, whose hash
 * IS the id (recomputable with `@kaspa-x402/covenant`), plus where it went and when.
 *
 * One file per transaction, `docs/proofs/<txid>.json`, committed beside the docs that cite it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Network = 'testnet-10' | 'testnet-11' | 'mainnet';

export interface Submission {
  readonly txid: string;
  readonly network: Network;
  /** Which of their builders produced it: `batch-genesis`, `batch-claim`, `batch-refund`, or a carve. */
  readonly kind: string;
  /** Their reference transaction, verbatim: the thing the id is the hash of. */
  readonly transaction: unknown;
  readonly submittedAt: string;
  /** The node's virtual DAA score at submission: roughly when, in chain time. */
  readonly virtualDaaScore: bigint | number | string;
}

export interface Proof {
  readonly txid: string;
  readonly network: Network;
  readonly kind: string;
  readonly explorer: string;
  readonly submittedAt: string;
  readonly virtualDaaScore: string;
  readonly transaction: unknown;
}

const FULL_ID = /^[0-9a-f]{64}$/;
const EXPLORER: Record<Network, string> = {
  'testnet-10': 'https://explorer-tn10.kaspa.org', 'testnet-11': 'https://explorer-tn11.kaspa.org', mainnet: 'https://explorer.kaspa.org',
};

export const explorerUrl = (network: Network, txid: string): string => `${EXPLORER[network]}/txs/${txid}`;

/** The proof of one submission. Refuses anything short of a whole, lowercase id. */
export function proofFor(s: Submission): Proof {
  if (!FULL_ID.test(s.txid)) throw new Error(`a proof needs a whole txid, 64 hex lowercase; got ${JSON.stringify(s.txid)}`);
  return {
    txid: s.txid,
    network: s.network,
    kind: s.kind,
    explorer: explorerUrl(s.network, s.txid),
    submittedAt: s.submittedAt,
    virtualDaaScore: String(s.virtualDaaScore),
    transaction: s.transaction,
  };
}

/** Write `<dir>/<txid>.json`, creating `dir`; returns the path. */
export function writeProof(dir: string, proof: Proof): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${proof.txid}.json`);
  writeFileSync(path, `${JSON.stringify(proof, (_, v: unknown) => (typeof v === 'bigint' ? String(v) : v), 1)}\n`);
  return path;
}
