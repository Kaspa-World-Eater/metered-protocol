/**
 * Durable stores for the two obligations that lose something when a process forgets.
 *
 * SPEC.md §4.2 (record-then-send) and §4.4 (the restart rule) are already implemented by
 * `signer.ts`: it loads from the store on every call, so a fresh process behaves exactly like a
 * long-running one, and "a restart that forgets is a store that lost data, not a signer that
 * skipped a step." This is the store that does not lose data. `memoryStore()` is the one that
 * does, and it is honest about it.
 *
 * SPEC.md §3.1a needs the same thing for a different reason: a buyer that forgets which session
 * identifiers it has seen is unprotected against a provider that waits for it to restart.
 *
 * WHY APPEND-ONLY, AND WHY fsync.
 *
 *   A signature must not exist unless the record is already durable. Rewriting a whole JSON file
 *   per save has a window where the old file is gone and the new one is not yet written; a crash
 *   inside it loses EVERY record, not one. Appending a line cannot lose what came before.
 *
 *   Writing without fsync puts the record in the operating system's buffer, not on the disk. The
 *   process crashing is survivable either way; the machine losing power is not. §4.2 says the
 *   write happens before the signature is returned, and a buffered write has not happened.
 *
 *   A TORN FINAL LINE IS DISCARDED, and that is correct rather than merely convenient: if the
 *   append did not complete, `save` did not return, so no signature was ever handed out. The
 *   record describes something that never happened.
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import type { SignerRecord, SignerStore } from './signer.js';
import type { SessionHistory } from './history.js';
import type { SessionSnapshot } from './http/provider.js';

/** Read a JSONL file, discarding any trailing line that a crash cut in half. */
function replay<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const rows: T[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      // Only the LAST line can legitimately be torn. An unparseable line anywhere else means the
      // file was damaged by something other than a crash, and replaying past it would silently
      // resurrect a stale record -- so stop here and keep what was whole.
      break;
    }
  }
  return rows;
}

/** Append one record and put it on the disk before returning. */
function appendDurable(path: string, row: unknown): void {
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, `${JSON.stringify(row)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * A SignerStore that survives a restart, and a power cut.
 *
 * Later records win: the log is a history of what was signed, and §4.4 only ever moves `highestSeq`
 * upward, so replaying it in order lands on the same state the process held.
 */
export function fileStore(path: string): SignerStore {
  const rows = new Map<string, SignerRecord>();
  for (const r of replay<SignerRecord>(path)) rows.set(r.sessionId, r);
  return {
    load: (sessionId) => rows.get(sessionId) ?? null,
    save: (record) => {
      // Disk first, memory second. The other order would let an in-process reader see a record
      // that a crash one instruction later would erase -- which is send-then-record wearing a
      // different hat.
      appendDurable(path, record);
      rows.set(record.sessionId, { ...record });
    },
  };
}

/** A SessionHistory that survives a restart. SPEC.md §3.1a; see src/history.ts for why it matters. */
export function fileHistory(path: string): SessionHistory {
  const seen = new Set<string>();
  const key = (provider: string, sessionId: string) => `${provider}/${sessionId}`;
  for (const r of replay<{ provider: string; sessionId: string }>(path)) {
    seen.add(key(r.provider, r.sessionId));
  }
  return {
    seen: (provider, sessionId) => seen.has(key(provider, sessionId)),
    record: (provider, sessionId) => {
      appendDurable(path, { provider, sessionId });
      seen.add(key(provider, sessionId));
    },
  };
}


/** Durable storage for open sessions, so a restart does not make every buyer start again. */
export interface SessionStore {
  load(sessionId: string): SessionSnapshot | null;
  save(snapshot: SessionSnapshot): void;
  drop(sessionId: string): void;
}

/**
 * Sessions that survive a restart.
 *
 * Weaker guarantees than `fileStore`, deliberately. A signer record must be durable BEFORE a
 * signature exists, because losing one lets a party sign twice at the same seq; losing a session
 * costs at most the babel in flight, which the buyer simply reserves again. So this appends
 * without fsync -- fast enough to write on every message -- and the last few entries may be lost
 * to a power cut. That is a considered trade, not an oversight: paying for durability here would
 * put a disk flush on the path of every delivery, in exchange for something nobody loses money to.
 */
export function fileSessionStore(path: string): SessionStore {
  const rows = new Map<string, SessionSnapshot | null>();
  for (const r of replay<{ id: string; snapshot: SessionSnapshot | null }>(path)) rows.set(r.id, r.snapshot);
  const append = (id: string, snapshot: SessionSnapshot | null): void => {
    appendFileSync(path, `${JSON.stringify({ id, snapshot })}
`);
    rows.set(id, snapshot);
  };
  return {
    load: (sessionId) => rows.get(sessionId) ?? null,
    save: (snapshot) => append(snapshot.offer.sessionId, snapshot),
    drop: (sessionId) => append(sessionId, null),
  };
}
