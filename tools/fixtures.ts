/**
 * Shared fixtures for the covenant's simulator suite. One place, so the settle cases and the
 * expire cases cannot drift into disagreeing about who the parties are -- which would look like a
 * contract bug and be a test bug.
 */
import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { publicKeyHex } from '../src/encoding.js';

export const BUYER_SK = '11'.repeat(32);
export const PROVIDER_SK = '22'.repeat(32);
export const STRANGER_SK = '33'.repeat(32);

export const BUYER_PK = publicKeyHex(BUYER_SK);
export const PROVIDER_PK = publicKeyHex(PROVIDER_SK);
export const STRANGER_PK = publicKeyHex(STRANGER_SK);

export const SESSION_ID = 'a1'.repeat(16);
export const WINDOW = 10;
export const FUNDED = 10_000_000;
/**
 * MUST equal the covenant's fee allowance. It is not a test convenience: THE DRAIN case works by
 * keeping one sompi more than the contract permits, so if this drifts below the contract's figure
 * the case stops testing anything and passes for the wrong reason. It did exactly that when the
 * allowance was raised from 100,000, and the suite caught it.
 */
export const FEE = 400_000;

/** The covenant's `parties`: blake3 over the two x-only keys, concatenated raw. */
export const PARTIES = bytesToHex(
  blake3(new Uint8Array([...hexToBytes(BUYER_PK), ...hexToBytes(PROVIDER_PK)]), { dkLen: 32 }),
);

export const x = (hex: string) => `0x${hex}`;

/** Constructor arguments in declaration order, carrying whatever claim is currently pending. */
export const ctor = (pendingSeq: number, pendingSompi: number) =>
  [x(PARTIES), x(SESSION_ID), WINDOW, pendingSeq, pendingSompi];

export interface Case {
  name: string;
  function: string;
  constructor_args: unknown[];
  args: unknown[];
  expect: 'pass' | 'fail';
  tx: unknown;
}

export interface State {
  v: number;
  sessionId: string;
  seq: number;
  cumulativeUnits: number;
  cumulativeSompi: number;
  prevState: string | null;
}

export const state = (seq: number, units: number, sompi: number, prev: string | null = null): State =>
  ({ v: 1, sessionId: SESSION_ID, seq, cumulativeUnits: units, cumulativeSompi: sompi, prevState: prev });
