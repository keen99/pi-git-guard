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
// predicate over the tokens that follow it.
const DESTRUCTIVE_RULES: Array<{ subcommand: string; match: (tokens: string[]) => boolean; label: string }> = [
	{ subcommand: "revert", match: () => true, label: "git revert" },
	{
		subcommand: "reset",
		match: (tokens) => tokens.some((t) => t === "--hard" || t === "-H"),
		label: "git reset --hard",
	},
	{
		subcommand: "push",
		match: (tokens) =>
			tokens.some((t) => t === "--force" || t === "-f" || t === "--force-with-lease" || t.includes("--delete")),
		label: "git push --force/--delete",
	},
	{
		subcommand: "clean",
		match: (tokens) => tokens.some((t) => t.includes("-") && (t.includes("f") || t.includes("d") || t.includes("x"))),
		label: "git clean -fd/-fdx",
	},
	{
		subcommand: "checkout",
		match: (tokens) => tokens.includes("--") || tokens.includes(".") || tokens.includes("*"),
		label: "git checkout -- .",
	},
	{
		subcommand: "restore",
		match: (tokens) => tokens.includes("--") || tokens.includes(".") || tokens.includes("*") || tokens.includes("--staged") === false && tokens.length === 0,
		label: "git restore .",
	},
	{
		subcommand: "branch",
		match: (tokens) => tokens.some((t) => t === "-D" || t.includes("D") && t.startsWith("-")),
		label: "git branch -D",
	},
	{
		subcommand: "rm",
		match: (tokens) => tokens.some((t) => t === "-r" || (t.startsWith("-") && t.includes("r"))),
		label: "git rm -r",
	},
];

// Shell wrappers we strip before looking for `git`.
const WRAPPER_PREFIXES = new Set(["sudo", "env", "time", "nohup", "exec", "command", "xargs"]);

// Verbs that emit their arguments as text rather than executing them. A
// mention of "git revert" inside echo/printf/cat is not a real invocation.
const TEXT_VERBS = new Set(["echo", "printf", "cat", "less", "more", "head", "tail", "grep", "rg", "sed", "awk", "write", "say"]);

interface DestructiveMatch {
	label: string;
	subcommand: string;
}

/**
 * Scan a full bash command string for a destructive git invocation.
 * Splits on && ; | and inspects each segment. Returns the first match.
 */
function findDestructiveGit(command: string): DestructiveMatch | undefined {
	// Split into segments on chain operators. Keep it simple — we are scanning
	// text, not building an AST.
	const segments = command.split(/(?:&&|\|\||;|\||&&)/);
	for (const raw of segments) {
		const match = scanSegment(raw.trim());
		if (match) return match;
	}
	return undefined;
}

function scanSegment(segment: string): DestructiveMatch | undefined {
	if (!segment) return undefined;
	// Drop leading env-var assignments (FOO=bar git ...) and redirections.
	let tokens = tokenize(segment);
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
		if (subcommand === rule.subcommand && rule.match(flagTokens)) {
			return { label: rule.label, subcommand };
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

function notifyAttention(title: string, body: string): void {
	try {
		const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
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
		description: "Disable the git-guard gate for the rest of the session.",
		handler: (_args, ctx) => {
			persistBypass(true);
			ctx.ui.notify("git-guard: gate disabled for this session (/gitsafe to re-enable)", "info");
		},
	});

	pi.registerCommand("gitsafe", {
		description: "Re-enable the git-guard gate.",
		handler: (_args, ctx) => {
			persistBypass(false);
			ctx.ui.notify(`git-guard: gate re-enabled (mode: ${mode})`, "info");
		},
	});

	pi.registerCommand("gitguard-mode", {
		description: "Show or set the git-guard mode (prompt | block).",
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
		description: "Disable the entire git-guard extension until restart.",
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

		const match = findDestructiveGit(command);
		if (!match) return undefined;

		if (bypass) return undefined;

		// Lazy restore in case session_start hasn't run for this ctx yet.
		if (!bypass) restoreFromSession(ctx);
		if (bypass) return undefined;

		if (mode === "block" || !ctx.hasUI) {
			return {
				block: true,
				reason: `git-guard (${mode}): refusing "${match.label}". Use /gitunsafe to allow destructive git for this session, or /gitguard-mode prompt to be asked.`,
			};
		}

		notifyAttention("pi needs input", `${match.label} blocked`);

		const choice = await ctx.ui.select(
			`Destructive git command detected\n\n  ${match.label}\n\nAllow this command to run?`,
			["Yes (this time only)", "Yes (remember for session)", "No"],
		);

		if (!choice || choice === "No") {
			return {
				block: true,
				reason: `User declined ${match.label}`,
			};
		}

		if (choice === "Yes (remember for session)") {
			persistBypass(true);
		}

		return undefined;
	});
}
