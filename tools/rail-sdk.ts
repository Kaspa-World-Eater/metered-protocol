/**
 * From their reference transaction to a Kaspa SDK transaction, to the node -- and the one check.
 *
 * `@kaspa-x402/covenant` emits a reference transaction: every field, and the id the transaction
 * MUST have. This turns it into the runtime object the SDK broadcasts, following the shape their
 * own reference adapter uses (kaspa-x402/scripts/live-adapter-reference.mjs,
 * `referenceTransactionToSdk`), including its note that Toccata renamed the SDK's `mass` to
 * `storageMass`.
 *
 * THE PROOF IS THE TRANSACTION ID. The node returns the id it assigned; if that is not the
 * artifact's, the runtime transaction is not the reference one and something upstream is wrong.
 * `submitReference` refuses to report success in that case, and every live run so far has passed
 * through it.
 *
 * THE PROOF IS ALSO WRITTEN DOWN. The explorer index forgets (see src/proof.ts); a proof cited
 * in the docs has to be one a reader can check without it, so every accepted submission lands
 * in docs/proofs/<txid>.json before this returns -- under the CALLER's working directory, not
 * this module's: a proof belongs to the repository whose run produced it (spigot's runs are
 * spigot's evidence), and from inside node_modules this module's own docs/ is nowhere.
 */
import { join } from 'node:path';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import type { TxV1ReferenceTransaction } from '@kaspa-x402/covenant';
import { proofFor, writeProof, type Network } from '../src/proof.js';
import type { Any } from './live-steps.js';

const PROOFS = join(process.cwd(), 'docs', 'proofs');

/** Their reference transaction, as the Kaspa SDK wants it. Mirrors their own adapter's shape. */
export function referenceToSdk(sdk: Any, ref: TxV1ReferenceTransaction): Any {
  const spk = (serialized: string) => {
    const b = hexToBytes(serialized);
    return new sdk.ScriptPublicKey(((b[0] ?? 0) << 8) | (b[1] ?? 0), bytesToHex(b.slice(2)));
  };
  return new sdk.Transaction({
    version: ref.version,
    inputs: ref.inputs.map((i) => ({
      previousOutpoint: { transactionId: i.previousOutpoint.txid, index: i.previousOutpoint.index },
      signatureScript: i.signatureScript,
      sequence: BigInt(i.sequence),
      sigOpCount: 0,
      computeBudget: i.computeBudget,
      utxo: {
        outpoint: { transactionId: i.previousOutpoint.txid, index: i.previousOutpoint.index },
        amount: BigInt(i.utxo.amount),
        scriptPublicKey: spk(i.utxo.scriptPublicKey),
        blockDaaScore: BigInt(i.utxo.blockDaaScore),
        isCoinbase: false,
        ...(i.utxo.covenantId ? { covenant_id: i.utxo.covenantId } : {}),
      },
    })),
    outputs: ref.outputs.map((o) => ({
      value: BigInt(o.amount),
      scriptPublicKey: spk(o.scriptPublicKey),
      ...(o.covenant ? { covenant: { authorizingInput: o.covenant.authorizingInput, covenantId: o.covenant.covenantId } } : {}),
    })),
    lockTime: BigInt(ref.lockTime),
    subnetworkId: ref.subnetworkId,
    gas: BigInt(ref.gas),
    payload: ref.payload,
    storageMass: BigInt(ref.mass),
  });
}

/**
 * Submit, REQUIRE the node's id to be the artifact's (different ids mean a different transaction),
 * then archive the proof. Returns the id.
 */
export async function submitReference(
  rpc: Any, sdk: Any, artifact: { transaction: TxV1ReferenceTransaction; transactionId: string; kind: string }, network: Network,
): Promise<string> {
  const { transactionId } = await rpc.submitTransaction({ transaction: referenceToSdk(sdk, artifact.transaction), allowOrphan: false });
  const txid = String(transactionId).toLowerCase();
  if (txid !== artifact.transactionId.toLowerCase()) {
    throw new Error(`${artifact.kind}: node assigned ${transactionId}, artifact expected ${artifact.transactionId}`);
  }
  const { virtualDaaScore } = await rpc.getBlockDagInfo();
  const path = writeProof(PROOFS, proofFor({
    txid, network, kind: artifact.kind, transaction: artifact.transaction, submittedAt: new Date().toISOString(), virtualDaaScore,
  }));
  console.log(`     proof ${path}`);
  return txid;
}

