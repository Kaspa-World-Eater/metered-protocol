/**
 * Loading the Kaspa SDK, and holding the key that pays for anchors.
 *
 * THE SDK IS NOT VENDORED HERE, deliberately. It is a 12 MB WASM blob, and this repository's whole
 * posture is that everything it contains can be verified by CI on a clean checkout. The same
 * arrangement already applies to `silverc` and the debugger: a heavy external artefact is found by
 * environment variable and its absence fails with instructions rather than a stack trace. The
 * encoder was vendored because the golden vector could not otherwise be regenerated; nothing about
 * a checkpoint anchor has that property, because anchoring needs a live node either way.
 *
 * THE KEY LIVES OUTSIDE THE REPOSITORY, at ~/.metered/kaspa.env, for the reason the provider keys
 * do: .gitignore stops a commit and does not stop a read, and anything working on this project can
 * read anything inside it.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

export type { Network } from '../src/proof.js';
import type { Network } from '../src/proof.js';

/**
 * The rusty-kaspa WASM bindings, which are NOT vendored here: 12 MB of WASM with its own release
 * cadence. Point METERED_KASPA_SDK at `kaspa.js` from a nodejs build, or put the same line in
 * ~/.metered/kaspa.env beside the key -- outside the repository, like everything else that is
 * specific to one machine.
 *
 * Only the chain tooling needs it. The specification, the conformance vectors and both
 * implementations run without it.
 */
const SDK_ENV = 'METERED_KASPA_SDK';

export const KEY_FILE = join(homedir(), '.metered', 'kaspa.env');

/* eslint-disable @typescript-eslint/no-explicit-any */
type Sdk = any;

let cached: Sdk | null = null;

/** Read a NAME=value line from the key file, so a machine-specific path stays out of the repository. */
function fromKeyFile(name: string): string | undefined {
  if (!existsSync(KEY_FILE)) return undefined;
  const match = readFileSync(KEY_FILE, 'utf8').match(new RegExp(`^${name}=(.+?)[ \\t\\r]*$`, 'm'));
  return match?.[1];
}

/** Loads the vendored rusty-kaspa WASM bindings. Node 21+ supplies the WebSocket global itself. */
export async function loadSdk(): Promise<Sdk> {
  if (cached) return cached;
  const entry = process.env[SDK_ENV] ?? fromKeyFile(SDK_ENV);
  if (!entry || !existsSync(entry)) {
    throw new Error(
      `Kaspa SDK not found${entry ? ` at ${entry}` : ''}.\n\n` +
        `Set ${SDK_ENV} to kaspa.js from a rusty-kaspa WASM nodejs build, or add\n` +
        `${SDK_ENV}=<path> to ${KEY_FILE}.`,
    );
  }
  const imported = await import(pathToFileURL(entry).href);
  const sdk = (imported.default ?? imported) as Sdk;
  sdk.initConsolePanicHook?.();
  cached = sdk;
  return sdk;
}

/** The anchor key, or null if none has been generated. Never printed by anything here. */
export function loadAnchorKey(): string | null {
  if (!existsSync(KEY_FILE)) return null;
  const match = readFileSync(KEY_FILE, 'utf8').match(/^METERED_ANCHOR_KEY=([0-9a-fA-F]{64})\s*$/m);
  return match ? (match[1] as string).toLowerCase() : null;
}

/** Writes a key to ~/.metered/kaspa.env. Refuses to overwrite: losing one loses its funds. */
export function saveAnchorKey(privateKeyHex: string): void {
  if (loadAnchorKey()) throw new Error(`${KEY_FILE} already holds a key; refusing to overwrite it`);
  mkdirSync(join(homedir(), '.metered'), { recursive: true });
  writeFileSync(
    KEY_FILE,
    '# Metered -- the key that pays for checkpoint anchors. TESTNET ONLY.\n' +
      '# Outside the repository on purpose: .gitignore stops a commit, not a read.\n' +
      `METERED_ANCHOR_KEY=${privateKeyHex}\n`,
    { mode: 0o600 },
  );
}

/** The address this key pays from, which is also where a faucet should send test coins. */
export async function anchorAddress(privateKeyHex: string, network: Network): Promise<string> {
  const sdk = await loadSdk();
  const priv = new sdk.PrivateKey(privateKeyHex);
  return priv.toKeypair().toAddress(new sdk.NetworkId(network)).toString();
}
