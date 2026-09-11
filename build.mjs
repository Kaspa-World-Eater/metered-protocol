/**
 * Compile the package, then put beside it the files it reads at RUNTIME.
 *
 * The covenant is a source file the settlement path compiles per session, because its redeem
 * script embeds that session's own identity. It therefore has to travel with the published
 * package -- and it has to land where `covenant-profile` looks for it, which is one directory
 * above the module doing the looking. In the source tree that is the package root; in `dist/` it
 * is `dist/`. So the contracts are copied rather than referenced, and the same code finds them in
 * both layouts without knowing which one it is in.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

rmSync('dist', { recursive: true, force: true });
execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit', shell: true });

mkdirSync('dist/contracts', { recursive: true });
cpSync('contracts', 'dist/contracts', { recursive: true });
if (existsSync('build/ag')) cpSync('build/ag', 'dist/build/ag', { recursive: true });

console.log('  built dist/ with contracts alongside');
