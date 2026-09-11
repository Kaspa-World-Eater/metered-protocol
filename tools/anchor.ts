/**
 * A real Kaspa anchor for SPEC.md §8 checkpoints -- the `Anchor` that src/checkpoint.ts takes.
 *
 * Every hard-won detail below came from kaspa-depin's proven implementation, and each one cost a
 * live run to learn. They are restated rather than imported because that repository is a separate
 * project and this one must build without it; but they are its findings, not new ones.
 *
 *   BUILD THE TRANSACTION BY HAND. `createTransactions` hands back a PendingTransaction whose
 *   `.transaction` is a COPY -- setting subnetworkId and payload on it mutates a throwaway, the
 *   chain receives neither, and nothing reports a problem. A first attempt confirmed happily and
 *   landed a plain payment with an empty payload. `createTransaction` returns a Transaction we
 *   own, so what is signed is what was built.
 *
 *   A VERSION 1 TRANSACTION BUDGETS ITS INPUTS. Toccata replaced sigOpCount with an explicit
 *   computeBudget, and a node refuses a v1 transaction still carrying the old field.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: wait. §8 requires checkpointing to be non-blocking because
 * Study B measured p90 confirmation at 1,879 ms. This resolves once the node ACCEPTS the
 * transaction, not once it is mined -- src/checkpoint.ts already treats the record as pending and
 * never awaits it. Proving a checkpoint later means fetching the block, which is a verifier's job
 * and needs nothing from here.
 */
import { loadSdk, type Network } from './kaspa.js';
import type { Anchor } from '../src/checkpoint.js';

/** KIP-21 subnetwork. Anchors go in their own lane so the stream is separable later. */
export const ANCHOR_LANE = '00a0c40100000000000000000000000000000000';

/**
 * Measured, not guessed, and the first three guesses were wrong. At budget 10 the mass is 1,666
 * and the node requires 166,600 sompi; this pays 200,000 for headroom -- about 0.002 KAS, the
 * figure SPEC.md §0.1 quotes from Study B.
 */
export const ANCHOR_FEE_SOMPI = 200_000n;
const COMPUTE_BUDGET = 10;

export interface AnchorConfig {
  network: Network;
  privateKeyHex: string;
  /** ws(s):// node URL. Omitted, the public Resolver pool is used -- which speaks borsh only. */
  url?: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

async function connect(cfg: AnchorConfig): Promise<{ sdk: Any; rpc: Any }> {
  const sdk = await loadSdk();
  const networkId = new sdk.NetworkId(cfg.network);
  const rpc = cfg.url
    ? new sdk.RpcClient({ url: cfg.url, encoding: sdk.Encoding.Borsh, networkId })
    : new sdk.RpcClient({ resolver: new sdk.Resolver(), encoding: sdk.Encoding.Borsh, networkId });
  await rpc.connect();
  return { sdk, rpc };
}

/**
 * Put one digest on chain. Resolves with the transaction id once the node has accepted it.
 *
 * The payload is the raw 32 digest bytes. There is no framing: a checkpoint proves a State existed
 * before a block, and the State's digest is the whole claim.
 */
export async function submitAnchor(cfg: AnchorConfig, digest: string): Promise<string> {
  const { sdk, rpc } = await connect(cfg);
  try {
    const priv = new sdk.PrivateKey(cfg.privateKeyHex);
    const address = priv.toKeypair().toAddress(new sdk.NetworkId(cfg.network)).toString();

    const { entries } = await rpc.getUtxosByAddresses([address]);
    if (!entries.length) throw new Error(`no UTXOs at ${address} to pay the anchor fee`);
    const utxo = entries.reduce((a: Any, b: Any) => (b.amount > a.amount ? b : a));
    if (utxo.amount <= ANCHOR_FEE_SOMPI) {
      throw new Error(`largest UTXO holds ${utxo.amount} sompi, under the ${ANCHOR_FEE_SOMPI} fee`);
    }

    const tx = sdk.createTransaction(
      [utxo],
      [{ address, amount: utxo.amount - ANCHOR_FEE_SOMPI }],
      0n,
      Buffer.from(digest, 'hex'),
      0,
    );
    tx.version = 1;
    tx.subnetworkId = ANCHOR_LANE;
    tx.gas = 0n;
    for (const input of tx.inputs) {
      input.sigOpCount = 0;
      input.computeBudget = COMPUTE_BUDGET;
    }
    tx.finalize();

    const signed = sdk.signTransaction(tx, [priv], true);
    const { transactionId } = await rpc.submitTransaction({ transaction: signed, allowOrphan: false });
    return transactionId as string;
  } finally {
    await rpc.disconnect().catch(() => undefined);
  }
}

/** A tip to start a forward walk from. Must be captured BEFORE submitting. */
export async function currentTip(cfg: AnchorConfig): Promise<string> {
  const { rpc } = await connect(cfg);
  try {
    const { tipHashes } = await rpc.getBlockDagInfo();
    const tip = tipHashes[0];
    if (!tip) throw new Error('the node reported no tips');
    return tip as string;
  } finally {
    await rpc.disconnect().catch(() => undefined);
  }
}

/**
 * Find an anchor in a block and return the payload the chain actually stored.
 *
 * ACCEPTANCE IS NOT PROOF, and this exists because of that. kaspa-depin's first live anchor
 * confirmed perfectly and landed a plain payment with an EMPTY payload, because the payload had
 * been set on a copy. Nothing anywhere reported a problem. The only way to know a checkpoint is
 * real is to read it back off the chain.
 *
 * SCANNING TIPS DOES NOT WORK. At ten blocks a second a block stops being a tip within about a
 * second, so polling tipHashes misses the block nearly every time and reports a timeout that
 * reads like a failure. Walking forward from a hash captured before submission is the only
 * approach that does not race the DAG.
 */
export async function readAnchoredPayload(
  cfg: AnchorConfig,
  txid: string,
  fromHash: string,
  timeoutMs = 120_000,
): Promise<string> {
  const { rpc } = await connect(cfg);
  const deadline = Date.now() + timeoutMs;
  try {
    let low = fromHash;
    while (Date.now() < deadline) {
      const { blocks } = await rpc.getBlocks({ lowHash: low, includeBlocks: true, includeTransactions: true });
      for (const block of blocks ?? []) {
        for (const tx of block.transactions ?? []) {
          if (tx.verboseData?.transactionId === txid) return String(tx.payload ?? '');
        }
      }
      const last = blocks?.[blocks.length - 1];
      if (last?.header?.hash) low = last.header.hash;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`anchor ${txid} did not appear in a block within ${timeoutMs}ms`);
  } finally {
    await rpc.disconnect().catch(() => undefined);
  }
}

/**
 * The `Anchor` src/checkpoint.ts consumes. Note what it returns: a promise the session never
 * awaits. A failure marks the checkpoint record and stops there, because §8 is explicit that
 * checkpoints are evidence rather than safety -- losing one costs provability, never funds.
 */
export function kaspaAnchor(cfg: AnchorConfig): Anchor {
  return (digest: string) => submitAnchor(cfg, digest);
}
