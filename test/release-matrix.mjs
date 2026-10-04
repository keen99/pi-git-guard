#!/usr/bin/env node
// Release matrix: runs the RPC smoke against every published pi release
// starting at 0.75.0 (stable releases only). Versions install once into
// .matrix-cache/<version> (gitignored); later runs only fetch newly
// published releases and re-smoke everything from cache.
//
// Usage:
//   node test/release-matrix.mjs                        # auto: all stable >= 0.75.0
//   PI_MATRIX="0.75.4,1.0.0" node test/release-matrix.mjs   # explicit list
//   PI_MATRIX_INCLUDE_PRERELEASE=1 ...                  # also test rc/beta tags
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cacheRoot = join(root, '.matrix-cache');
const PACKAGE = '@earendil-works/pi-coding-agent';
const MINIMUM = [0, 75, 0];

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/** Every stable published version >= 0.75.0, oldest first. */
async function fetchPublishedVersions() {
  const response = await fetch(
    `https://registry.npmjs.org/${PACKAGE.replace("/", "%2f")}`,
  );
  if (!response.ok) {
    throw new Error(`registry lookup failed: HTTP ${response.status}`);
  }
  const packument = await response.json();
  const includePrerelease = process.env.PI_MATRIX_INCLUDE_PRERELEASE === "1";
  return Object.keys(packument.versions)
    .filter((v) => !v.includes("-") || includePrerelease)
    .filter((v) => compareVersions(v, MINIMUM.join(".")) >= 0)
    .sort(compareVersions);
}

function resolveVersions() {
  const explicit = process.env.PI_MATRIX;
  if (explicit) {
    return Promise.resolve(
      explicit.split(",").map((v) => v.trim()).filter(Boolean),
    );
  }
  return fetchPublishedVersions().then((versions) => {
    console.log(
      `[matrix] discovered ${versions.length} stable releases >= ${MINIMUM.join(".")}`,
    );
    return versions;
  });
}

let failed = 0;
const versions = await resolveVersions();
for (const version of versions) {
  const prefix = join(cacheRoot, version);
  const bin = join(prefix, 'node_modules', '.bin', 'pi');
  if (!existsSync(bin)) {
    console.log(`[matrix] installing ${PACKAGE}@${version} ...`);
    const install = spawnSync('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', `${PACKAGE}@${version}`], { stdio: 'pipe', encoding: 'utf8', timeout: 180_000 });
    if (install.status !== 0 || !existsSync(bin)) {
      console.log(`[matrix] ${version}: INSTALL FAILED`);
      console.error(install.stderr?.slice(0, 500));
      failed++;
      continue;
    }
  }
  const smoke = spawnSync('node', [join(root, 'test', 'rpc-smoke.mjs')], {
    stdio: 'pipe',
    encoding: 'utf8',
    env: { ...process.env, PI_TEST_BIN: bin },
    timeout: 120_000,
  });
  const output = `${smoke.stdout ?? ''}${smoke.stderr ?? ''}`.trim();
  if (smoke.status === 0) {
    console.log(`[matrix] ${version}: PASS`);
  } else {
    failed++;
    console.log(`[matrix] ${version}: FAIL (exit ${smoke.status})`);
    console.error(output.slice(0, 2000));
  }
}

if (failed > 0) {
  console.error(`[matrix] ${failed}/${versions.length} version(s) failed`);
  process.exit(1);
}

// Badge + skip-marker reflect the actual tested range, not just the newest
// release. Written only after a fully green run.
const oldest = versions[0];
const newest = versions[versions.length - 1];
mkdirSync(cacheRoot, { recursive: true });
writeFileSync(
  join(root, 'latest-tested.json'),
  `${JSON.stringify({
    schemaVersion: 1,
    label: 'pi tested',
    message: `${oldest} → ${newest}`,
    color: 'brightgreen',
  })}\n`,
);
writeFileSync(join(cacheRoot, '.latest-tested'), `${newest}\n`);
console.log(`[matrix] all ${versions.length} version(s) pass (${oldest} → ${newest})`);
