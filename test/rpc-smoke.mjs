#!/usr/bin/env node
// Deep pinned-pi smoke for the hostname footer. Footer is pure TUI (no RPC
// verbs, no commands), so the real-pi proof is: on this pi version, the
// extension loads, session_start fires, and the footer factory installs
// without error. The extension writes GIT_GUARD_DEBUG marker when setFooter()
// has been called on the real session's ui object.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), 'footer-deep-'));
const agentDir = join(dir, 'agent');
mkdirSync(join(agentDir, 'sessions', 'tmp'), { recursive: true });
const MARKER = join(agentDir, 'git-guard-installed.json');

const bin = process.env.PI_TEST_BIN ?? join(dirname(process.execPath), 'pi');
const child = spawn(
	bin,
	['--mode', 'rpc', '--no-extensions', '-e', join(root, 'index.ts'), '--session-dir', join(agentDir, 'sessions', 'tmp')],
	{ env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, GIT_GUARD_DEBUG: '1' }, cwd: dir },
);
let err = '';
child.stderr.on('data', (d) => { err += d; });

const t0 = Date.now();
const timer = setInterval(() => {
	if (existsSync(MARKER)) {
		clearInterval(timer);
		finish(true);
	} else if (Date.now() - t0 > 20_000) {
		clearInterval(timer);
		finish(false);
	}
}, 200);
const killTimer = setTimeout(() => child.kill('SIGKILL'), 40_000);

function finish(ok) {
	child.kill('SIGTERM');
	child.on('exit', () => {
		clearTimeout(killTimer);
		try {
			assert2(ok, `marker never appeared in 20s; stderr tail: ${err.slice(-800)}`);
			const marker = JSON.parse(readFileSync(MARKER, 'utf8'));
			assert2(marker.installed === true, `marker content: ${JSON.stringify(marker)}`);
			assert2(!/Extension error|Failed to load/i.test(err), `extension error in stderr: ${err.slice(-400)}`);
			console.log(`Deep smoke PASS: git-guard installed on real pi (${(Date.now() - t0) / 1000 | 0}s).`);
		} catch (e) {
			console.error('FAIL', e.message);
			process.exitCode = 1;
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}
function assert2(cond, msg) { if (!cond) throw new Error(msg); }
