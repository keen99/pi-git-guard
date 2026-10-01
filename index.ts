/**
 * pi-git-guard
 *
 * Intercepts the bash tool and refuses or prompts on destructive git
 * commands: revert, reset --hard, force push, push --delete, clean -fd,
 * checkout/restore of whole tree, branch -D, rm -r.
 *
 * Modes:
 *   prompt (default) — ask the user Yes (once) / Yes (session) / No.
 *   block            — refuse outright until /gitunsafe.
 *
 * Commands:
 *   /gitunsafe            Disable the gate for the session.
 *   /gitsafe              Re-enable the gate.
 *   /gitguard-mode prompt Set mode to prompt.
 *   /gitguard-mode block  Set mode to block.
 *   /gitguard-mode        Show current mode.
 *   /nogitguard           Disable the entire extension until restart.
 *
 * State is stored via pi.appendEntry so approvals and mode survive /reload.
 * /new and /fork reset state because they start a new session.
 *
 * Detection inspects the raw command string. It finds a `git` token and
 * looks at the subcommand + flags that follow. It handles shell wrappers
 * (sudo, env, time, xargs), && / ; chains, and $(...) is intentionally NOT
 * followed — commands are scanned as text, false positives preferred over
 * a silently rewritten branch.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

type GuardMode = "prompt" | "block";

interface BypassState {
	bypassed: boolean;
}

interface ModeState {
	mode: GuardMode;
}

const BYPASS_KEY = "git-guard-bypass";
const MODE_KEY = "git-guard-mode";

// Commands we refuse/prompt on. Each entry: the git subcommand name and a
// predicate over the tokens that follow. Returns a RuleMatch on match,
// undefined otherwise. `pathspecs` without `alwaysDestructive` means the
// handler must dirty-check those paths first (prompt only when uncommitted
// changes exist for them).
type RuleMatch = string | { command: string; pathspecs?: string[]; alwaysDestructive?: boolean };

const DESTRUCTIVE_RULES: Array<{ subcommand: string; match: (tokens: string[], subcommand: string) => RuleMatch | undefined }> = [
	{ subcommand: "revert", match: (_t, sub) => `git ${sub}` },
	{
		subcommand: "reset",
		match: (t, sub) => t.some((x) => x === "--hard" || x === "-H") ? `git ${sub} ${t.join(" ")}` : undefined,
	},
	{
		subcommand: "push",
		match: (t, sub) =>
			t.some((x) => x === "--force" || x === "-f" || x === "--force-with-lease" || x.includes("--delete"))
				? `git ${sub} ${t.join(" ")}`
				: undefined,
	},
	{
		subcommand: "clean",
		match: (t, sub) =>
			t.some((x) => x.includes("-") && (x.includes("f") || x.includes("d") || x.includes("x")))
				? `git ${sub} ${t.join(" ")}`
				: undefined,
	},
	{
		subcommand: "checkout",
		match: (t, sub) => {
			if (t.length === 0) return undefined;
			const cmd = `git ${sub} ${t.join(" ")}`;
			const dd = t.indexOf("--");
			// Force flag on checkout always discards local modifications.
			if (t.some((x) => x === "-f" || x === "--force"))
				return { command: cmd, pathspecs: pathspecsFrom(t, dd), alwaysDestructive: true };
			if (dd !== -1) {
				const after = t.slice(dd + 1);
				if (after.length === 0 || after.includes(".") || after.includes("*"))
					return { command: cmd, pathspecs: after, alwaysDestructive: true };
			} else if (t.includes(".") || t.includes("*")) {
				return {
					command: cmd,
					pathspecs: t.filter((x) => x === "." || x === "*"),
					alwaysDestructive: true,
				};
			}
			// File checkout discards uncommitted changes to that file. Dirty-check
			// the pathspecs: branch names match nothing in status -> clean -> allow.
			return { command: cmd, pathspecs: pathspecsFrom(t, dd) };
		},
	},
	{
		subcommand: "restore",
		match: (t, sub) => {
			const cmd = `git ${sub}${t.length ? ` ${t.join(" ")}` : ""}`;
			// bare `restore` with no args = restore all unstaged
			if (t.length === 0) return { command: cmd, pathspecs: [], alwaysDestructive: true };
			const dd = t.indexOf("--");
			if (dd !== -1) {
				const after = t.slice(dd + 1);
				if (after.length === 0 || after.includes(".") || after.includes("*"))
					return { command: cmd, pathspecs: after, alwaysDestructive: true };
			} else if (t.includes(".") || t.includes("*")) {
				return {
					command: cmd,
					pathspecs: t.filter((x) => x === "." || x === "*"),
					alwaysDestructive: true,
				};
			}
			return { command: cmd, pathspecs: pathspecsFrom(t, dd) };
		},
	},
	{
		subcommand: "branch",
		match: (t, sub) =>
			t.some((x) => x === "-D" || (x.includes("D") && x.startsWith("-")))
				? `git ${sub} ${t.join(" ")}`
				: undefined,
	},
	{
		subcommand: "rm",
		match: (t, sub) =>
			t.some((x) => x === "-r" || (x.startsWith("-") && x.includes("r")))
				? `git ${sub} ${t.join(" ")}`
				: undefined,
	},
];

// Shell wrappers we strip before looking for `git`.
const WRAPPER_PREFIXES = new Set(["sudo", "env", "time", "nohup", "exec", "command", "xargs"]);

// Verbs that emit their arguments as text rather than executing them. A
// mention of "git revert" inside echo/printf/cat is not a real invocation.
const TEXT_VERBS = new Set(["echo", "printf", "cat", "less", "more", "head", "tail", "grep", "rg", "sed", "awk", "write", "say"]);

interface DestructiveMatch {
	command: string;
	subcommand: string;
	/** Pathspecs (from checkout/restore) that the rule wants dirty-checked. */
	pathspecs?: string[];
	/** True when the rule already decided this is destructive (no dirty-check needed). */
	alwaysDestructive?: boolean;
	/** The full original command string (whole && chain), for display and logging. */
	fullCommand?: string;
}

/** Extract flag tokens from checkout/restore tokens for pathspec collection. */
function pathspecsFrom(tokens: string[], ddIndex: number): string[] {
	if (ddIndex !== -1) return tokens.slice(ddIndex + 1);
	return tokens.filter((x) => !x.startsWith("-"));
}

/**
 * Scan a full bash command string for destructive git invocations.
 * Splits on && ; | and inspects each segment. Returns ALL matches so the
 * prompt can show every destructive command in the chain.
 */
function findAllDestructiveGit(command: string): DestructiveMatch[] {
	const segments = command.split(/(?:&&|\|\||;|\|)/);
	const matches: DestructiveMatch[] = [];
	for (const raw of segments) {
		const match = scanSegment(raw.trim());
		if (match) matches.push({ ...match, fullCommand: command });
	}
	return matches;
}

/** Back-compat: first match only. */
function findDestructiveGit(command: string): DestructiveMatch | undefined {
	return findAllDestructiveGit(command)[0];
}

function scanSegment(segment: string): DestructiveMatch | undefined {
	if (!segment) return undefined;
	// Drop leading env-var assignments (FOO=bar git ...) and redirections
	// (2>/dev/null etc) so they are not mistaken for flags or pathspecs.
	let tokens = tokenize(segment).filter((x) => !isRedirectToken(x));
	while (tokens.length && isEnvAssignment(tokens[0])) tokens = tokens.slice(1);
	// Strip wrapper prefixes (sudo git ..., env git ...).
	while (tokens.length && WRAPPER_PREFIXES.has(tokens[0])) {
		tokens = tokens.slice(1);
		// `env` can carry KEY=VAL pairs before the command.
		while (tokens.length && isEnvAssignment(tokens[0])) tokens = tokens.slice(1);
	}
	// `git` must be the command position: the first real token after wrappers
	// and env assignments. echo/printf/cat can mention "git revert" as text;
	// that is not an execution. Skip the whole segment when the resolved
	// command verb is a text-emitting builtin.
	const verb = tokens[0];
	if (TEXT_VERBS.has(verb)) return undefined;
	if (verb !== "git") return undefined;
	const after = tokens.slice(1);
	// Skip global git flags (-C path, --git-dir, -c key=val, --no-pager, ...).
	let i = 0;
	while (i < after.length && after[i].startsWith("-")) {
		// -C / -c / --git-dir / --work-tree consume a value.
		if (after[i] === "-C" || after[i] === "-c" || after[i] === "--git-dir" || after[i] === "--work-tree" || after[i] === "--namespace") {
			i += 2;
		} else {
			i += 1;
		}
	}
	const subcommand = after[i];
	if (!subcommand) return undefined;
	const flagTokens = after.slice(i + 1);
	for (const rule of DESTRUCTIVE_RULES) {
		if (subcommand === rule.subcommand) {
			const m = rule.match(flagTokens, subcommand);
			if (m === undefined) continue;
			if (typeof m === "string") return { command: m, subcommand };
			return {
				command: m.command,
				subcommand,
				pathspecs: m.pathspecs,
				alwaysDestructive: m.alwaysDestructive,
			};
		}
	}
	return undefined;
}

/** Minimal shell-ish tokenizer. Handles quotes enough to not break on spaces inside them. */
function tokenize(segment: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		if (quote) {
			if (ch === quote) {
				quote = undefined;
			} else {
				current += ch;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (current) tokens.push(current);
	return tokens;
}

function isEnvAssignment(token: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

/** True for shell redirection tokens like `2>/dev/null`, `>out`, `>>out`, `<in`, `2>&1`. */
function isRedirectToken(token: string): boolean {
	return /^(?:\d*)>>?/.test(token) || token.startsWith("<");
}

/**
 * Check whether any of the given pathspecs have uncommitted changes.
 * Returns true (dirty), false (clean), or undefined when the check itself
 * failed (caller must fail safe and prompt).
 */
async function hasUncommittedChanges(
	pi: ExtensionAPI,
	cwd: string,
	pathspecs: string[],
	signal?: AbortSignal,
): Promise<boolean | undefined> {
	try {
		const result = await pi.exec("git", ["-C", cwd, "status", "--porcelain", "--", ...pathspecs], {
			signal,
			timeout: 5000,
		});
		if (result.code !== 0) return undefined;
		return result.stdout.trim().length > 0;
	} catch {
		return undefined;
	}
}

import { execFileSync } from "node:child_process";

function notifyAttention(title: string, body: string): void {
	try {
		if (process.platform === "darwin") {
			execFileSync(
				"osascript",
				["-e", `display notification "${body.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`],
				{ stdio: "ignore", timeout: 2000 },
			);
		}
	} catch {
		/* notifications are best-effort */
	}
}

/** Append a git-guard decision to the session log so approvals/declines
 *  are visible in the transcript after the fact. Best-effort, never throws. */
function logDecision(
	pi: ExtensionAPI,
	decision: "allowed" | "declined" | "blocked" | "bypassed",
	command: string,
	matched: string[],
): void {
	try {
		pi.appendEntry({
			type: "custom",
			customType: "git-guard-decision",
			data: {
				decision,
				matched,
				command,
				at: new Date().toISOString(),
			},
		});
	} catch {
		/* ignore persistence errors */
	}
}

export default function gitGuardExtension(pi: ExtensionAPI): void {
	let bypass = false;
	let disabled = false;
	let mode: GuardMode = "prompt";

	function persistBypass(value: boolean) {
		bypass = value;
		try {
			pi.appendEntry({ type: "custom", customType: BYPASS_KEY, data: { bypassed: value } satisfies BypassState });
		} catch {
			/* ignore persistence errors */
		}
	}

	function persistMode(value: GuardMode) {
		mode = value;
		try {
			pi.appendEntry({ type: "custom", customType: MODE_KEY, data: { mode: value } satisfies ModeState });
		} catch {
			/* ignore persistence errors */
		}
	}

	function restoreFromSession(ctx: { sessionManager: { getEntries(): Array<{ type: string; customType?: string; data?: unknown }> } }) {
		try {
			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type !== "custom") continue;
				if (entry.customType === BYPASS_KEY) {
					const data = entry.data as BypassState | undefined;
					if (data?.bypassed) bypass = true;
				} else if (entry.customType === MODE_KEY) {
					const data = entry.data as ModeState | undefined;
					if (data?.mode === "block" || data?.mode === "prompt") mode = data.mode;
				}
			}
		} catch {
			/* ignore */
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		// Reset per-session flags, then restore persisted state.
		bypass = false;
		mode = "prompt";
		disabled = false;
		restoreFromSession(ctx);
	});

	pi.registerCommand("gitunsafe", {
		description: "git-guard: allow destructive git (this session)",
		handler: (_args, ctx) => {
			persistBypass(true);
			ctx.ui.notify("git-guard: gate disabled for this session (/gitsafe to re-enable)", "info");
		},
	});

	pi.registerCommand("gitsafe", {
		description: "git-guard: re-enable destructive-git gate",
		handler: (_args, ctx) => {
			persistBypass(false);
			ctx.ui.notify(`git-guard: gate re-enabled (mode: ${mode})`, "info");
		},
	});

	pi.registerCommand("gitguard-mode", {
		description: "git-guard: show/set mode (prompt|block)",
		handler: (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed === "prompt" || trimmed === "block") {
				persistMode(trimmed);
				ctx.ui.notify(`git-guard: mode set to ${trimmed}`, "info");
				return;
			}
			ctx.ui.notify(`git-guard: mode is ${mode}${bypass ? " (gate bypassed via /gitunsafe)" : ""}`, "info");
		},
	});

	pi.registerCommand("nogitguard", {
		description: "git-guard: disable entire extension until restart",
		handler: (_args, ctx) => {
			disabled = true;
			ctx.ui.notify("git-guard: disabled until restart", "warning");
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (disabled) return undefined;
		if (!isToolCallEventType("bash", event)) return undefined;
		const command = (event.input as { command?: string }).command;
		if (!command || typeof command !== "string") return undefined;

		const matches = findAllDestructiveGit(command);
		if (matches.length === 0) return undefined;

		// Single-file checkout/restore: only destructive when those pathspecs
		// actually carry uncommitted changes. Branch switches stay silent.
		const gated: DestructiveMatch[] = [];
		for (const match of matches) {
			if (!match.alwaysDestructive && match.pathspecs) {
				const dirty = await hasUncommittedChanges(pi, ctx.cwd, match.pathspecs, ctx.signal);
				if (dirty === false) continue;
				// dirty === true -> gate below; undefined (check failed) -> fail safe, gate.
			}
			gated.push(match);
		}
		if (gated.length === 0) return undefined;

		const matchedList = gated.map((m) => m.command).join("\n  ");
		// Show every destructive segment + the full chain so approval decisions
		// are made on complete information, not one fragment.
		const display = `${matchedList}\n\nFull command:\n  ${command}`;

		if (bypass) {
			logDecision(pi, "bypassed", command, gated.map((m) => m.command));
			return undefined;
		}

		// Lazy restore in case session_start hasn't run for this ctx yet.
		if (!bypass) restoreFromSession(ctx);
		if (bypass) return undefined;

		if (mode === "block" || !ctx.hasUI) {
			logDecision(pi, "blocked", command, gated.map((m) => m.command));
			return {
				block: true,
				reason: `git-guard (${mode}): refusing:\n${display}\nUse /gitunsafe to allow destructive git for this session, or /gitguard-mode prompt to be asked.`,
			};
		}

		notifyAttention("pi needs input", `git-guard: ${gated[0].command}`);

		const choice = await ctx.ui.select(
			`git-guard: destructive git command${gated.length > 1 ? "s" : ""}\n\n  ${display}\n\nAllow? (/gitunsafe = allow all destructive git this session)`,
			["Yes (this time only)", "Yes (remember for session)", "No"],
		);

		if (!choice || choice === "No") {
			logDecision(pi, "declined", command, gated.map((m) => m.command));
			return {
				block: true,
				reason: `User declined:\n${display}`,
			};
		}

		logDecision(pi, "allowed", command, gated.map((m) => m.command));

		if (choice === "Yes (remember for session)") {
			persistBypass(true);
		}

		return undefined;
	});
}
