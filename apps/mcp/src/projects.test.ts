import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveProjectsRoot,
  isInside,
  normalizeWorkspacePath,
  parseGitRepoUrl,
  resolveCloneTarget,
  scrubCredentials,
} from "./projects.ts";

describe("parseGitRepoUrl", () => {
  it("parses an https GitHub URL", () => {
    expect(parseGitRepoUrl("https://github.com/openai/codex")).toEqual({
      repoName: "codex",
      cloneUrl: "https://github.com/openai/codex.git",
      slug: "openai/codex",
    });
  });

  it("strips a trailing .git and a trailing slash", () => {
    expect(parseGitRepoUrl("https://github.com/openai/codex.git")?.cloneUrl).toBe(
      "https://github.com/openai/codex.git",
    );
    expect(parseGitRepoUrl("https://github.com/openai/codex/")?.repoName).toBe("codex");
  });

  it("strips embedded credentials from https URLs", () => {
    const parsed = parseGitRepoUrl("https://x-access-token:ghp_secret@github.com/owner/repo.git");
    expect(parsed?.cloneUrl).toBe("https://github.com/owner/repo.git");
    expect(parsed?.cloneUrl).not.toContain("ghp_secret");
    expect(parsed?.cloneUrl).not.toContain("x-access-token");
  });

  it("parses scp-like ssh syntax", () => {
    expect(parseGitRepoUrl("git@github.com:owner/repo.git")).toEqual({
      repoName: "repo",
      cloneUrl: "git@github.com:owner/repo.git",
      slug: "owner/repo",
    });
  });

  it("parses ssh:// URLs and keeps the (non-secret) ssh username", () => {
    const parsed = parseGitRepoUrl("ssh://git@github.com/owner/repo.git");
    expect(parsed?.cloneUrl).toBe("ssh://git@github.com/owner/repo.git");
    expect(parsed?.repoName).toBe("repo");
  });

  it("expands owner/repo shorthand to a GitHub https URL", () => {
    expect(parseGitRepoUrl("openai/codex")).toEqual({
      repoName: "codex",
      cloneUrl: "https://github.com/openai/codex.git",
      slug: "openai/codex",
    });
  });

  it("returns null for unparseable input", () => {
    expect(parseGitRepoUrl("")).toBeNull();
    expect(parseGitRepoUrl("not a repo at all")).toBeNull();
    expect(parseGitRepoUrl("https://github.com/")).toBeNull();
  });

  it("returns null for a malformed credential-bearing URL (no path)", () => {
    // The clone tool scrubs args.repo before echoing it in the parse-failure
    // error; this guards the input that triggers that path.
    expect(parseGitRepoUrl("https://x-access-token:ghp_secret@github.com/")).toBeNull();
  });
});

describe("scrubCredentials", () => {
  it("removes userinfo from URLs in arbitrary text", () => {
    const text = "fatal: could not read from https://token123@github.com/owner/repo.git";
    const scrubbed = scrubCredentials(text);
    expect(scrubbed).toContain("https://github.com/owner/repo.git");
    expect(scrubbed).not.toContain("token123");
  });

  it("removes user:pass form too", () => {
    expect(scrubCredentials("https://user:pass@example.com/x")).toBe("https://example.com/x");
  });

  it("leaves credential-free text unchanged", () => {
    expect(scrubCredentials("https://github.com/owner/repo.git")).toBe(
      "https://github.com/owner/repo.git",
    );
  });

  it("scrubs a malformed credential-bearing repo string (parse-failure echo path)", () => {
    const malformed = "https://x-access-token:ghp_secret@github.com/";
    const scrubbed = scrubCredentials(malformed);
    expect(scrubbed).not.toContain("ghp_secret");
    expect(scrubbed).not.toContain("x-access-token");
    expect(scrubbed).toBe("https://github.com/");
  });
});

describe("normalizeWorkspacePath", () => {
  it("strips a trailing separator", () => {
    expect(normalizeWorkspacePath("/home/u/git/app/")).toBe("/home/u/git/app");
  });

  it("resolves relative segments", () => {
    expect(normalizeWorkspacePath("/home/u/git/../git/app")).toBe("/home/u/git/app");
  });
});

describe("isInside", () => {
  it("accepts a nested path", () => {
    expect(isInside("/home/u/git", "/home/u/git/app")).toBe(true);
  });

  it("accepts the directory itself", () => {
    expect(isInside("/home/u/git", "/home/u/git")).toBe(true);
  });

  it("rejects a sibling and traversal escapes", () => {
    expect(isInside("/home/u/git", "/home/u/other")).toBe(false);
    expect(isInside("/home/u/git", "/home/u/git/../secrets")).toBe(false);
  });

  it("does not treat a path prefix as containment", () => {
    expect(isInside("/home/u/git", "/home/u/git-secrets")).toBe(false);
  });
});

describe("deriveProjectsRoot", () => {
  it("honors an explicit env override", () => {
    expect(
      deriveProjectsRoot({
        envRoot: "/srv/projects/",
        existingWorkspaceRoots: [],
        home: "/home/u",
      }),
    ).toBe("/srv/projects");
  });

  it("derives the most common parent of existing workspaces", () => {
    expect(
      deriveProjectsRoot({
        existingWorkspaceRoots: ["/home/u/git/a", "/home/u/git/b", "/home/u/code/c"],
        home: "/home/u",
      }),
    ).toBe("/home/u/git");
  });

  it("falls back to <home>/git when there are no existing projects", () => {
    expect(deriveProjectsRoot({ existingWorkspaceRoots: [], home: "/home/u" })).toBe("/home/u/git");
  });

  it("ignores relative workspace roots when deriving", () => {
    expect(deriveProjectsRoot({ existingWorkspaceRoots: ["relative/path"], home: "/home/u" })).toBe(
      "/home/u/git",
    );
  });
});

describe("resolveCloneTarget", () => {
  const root = "/home/u/git";

  it("defaults to <root>/<repoName>", () => {
    expect(resolveCloneTarget({ root, repoName: "codex" })).toBe("/home/u/git/codex");
  });

  it("joins a relative targetDir under the root", () => {
    expect(resolveCloneTarget({ root, repoName: "codex", targetDir: "nested/codex" })).toBe(
      "/home/u/git/nested/codex",
    );
  });

  it("accepts an absolute targetDir inside the root", () => {
    expect(resolveCloneTarget({ root, repoName: "codex", targetDir: "/home/u/git/custom" })).toBe(
      "/home/u/git/custom",
    );
  });

  it("rejects traversal that escapes the root", () => {
    expect(() => resolveCloneTarget({ root, repoName: "codex", targetDir: "../escape" })).toThrow();
    expect(() =>
      resolveCloneTarget({ root, repoName: "codex", targetDir: "/etc/passwd" }),
    ).toThrow();
  });

  it("rejects a repo name containing path separators", () => {
    expect(() => resolveCloneTarget({ root, repoName: "../evil" })).toThrow();
  });

  it("rejects the projects root itself", () => {
    expect(() => resolveCloneTarget({ root, repoName: "codex", targetDir: root })).toThrow();
  });

  it("produces absolute, normalized output", () => {
    const out = resolveCloneTarget({ root, repoName: "codex" });
    expect(out).toBe(resolve(out));
  });
});
