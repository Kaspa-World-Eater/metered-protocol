/**
 * The HTTP glue. Thin on purpose: every rule lives in provider.ts and service.ts, and this only
 * maps them onto requests and status codes.
 *
 * ROUTING IS BY sessionId, AND IT COSTS NOTHING EXTRA. Every message in SPEC.md 3 already carries
 * one, because the specification needed it to stop a Reservation or Measurement being lifted from
 * one session into another -- threat X1. A field that exists for a security reason turns
 * out to be exactly the routing key a multi-session server needs, so there is no session cookie,
 * no header, and no server-side handle to leak or confuse.
 *
 * An unpaid request gets x402's 402 with the signed Offer in `accepts`. A client that speaks x402
 * but not this scheme reads the envelope, sees `scheme: "metered"` and declines cleanly.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { digestHex, verifyState } from '../encoding.js';
import { SessionRejected } from './provider.js';
import { ReservationUnauthenticated } from '../reservation.js';
import { MeteredService } from './service.js';
import { toPaymentRequired, errorBody, type ChunkRequest, type StateRequest } from './protocol.js';

type Reply = (code: number, body: unknown) => void;

/**
 * The largest request this server will read. A Reservation, a Measurement and a State are all a
 * few hundred bytes; a prompt is the only field with any size to it.
 *
 * BOUNDED ON PURPOSE. Reading an unbounded body means an unauthenticated client can hold the
 * process open and grow a buffer until it dies -- which costs the attacker nothing and does not
 * require knowing any session. This is the cheapest denial of service there is, and the only
 * defence is to refuse to read past a limit.
 */
export const MAX_BODY_BYTES = 256 * 1024;

export class BodyTooLarge extends Error {}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  // Cheapest refusal first: a declared length over the cap needs no reading at all.
  const declared = Number(req.headers['content-length'] ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new BodyTooLarge(`declared body of ${declared} bytes exceeds ${MAX_BODY_BYTES}`);
  }

  const parts: Buffer[] = [];
  let size = 0;
  let over = false;
  for await (const c of req) {
    const buf = c as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      // STOP BUFFERING, KEEP DRAINING. Destroying the socket here loses the response: the client
      // sees a dropped connection rather than a refusal, and cannot tell a limit from a crash.
      // Memory stays bounded because nothing further is kept.
      over = true;
      parts.length = 0;
      continue;
    }
    parts.push(buf);
  }
  if (over) throw new BodyTooLarge(`request body exceeds ${MAX_BODY_BYTES} bytes`);
  return JSON.parse(Buffer.concat(parts).toString('utf8')) as T;
}

export interface ServeOptions {
  service: MeteredService;
  resource?: string;
}

const NO_SESSION = ['no such session', 'unknown, halted or evicted'] as const;

async function handleOpen(svc: MeteredService, req: IncomingMessage, reply: Reply, resource: string): Promise<void> {
  const body = await readJson<{ buyerPubkey?: string }>(req);
  if (!body.buyerPubkey) return reply(400, errorBody('open requires buyerPubkey'));
  // The 402 IS the answer here, not an error: it carries the terms.
  return reply(402, toPaymentRequired(svc.open(body.buyerPubkey), resource, 'metered session available'));
}

/**
 * ONLY AN AUTHENTICATED COUNTERPARTY MAY HALT A SESSION.
 *
 * SPEC.md 1's "the only remedy for disagreement is to stop" is about two parties who have
 * authenticated themselves and cannot agree on a measurement. It is NOT about a malformed message
 * from an unknown sender -- and `sessionId` is not a secret, it is carried in clear in every
 * message on the wire. Halting on any failure meant anyone who could observe a session id could
 * permanently kill that session with one junk request, which is a denial of service wearing the
 * specification as a disguise.
 *
 * So a failure to AUTHENTICATE is answered with a refusal and no change of state; a failure to
 * AGREE, which only an authenticated party can reach, halts.
 */
const isUnauthenticated = (err: unknown): boolean =>
  err instanceof ReservationUnauthenticated || err instanceof BodyTooLarge || err instanceof SyntaxError;

async function handleBabel(svc: MeteredService, req: IncomingMessage, reply: Reply): Promise<void> {
  const body = await readJson<ChunkRequest>(req);
  const id = body.reservation?.sessionId;
  const session = id ? svc.get(id) : undefined;
  if (!session || !id) return reply(404, errorBody(...NO_SESSION));
  try {
    const delivered = session.chunk(body.reservation, body.prompt);
    svc.persist(id);
    return reply(200, delivered);
  } catch (err) {
    if (isUnauthenticated(err)) return reply(403, errorBody('rejected', String(err)));
    svc.halt(id);
    throw err;
  }
}

async function handleState(svc: MeteredService, req: IncomingMessage, reply: Reply): Promise<void> {
  const body = await readJson<StateRequest>(req);
  const id = body.measurement?.sessionId;
  const session = id ? svc.get(id) : undefined;
  if (!session || !id) return reply(404, errorBody(...NO_SESSION));
  try {
    const settled = session.settle(body.measurement);
    svc.persist(id);
    return reply(200, settled);
  } catch (err) {
    if (isUnauthenticated(err)) return reply(403, errorBody('rejected', String(err)));
    // A disagreement stops the session for good, not just this request (SPEC.md 1).
    svc.halt(id);
    throw err;
  }
}

async function handleCountersign(svc: MeteredService, req: IncomingMessage, reply: Reply): Promise<void> {
  const body = await readJson<{ state: { sessionId?: string }; buyerSig: string }>(req);
  const id = body.state?.sessionId;
  const session = id ? svc.get(id) : undefined;
  const offer = id ? svc.offerFor(id) : undefined;
  if (!session || !offer || !id) return reply(404, errorBody(...NO_SESSION));
  if (!verifyState(body.state, body.buyerSig, offer.buyerPubkey)) {
    // NOT a halt. An unverifiable signature means the sender is not the buyer, so this message is
    // evidence about the sender and none at all about the session. See isUnauthenticated above.
    return reply(403, errorBody('the buyer signature does not verify'));
  }
  session.chainTo(digestHex(body.state));
  svc.persist(id);
  return reply(200, { chained: digestHex(body.state) });
}

const ROUTES: Record<string, (s: MeteredService, r: IncomingMessage, reply: Reply, resource: string) => Promise<void>> = {
  '/metered/open': handleOpen,
  '/metered/babel': (s, r, reply) => handleBabel(s, r, reply),
  '/metered/state': (s, r, reply) => handleState(s, r, reply),
  '/metered/countersign': (s, r, reply) => handleCountersign(s, r, reply),
};

export function meteredHandler(opts: ServeOptions) {
  const resource = opts.resource ?? '/metered';

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const reply: Reply = (code, body) => {
      const payload = JSON.stringify(body);
      res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
    };
    try {
      if (req.method !== 'POST') return reply(405, errorBody('POST only'));
      const route = ROUTES[req.url ?? ''];
      if (!route) return reply(404, errorBody('no such endpoint'));
      await route(opts.service, req, reply, resource);
    } catch (err) {
      if (err instanceof SessionRejected) {
        // 409: the session cannot continue. SPEC.md 1 -- the only remedy for disagreement is to stop.
        return reply(409, errorBody('session halted', err.message));
      }
      if (err instanceof BodyTooLarge) return reply(413, errorBody('request too large', err.message));
      return reply(400, errorBody('bad request', err instanceof Error ? err.message : String(err)));
    }
  };
}

export function serveMetered(opts: ServeOptions): Server {
  const handler = meteredHandler(opts);
  return createServer((req, res) => {
    void handler(req, res);
  });
}
