/**
 * Many sessions at once, which is the difference between a demo and a server.
 *
 * WHY `/open` TAKES THE BUYER'S KEY. An Offer names `buyerPubkey` and commits to
 * `blake3(buyer || provider)`, so it cannot be signed until the provider knows who is asking.
 * The single-session version dodged this by having the Offer pre-made with both keys baked in,
 * which quietly meant a server could only ever serve one buyer. Asking for the key at open is
 * what makes the commitment honest AND makes many sessions possible; the two were the same
 * problem.
 *
 * WHAT PERSISTS AND WHAT DOES NOT. Sessions live in memory, so a restart forgets what has been
 * OFFERED and every buyer must open again. That is survivable because a Reservation authorises
 * ONE chunk -- the most anyone loses to a forgotten session is that chunk.
 *
 * What has been SIGNED is a different matter, and forgetting it loses money. SPEC.md 4 is carried
 * by a SignerStore threaded through every session here. Until 2026-09-10 it was not: src/signer.ts
 * implemented all four obligations, src/session.ts used them, and NOTHING ELSE DID -- this server
 * called `signState` directly, so the rules that exist to stop a party signing two States at one
 * seq were running only in session.ts's own test. Passing a store from src/store.ts is what makes
 * 4.4's restart rule true rather than available.
 */
import { randomBytes } from 'node:crypto';
import { bytesToHex } from '@noble/hashes/utils';
import { signEnvelope, partiesCommitment } from '../encoding.js';
import { ProviderSession, type Deliver, type Meter } from './provider.js';
import { Checkpointer, type Anchor } from '../checkpoint.js';
import { memoryStore, type SignerStore } from '../signer.js';
import type { SessionStore } from '../store.js';
import type { Offer } from '../types.js';

/** Everything about an Offer except who the buyer is, which is not known until one asks. */
export type OfferTerms = Omit<Offer, 'sessionId' | 'buyerPubkey' | 'partiesCommitment' | 'sig' | 'providerPubkey'>;

export interface ServiceOptions {
  terms: OfferTerms;
  providerSk: string;
  providerPubkey: string;
  meter: Meter;
  deliver: Deliver;
  /** How many sessions to keep. The oldest is evicted past this, halted ones first. */
  maxSessions?: number | undefined;
  /**
   * SPEC.md 8. Each session gets its OWN Checkpointer over this one anchor, so a session's
   * checkpoint records stay with the session and are evicted with it.
   */
  anchor?: Anchor | undefined;

  /**
   * SPEC.md 4. Shared across sessions deliberately: SignerRecord is keyed by sessionId, so one
   * store holds every session this provider has ever signed for -- which is exactly what 4.4's
   * restart rule needs to consult. Defaults to memory; src/store.ts survives a restart.
   */
  store?: SignerStore | undefined;

  /**
   * SPEC.md has nothing to say about this: it is an implementation quality. Without it a restart
   * forgets what has been OFFERED and every buyer opens again, losing at most the babel in
   * flight. With it, a buyer does not notice.
   */
  sessions?: SessionStore | undefined;
}

interface Entry {
  offer: Offer;
  session: ProviderSession;
  checkpointer?: Checkpointer | undefined;
  opened: number;
  halted: boolean;
}

export class MeteredService {
  private readonly sessions = new Map<string, Entry>();

  /** One store for every session, because SPEC.md 4.4 asks what this PARTY has signed. */
  private readonly store: SignerStore;

  constructor(private readonly opts: ServiceOptions) {
    this.store = opts.store ?? memoryStore();
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Mint a session for one buyer and return its signed Offer. */
  open(buyerPubkey: string): Offer {
    if (!/^[0-9a-f]{64}$/i.test(buyerPubkey)) throw new Error('buyerPubkey must be 32 hex bytes');
    this.evict();

    const sessionId = bytesToHex(randomBytes(16)); // SPEC.md 3.1: 16 bytes
    const parties = partiesCommitment(buyerPubkey, this.opts.providerPubkey);
    const offer = signEnvelope(
      {
        ...this.opts.terms,
        sessionId,
        buyerPubkey: buyerPubkey.toLowerCase(),
        providerPubkey: this.opts.providerPubkey,
        partiesCommitment: parties,
      } as Offer,
      this.opts.providerSk,
    ) as Offer;

    const checkpointer = this.opts.anchor ? new Checkpointer(this.opts.anchor) : undefined;
    this.sessions.set(sessionId, {
      offer,
      session: new ProviderSession(
        offer, this.opts.providerSk, this.opts.meter, this.opts.deliver, checkpointer, this.store,
      ),
      checkpointer,
      opened: Date.now(),
      halted: false,
    });
    this.persist(sessionId);
    return offer;
  }

  /**
   * The session for an id, or undefined. Callers turn undefined into a 404, not a crash.
   *
   * REHYDRATES on a miss when a durable session store is configured, so a buyer whose provider
   * restarted mid-session carries on rather than starting again.
   */
  get(sessionId: string): ProviderSession | undefined {
    const entry = this.sessions.get(sessionId) ?? this.rehydrate(sessionId);
    if (!entry || entry.halted) return undefined;
    return entry.session;
  }

  /** Rebuild a session from the durable store, if one is configured and holds it. */
  private rehydrate(sessionId: string): Entry | undefined {
    const snapshot = this.opts.sessions?.load(sessionId);
    if (!snapshot) return undefined;
    const checkpointer = this.opts.anchor ? new Checkpointer(this.opts.anchor) : undefined;
    const entry: Entry = {
      offer: snapshot.offer,
      session: ProviderSession.restore(
        snapshot, this.opts.providerSk, this.opts.meter, this.opts.deliver, checkpointer, this.store,
      ),
      checkpointer,
      opened: Date.now(),
      halted: false,
    };
    this.sessions.set(sessionId, entry);
    return entry;
  }

  /**
   * Write a session down after it has moved. Called by the handlers, because only they know a
   * message was accepted -- persisting before that would record a state nobody agreed to.
   */
  persist(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry && this.opts.sessions) this.opts.sessions.save(entry.session.snapshot());
  }

  offerFor(sessionId: string): Offer | undefined {
    return this.sessions.get(sessionId)?.offer;
  }

  /** A session's checkpoint records, for an operator asking what has been anchored. */
  checkpointsFor(sessionId: string): ReturnType<Checkpointer['all']> {
    return this.sessions.get(sessionId)?.checkpointer?.all() ?? [];
  }

  /**
   * Wait for a finished session's anchors to land, so a REPORT can say what became of them.
   * Never call this while a session is running -- see Checkpointer.settled.
   */
  async checkpointsSettled(sessionId: string): Promise<void> {
    await this.sessions.get(sessionId)?.checkpointer?.settled();
  }

  /**
   * Mark a session dead. SPEC.md 1: "the only remedy for disagreement is to stop", and stopping
   * has to be sticky -- a halted session that answers the next request has not stopped.
   */
  halt(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) entry.halted = true;
    // A halt must survive a restart too, or the remedy stops working the moment a process does.
    this.opts.sessions?.drop(sessionId);
  }

  isHalted(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.halted ?? false;
  }

  /** Keep the map bounded: halted sessions go first, then the oldest. */
  /**
   * Keep the session map bounded, dropping the least valuable first.
   *
   * ORDER MATTERS UNDER ATTACK, and the obvious order is the wrong one. Opening a session is free
   * and unauthenticated -- anyone may ask for terms -- so an attacker can open sessions as fast as
   * it likes. Evicting purely by age hands it a weapon: its fresh sessions survive while real
   * buyers, who are older by definition, get dropped mid-session.
   *
   * So progress is what is protected. Halted sessions go first, then sessions that have never
   * delivered a babel -- which is exactly what a flood consists of -- and only then the oldest.
   * A buyer partway through a session is the last thing to be thrown away.
   */
  private evict(): void {
    const max = this.opts.maxSessions ?? 1000;
    if (this.sessions.size < max) return;
    const rank = (e: Entry): number => {
      if (e.halted) return 0;
      return e.session.pendingSeq < 0 ? 1 : 2;
    };
    const entries = [...this.sessions.entries()].sort((a, b) => {
      const byRank = rank(a[1]) - rank(b[1]);
      return byRank !== 0 ? byRank : a[1].opened - b[1].opened;
    });
    const drop = this.sessions.size - max + 1;
    for (const [id] of entries.slice(0, drop)) this.sessions.delete(id);
  }
}
