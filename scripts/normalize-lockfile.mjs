/**
 * Rewrites every `resolved` URL in package-lock.json to the public npm
 * registry.
 *
 * Installing behind a private mirror bakes that mirror's hostname into the
 * lock file. Those hostnames are internal infrastructure and must not reach
 * version control, and they'd be unreachable for anyone cloning the repo.
 * Tarballs are byte-identical across mirrors, so the integrity hashes stay
 * valid after the rewrite.
 *
 * Runs automatically after a root `npm install`. Installing a package from
 * inside a workspace (`npm install -w backend x`) writes the lock file after
 * every hook has run, so `npm test` also runs this with --check and fails
 * loudly if anything slipped through. Fix it by running this script.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const PUBLIC_REGISTRY = 'https://registry.npmjs.org';

// Matches the trailing "<pkg>/-/<file>.tgz" (or "@scope/<pkg>/-/<file>.tgz")
// of a resolved URL, whatever host precedes it.
const RESOLVED = /("resolved":\s*")https?:\/\/[^"]+?((?:@[^/"]+\/)?[^/"]+\/-\/[^"]+")/g;

const lockfile = new URL('../package-lock.json', import.meta.url);
const before = readFileSync(lockfile, 'utf8');
const after = before.replace(RESOLVED, `$1${PUBLIC_REGISTRY}/$2`);

if (after !== before && process.argv.includes('--check')) {
  console.error('package-lock.json points at a private registry mirror.');
  console.error('Run `node scripts/normalize-lockfile.mjs` to fix it.');
  process.exit(1);
}

if (after !== before) {
  JSON.parse(after); // refuse to write anything that isn't valid JSON
  writeFileSync(lockfile, after);
  console.log('normalized package-lock.json to the public npm registry');
}
