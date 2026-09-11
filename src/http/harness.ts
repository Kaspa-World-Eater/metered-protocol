/**
 * One metered server, started and stopped around a test.
 *
 * Shared rather than copied. Two files needed the same three lines -- start a service, listen on
 * an ephemeral port, close it afterwards -- and a copy of a fixture drifts exactly as readily as
 * a copy of anything else: the moment one file's terms change and the other's do not, two tests
 * claiming to exercise "the server" are exercising different servers.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serveMetered } from './serve.js';
import { MeteredService, type ServiceOptions } from './service.js';

export interface Harness {
  base: string;
  service: MeteredService;
  server: Server;
}

/** Start a server around `opts`, run `body`, and close it however `body` ends. */
export async function withMeteredServer(
  opts: ServiceOptions,
  body: (h: Harness) => Promise<void>,
): Promise<void> {
  const service = new MeteredService(opts);
  const server = serveMetered({ service });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await body({ base, service, server });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

