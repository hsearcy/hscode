// Project provisioning helpers for hscode-mcp.
//
// These power the list_projects / register_project / clone_or_add_github_project
// tools. The pure helpers (URL parsing, path-safety, clone-root derivation,
// credential scrubbing) are unit-tested in projects.test.ts; the git wrappers
// at the bottom are thin shells around `git` and are exercised end-to-end.

import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ParsedRepo {
  /** Repo directory name, e.g. "my-app" (never includes a trailing .git). */
  repoName: string;
  /** Canonical clone URL with any embedded credentials stripped. */
  cloneUrl: string;
  /** "owner/repo" when derivable, else null (e.g. non-GitHub-style paths). */
  slug: string | null;
}

/**
 * Parse a GitHub (or generic git) repo reference into a canonical, safe-to-log
 * clone URL plus the directory name to clone into. Accepts:
 *   - https://github.com/owner/repo(.git)
 *   - http(s)://host/owner/repo(.git)         (credentials in userinfo stripped)
 *   - git@github.com:owner/repo(.git)         (ssh)
 *   - ssh://git@host/owner/repo(.git)
 *   - owner/repo                              (shorthand → github.com)
 * Returns null when the input can't be understood as a repo reference.
 */
export function parseGitRepoUrl(input: string): ParsedRepo | null {
  const raw = input.trim();
  if (!raw) return null;

  // git@host:owner/repo  /  ssh shorthand (scp-like syntax)
  const scpLike = /^([^@\s]+)@([^:\s]+):(.+)$/.exec(raw);
  if (scpLike && !raw.includes("://")) {
    const [, , host, path] = scpLike;
    const cleaned = stripGitSuffix(path!.replace(/^\/+/, ""));
    if (!cleaned) return null;
    return {
      repoName: lastSegment(cleaned),
      cloneUrl: `git@${host}:${stripGitSuffix(path!.replace(/^\/+/, ""))}.git`,
      slug: slugFromPath(cleaned),
    };
  }

  // Full URL with a scheme (https/http/ssh/git).
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    const path = stripGitSuffix(url.pathname.replace(/^\/+/, "").replace(/\/+$/, ""));
    if (!path) return null;
    const host = url.host;
    const scheme = url.protocol.replace(/:$/, "");
    // For http(s), drop any userinfo — that's where access tokens live and we
    // must never echo or persist them. For ssh, keep the username (e.g. `git`),
    // which is required for the clone and is not a secret (ssh authenticates by key).
    const cloneUrl =
      scheme === "ssh"
        ? `ssh://${url.username ? `${url.username}@` : ""}${host}/${path}.git`
        : `${scheme}://${host}/${path}.git`;
    return { repoName: lastSegment(path), cloneUrl, slug: slugFromPath(path) };
  }

  // owner/repo shorthand → assume GitHub over https.
  const shorthand = /^([\w.-]+)\/([\w.-]+)$/.exec(stripGitSuffix(raw));
  if (shorthand) {
    const owner = shorthand[1]!;
    const repo = shorthand[2]!;
    return {
      repoName: repo,
      cloneUrl: `https://github.com/${owner}/${repo}.git`,
      slug: `${owner}/${repo}`,
    };
  }

  return null;
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/i, "");
}

function lastSegment(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function slugFromPath(path: string): string | null {
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

/**
 * Remove credentials embedded in URLs so they never reach responses or logs.
 * Rewrites `scheme://user:pass@host` and `scheme://token@host` to `scheme://host`.
 */
export function scrubCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1");
}

/** Canonical absolute path for comparison: resolved, trailing separator removed. */
export function normalizeWorkspacePath(p: string): string {
  const resolved = resolve(p.trim());
  if (resolved.length > 1 && resolved.endsWith(sep)) {
    return resolved.slice(0, -1);
  }
  return resolved;
}

/** True when `child` is `parent` itself or nested beneath it (no traversal escape). */
export function isInside(parent: string, child: string): boolean {
  const p = normalizeWorkspacePath(parent);
  const c = normalizeWorkspacePath(child);
  return c === p || c.startsWith(p + sep);
}

/**
 * Pick the default directory new repos get cloned into. Preference order:
 *   1. The value configured in Settings (persisted server-side) — `configuredRoot`.
 *   2. An explicit override (HSCODE_PROJECTS_ROOT) — resolved to absolute.
 *   3. The directory that already holds the most registered project workspaces
 *      (so clones land alongside the user's existing repos).
 *   4. `<home>/git`.
 */
export function deriveProjectsRoot(opts: {
  configuredRoot?: string | null | undefined;
  envRoot?: string | undefined;
  existingWorkspaceRoots: readonly string[];
  home: string;
}): string {
  const configured = opts.configuredRoot?.trim();
  if (configured) return normalizeWorkspacePath(configured);

  const env = opts.envRoot?.trim();
  if (env) return normalizeWorkspacePath(env);

  const parentCounts = new Map<string, number>();
  for (const root of opts.existingWorkspaceRoots) {
    if (!root || !isAbsolute(root.trim())) continue;
    const parent = resolve(normalizeWorkspacePath(root), "..");
    parentCounts.set(parent, (parentCounts.get(parent) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [parent, count] of parentCounts) {
    if (count > bestCount) {
      best = parent;
      bestCount = count;
    }
  }
  if (best) return best;

  return normalizeWorkspacePath(`${opts.home}/git`);
}

/**
 * Resolve (and safety-check) the absolute directory a repo should be cloned to.
 * `targetDir` may be omitted (→ <root>/<repoName>), relative (→ joined under
 * root), or absolute (must already live inside root). Throws on any path that
 * would escape `root` via traversal — Hermes-supplied input is untrusted.
 */
export function resolveCloneTarget(opts: {
  root: string;
  repoName: string;
  targetDir?: string | undefined;
}): string {
  const root = normalizeWorkspacePath(opts.root);
  const requested = opts.targetDir?.trim();

  let candidate: string;
  if (!requested) {
    candidate = resolve(root, sanitizeSegment(opts.repoName));
  } else if (isAbsolute(requested)) {
    candidate = normalizeWorkspacePath(requested);
  } else {
    // Reject traversal in the relative form before joining.
    candidate = normalizeWorkspacePath(resolve(root, requested));
  }

  if (!isInside(root, candidate)) {
    throw new Error(
      `refusing unsafe clone target outside the projects root (${root}): ${requested ?? opts.repoName}`,
    );
  }
  if (candidate === root) {
    throw new Error("clone target cannot be the projects root itself");
  }
  return candidate;
}

/** Validate a single derived name segment — rejects separators and traversal. */
function sanitizeSegment(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || /[/\\]/.test(trimmed)) {
    throw new Error(`invalid repository name segment: "${name}"`);
  }
  return trimmed;
}

// ── Impure git/filesystem helpers ────────────────────────────────────────

/** True when `dir` is the root of (or inside) a git working tree. */
export function isGitRepo(dir: string): boolean {
  return existsSync(resolve(dir, ".git"));
}

/** True when the path does not exist or is an empty directory. */
export function isDirEmptyOrMissing(dir: string): boolean {
  if (!existsSync(dir)) return true;
  try {
    if (!statSync(dir).isDirectory()) return false;
    return readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

export interface CloneResult {
  ok: boolean;
  /** Credential-scrubbed stderr tail, present only on failure. */
  error?: string;
}

/**
 * Clone `cloneUrl` into `targetDir`. Never prompts for credentials
 * (GIT_TERMINAL_PROMPT=0) so a private repo without ambient auth fails fast
 * instead of hanging. Any error text is credential-scrubbed before returning.
 */
export async function cloneRepo(opts: {
  cloneUrl: string;
  targetDir: string;
  timeoutMs?: number;
}): Promise<CloneResult> {
  try {
    await execFileAsync("git", ["clone", "--", opts.cloneUrl, opts.targetDir], {
      timeout: opts.timeoutMs ?? 120_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true };
  } catch (err) {
    const stderr =
      typeof err === "object" && err && "stderr" in err
        ? String((err as { stderr: unknown }).stderr)
        : "";
    const message = stderr.trim() || (err instanceof Error ? err.message : String(err));
    return { ok: false, error: scrubCredentials(message).slice(0, 2000) };
  }
}

/** Best-effort check that the `git` CLI is available on PATH. */
export async function gitAvailable(): Promise<boolean> {
  return commandAvailable("git");
}

/** Best-effort check that `command` resolves on PATH (via `which`). */
export async function commandAvailable(command: string): Promise<boolean> {
  try {
    await execFileAsync("which", [command], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
