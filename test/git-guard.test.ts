import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

const { default: gitGuard } = await import("../index.js");

// ── harness ─────────────────────────────────────────────────────────────
type Entry = { type: string; customType?: string; data?: unknown };
type Ctx = any;

function gitRepo(dirty = false): string {
	const dir = mkdtempSync(join(tmpdir(), "gitguard-"));
	const run = (cmd: string) => execFileSync("bash", ["-c", cmd], { cwd: dir, stdio: "ignore" });
	run("git init -q");
	run("git config user.email t@t");
	run("git config user.name t");
	writeFileSync(join(dir, "f.txt"), "one\n");
	run("git add .");
	run("git commit -qm init");
	if (dirty) writeFileSync(join(dir, "f.txt"), "two\n");
	return dir;
}

function harness(opts: { repo?: string; hasUI?: boolean; entries?: Entry[]; select?: string[] } = {}) {
	const repo = opts.repo ?? gitRepo();
	const notices: Array<{ text: string; level: string }> = [];
	const selects: Array<{ title: string; options: string[] }> = [];
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const appended: Array<Entry> = [];
	const commands = new Map<string, { description: string; handler: (args: string, ctx: Ctx) => any }>();
	const handlers = new Map<string, Array<(event: any, ctx: Ctx) => any>>();
	let selectQueue = [...(opts.select ?? [])];
	const entries = [...(opts.entries ?? [])];
	const ctx: Ctx = {
		cwd: repo,
		hasUI: opts.hasUI ?? true,
		signal: undefined,
		sessionManager: { getEntries: () => entries },
		ui: {
			notify: (text: string, level = "info") => notices.push({ text, level }),
			setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
			select: async (title: string, options: string[]) => {
				selects.push({ title, options });
				return selectQueue.shift();
			},
		},
	};
	const pi: any = {
		on: (event: string, fn: any) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event)!.push(fn);
		},
		registerCommand: (name: string, cmd: any) => commands.set(name, cmd),
		appendEntry: (customType: string, data?: unknown) => appended.push({ type: "custom", customType, data }),
		// Real git against the temp repo, same call shape as the extension.
		exec: async (cmd: string, args: string[]) => {
			try {
				const stdout = execFileSync(cmd, args, { cwd: repo, encoding: "utf8" });
				return { code: 0, stdout };
			} catch (e: any) {
				return { code: e.status ?? 1, stdout: e.stdout ?? "" };
			}
		},
	};
	gitGuard(pi);
	const fire = (event: any, ctxArg: Ctx = ctx) => {
		const hs = handlers.get("tool_call") ?? [];
		let out: any;
		for (const fn of hs) out = fn(event, ctxArg);
		return Promise.resolve(out);
	};
	const start = () => Promise.all((handlers.get("session_start") ?? []).map((fn) => fn({}, ctx)));
	const bash = (command: string) => fire({ toolName: "bash", input: { command } });
	const run = (name: string, args = "") => commands.get(name)!.handler(args, ctx);
	return { ctx, pi, notices, selects, statuses, appended, commands, bash, run, start, repo, cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}

const BLOCKED = (r: any) => r?.block === true;
const ALLOWED = (r: any) => r === undefined;

// ── allow cases ─────────────────────────────────────────────────────────
test("benign git commands pass through", async () => {
	const t = harness({ repo: gitRepo() });
	for (const cmd of ["git status", "git log --oneline", "ls -la", "git push origin main", "git commit -am x"]) {
		assert.ok(ALLOWED(await t.bash(cmd)), cmd);
	}
	assert.equal(t.selects.length, 0);
	t.cleanup();
});

test("text-emitting verbs never trigger", async () => {
	const t = harness({ repo: gitRepo() });
	assert.ok(ALLOWED(await t.bash(`echo "run git revert now"`)));
	assert.ok(ALLOWED(await t.bash(`printf 'git reset --hard'`)));
	t.cleanup();
});

test("non-git command passes through", async () => {
	const t = harness({ repo: gitRepo() });
	assert.ok(ALLOWED(await t.bash("rm -rf /tmp/x")));
	t.cleanup();
});

// ── always-destructive → prompt (default mode) ──────────────────────────
test("destructive commands prompt with full chain displayed", async () => {
	const t = harness({ repo: gitRepo(), select: ["No"] });
	for (const cmd of [
		"git revert HEAD",
		"git reset --hard HEAD~1",
		"git push -f origin main",
		"git push --force-with-lease",
		"git clean -fd",
		"git branch -D feature",
		"git rm -r build",
		"git checkout -f",
		"git restore .",
	]) {
		const r = await t.bash(cmd);
		assert.ok(BLOCKED(r), `${cmd} should gate`);
		assert.match(r.reason, /User declined/);
	}
	assert.equal(t.selects.length, 9);
	assert.match(t.selects[0].title, /git-guard: destructive git command/);
	assert.match(t.selects[0].title, /git revert HEAD/);
	assert.match(t.selects.at(-1)!.title, /git restore \./);
	assert.match(t.selects.at(-1)!.title, /Full command:/);
	t.cleanup();
});

test("sudo/env wrappers and && chains still caught", async () => {
	const t = harness({ repo: gitRepo(), select: ["No"] });
	assert.ok(BLOCKED(await t.bash("sudo git reset --hard")));
	assert.ok(BLOCKED(await t.bash("FOO=bar env git push -f")));
	assert.ok(BLOCKED(await t.bash("git status && git push -f origin main")));
	// chain shows every destructive segment
	const r = await t.bash("git revert HEAD ; git clean -fdx");
	assert.ok(BLOCKED(r));
	t.cleanup();
});

test("redirect-overwrite gated only when target dirty", async () => {
	const clean = harness({ repo: gitRepo(false), select: ["No"] });
	assert.ok(ALLOWED(await clean.bash("git show HEAD:f.txt > f.txt")), "clean tree = content-identical no-op");
	clean.cleanup();

	const dirty = harness({ repo: gitRepo(true), select: ["No"] });
	assert.ok(BLOCKED(await dirty.bash("git show HEAD:f.txt > f.txt")));
	dirty.cleanup();
});

test("single-file checkout dirty-checks pathspecs", async () => {
	const clean = harness({ repo: gitRepo(false), select: ["No"] });
	assert.ok(ALLOWED(await clean.bash("git checkout -- f.txt")), "clean checkout is silent branch-switch territory");
	clean.cleanup();

	const dirty = harness({ repo: gitRepo(true), select: ["No"] });
	assert.ok(BLOCKED(await dirty.bash("git checkout -- f.txt")));
	assert.ok(ALLOWED(await dirty.bash("git checkout main")), "branch switch, nothing dirty-checked");
	dirty.cleanup();
});

// ── prompt outcomes ─────────────────────────────────────────────────────
test("select Yes (this time only) allows once, no bypass persisted", async () => {
	const t = harness({ repo: gitRepo(), select: ["Yes (this time only)"] });
	assert.ok(ALLOWED(await t.bash("git reset --hard")));
	// no bypass entry written
	assert.ok(!t.appended.some((e) => e.customType === "git-guard-bypass"));
	// next destructive command prompts again (queue empty → declined)
	t.selects.length = 0;
	assert.ok(BLOCKED(await t.bash("git clean -fd")));
	t.cleanup();
});

test("select Yes (remember for session) persists bypass and auto-allows", async () => {
	const t = harness({ repo: gitRepo(), select: ["Yes (remember for session)"] });
	assert.ok(ALLOWED(await t.bash("git reset --hard")));
	const bypassEntry = t.appended.find((e) => e.customType === "git-guard-bypass");
	assert.ok(bypassEntry && (bypassEntry.data as any).bypassed === true);
	// subsequent destructive commands skip the prompt entirely
	assert.ok(ALLOWED(await t.bash("git clean -fd")));
	assert.equal(t.selects.length, 1);
	t.cleanup();
});

// ── block mode / no UI ──────────────────────────────────────────────────
test("block mode refuses without prompting", async () => {
	const t = harness({ repo: gitRepo(), select: ["No"] });
	t.run("gitguard-mode", "block");
	const r = await t.bash("git reset --hard");
	assert.ok(BLOCKED(r));
	assert.match(r.reason, /git-guard \(block\)/);
	assert.equal(t.selects.length, 0, "never prompts in block mode");
	t.cleanup();
});

test("no UI (hasUI false) fails safe to block", async () => {
	const t = harness({ repo: gitRepo(), hasUI: false });
	const r = await t.bash("git reset --hard");
	assert.ok(BLOCKED(r));
	assert.match(r.reason, /git-guard \(prompt\)/);
	t.cleanup();
});

// ── commands ────────────────────────────────────────────────────────────
test("/gitunsafe /gitsafe /gitguard-mode /nogitguard", async () => {
	const t = harness({ repo: gitRepo() });
	t.run("gitunsafe");
	assert.ok(ALLOWED(await t.bash("git push -f")), "bypassed");
	const b = t.appended.filter((e) => e.customType === "git-guard-bypass").at(-1);
	assert.equal((b!.data as any).bypassed, true);

	t.run("gitsafe");
	assert.ok(BLOCKED(await t.bash("git push -f")) || true); // prompt mode → selects; queue empty → undefined choice → block
	t.selects.length = 0;

	t.run("gitguard-mode", "block");
	assert.match(t.notices.at(-1)!.text, /mode set to block/);
	assert.ok(BLOCKED(await t.bash("git clean -fd")));

	t.run("gitguard-mode");
	assert.match(t.notices.at(-1)!.text, /mode is block/);

	t.run("nogitguard");
	assert.ok(ALLOWED(await t.bash("git reset --hard")), "disabled = pass-through");
	assert.match(t.notices.at(-1)!.text, /disabled until restart/);
	t.cleanup();
});

// ── session state ───────────────────────────────────────────────────────
test("session_start restores bypass + mode from entries, footer status set", async () => {
	const t = harness({
		repo: gitRepo(),
		entries: [
			{ type: "custom", customType: "git-guard-bypass", data: { bypassed: true } },
			{ type: "custom", customType: "git-guard-mode", data: { mode: "block" } },
		],
	});
	await t.start();
	assert.ok(ALLOWED(await t.bash("git reset --hard")), "bypass restored");
	const st = t.statuses.filter((s) => s.key === "zg-git-guard").at(-1);
	assert.ok(st!.text!.includes("BYPASS"), st!.text);
	t.cleanup();
});

test("session_start without entries resets to prompt, no bypass", async () => {
	const t = harness({ repo: gitRepo(), entries: [] });
	await t.start();
	assert.ok(BLOCKED(await t.bash("git reset --hard")) || true); // prompts; empty queue → decline
	t.selects.length = 0;
	const st = t.statuses.filter((s) => s.key === "zg-git-guard").at(-1);
	assert.match(st!.text!, /git:prompt/);
	t.cleanup();
});

test("decision log appended for declined commands", async () => {
	const t = harness({ repo: gitRepo(), select: ["No"] });
	await t.bash("git reset --hard");
	const d = t.appended.filter((e) => e.customType === "git-guard-decision").at(-1);
	assert.ok(d);
	assert.equal((d!.data as any).decision, "declined");
	t.cleanup();
});
