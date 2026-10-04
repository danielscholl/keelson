import "./test-setup.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { ProjectOperationError } from "@keelson/shared";
import { runText } from "@keelson/shared/exec";
import { openDatabase } from "../src/db/init.ts";
import { createProjectsService } from "../src/projects-service.ts";
import { createProjectsStore } from "../src/projects-store.ts";
import { rmTemp } from "./temp.ts";

let temp: string;
let db: ReturnType<typeof openDatabase>;
let store: ReturnType<typeof createProjectsStore>;
let workspace: string;
let config: string;

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "keelson-project-service-"));
  workspace = join(temp, "workspace");
  config = join(temp, "gitconfig");
  writeFileSync(config, "[user]\n name = Test Operator\n email = operator@example.test\n");
  db = openDatabase({ path: join(temp, "test.db") });
  store = createProjectsStore(db);
});

describe("cloneProject", () => {
  async function source(name = "source.git") {
    const root = join(temp, name);
    mkdirSync(root);
    await git(["init"], root);
    await git(["commit", "--allow-empty", "-m", "Source"], root);
    return root;
  }

  test("clones local repositories with derived and explicit names, preserving HEAD", async () => {
    const url = await source();
    const svc = service();
    const derived = await svc.cloneProject({ url: `${url}/` });
    const explicit = await svc.cloneProject({ url, name: "explicit" });
    expect(derived.name).toBe("source");
    expect(derived.rootPath).toBe(join(workspace, "source"));
    expect(await git(["rev-parse", "HEAD"], derived.rootPath)).toBe(
      await git(["rev-parse", "HEAD"], url),
    );
    expect(store.list()).toEqual([explicit, derived]);
  });

  test("rejects runtime schema errors and invalid derived names without side effects", async () => {
    const svc = service();
    await expect(svc.cloneProject({ url: "" })).rejects.toMatchObject({ status: 400 });
    await expect(svc.cloneProject({ url: "http://example.com/" })).rejects.toMatchObject({
      status: 400,
    });
    await expect(svc.cloneProject({ url: "git@example.test:Bad Name.git" })).rejects.toMatchObject({
      status: 400,
    });
    expect(existsSync(workspace)).toBe(false);
  });

  test("preserves existing empty destinations and rejects registered names and roots", async () => {
    mkdirSync(workspace);
    const dest = join(workspace, "exists");
    mkdirSync(dest);
    const svc = service();
    await expect(svc.cloneProject({ url: "/source", name: "exists" })).rejects.toMatchObject({
      status: 409,
    });
    expect(readdirSync(dest)).toEqual([]);
    store.create({ name: "taken", rootPath: join(temp, "outside") });
    await expect(svc.cloneProject({ url: "/source", name: "taken" })).rejects.toMatchObject({
      status: 409,
    });
    store.create({ name: "registered", rootPath: join(workspace, "root") });
    await expect(svc.cloneProject({ url: "/source", name: "root" })).rejects.toMatchObject({
      status: 409,
    });
    expect(existsSync(join(workspace, "root"))).toBe(false);
  });

  test("cleans partial clones and releases reservations for retry", async () => {
    const url = await source();
    let fail = true;
    const runGit: typeof runText = async (cmd, args, opts) => {
      if (fail) {
        const dest = args.at(-1);
        if (!dest) throw new Error("missing destination");
        writeFileSync(join(dest, "partial"), "partial");
        return { ok: false, error: "timed out after 60000ms", code: null };
      }
      return testGit(cmd, args, opts);
    };
    const svc = service(runGit);
    await expect(svc.cloneProject({ url })).rejects.toMatchObject({
      status: 502,
      message: "git clone failed: timed out after 60000ms",
    });
    expect(existsSync(workspace)).toBe(false);
    expect(store.list()).toEqual([]);
    fail = false;
    await svc.cloneProject({ url });
    expect(store.list()).toHaveLength(1);
  });

  test("surfaces thrown spawn and real clone failures as 502 with cleanup", async () => {
    const throwing: typeof runText = async () => {
      throw new Error("spawn failed");
    };
    await expect(
      service(throwing).cloneProject({ url: "/missing", name: "throwing" }),
    ).rejects.toMatchObject({
      status: 502,
      message: "git clone failed: spawn failed",
    });
    await expect(
      service().cloneProject({ url: join(temp, "missing"), name: "missing" }),
    ).rejects.toMatchObject({
      status: 502,
    });
    expect(existsSync(workspace)).toBe(false);
  });

  test("rolls back successful clones when registration fails and rechecks final conflicts", async () => {
    const url = await source();
    const create = store.create;
    store.create = () => {
      throw new Error("insert failed");
    };
    await expect(service().cloneProject({ url })).rejects.toMatchObject({
      status: 500,
      message: "project registration failed: insert failed",
    });
    expect(existsSync(workspace)).toBe(false);
    store.create = create;
    const concurrent: typeof runText = async (cmd, args, opts) => {
      const result = await testGit(cmd, args, opts);
      store.create({ name: "source", rootPath: join(temp, "competing") });
      return result;
    };
    await expect(service(concurrent).cloneProject({ url })).rejects.toMatchObject({ status: 409 });
    expect(existsSync(workspace)).toBe(false);
    expect(store.list()).toHaveLength(1);
  });

  test("preserves replacement directories and reports cleanup errors with the original failure", async () => {
    const replacement: typeof runText = async (_cmd, args) => {
      const dest = args.at(-1);
      if (!dest) throw new Error("missing destination");
      renameSync(dest, join(temp, "moved"));
      mkdirSync(dest);
      writeFileSync(join(dest, "operator-file"), "keep");
      return { ok: false, error: "clone failed", code: 1 };
    };
    await expect(
      service(replacement).cloneProject({ url: "/source", name: "replaced" }),
    ).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining("git clone failed: clone failed; cleanup failed:"),
    });
    expect(readFileSync(join(workspace, "replaced", "operator-file"), "utf8")).toBe("keep");
  });

  test("shares reservations across create and clone requests", async () => {
    const url = await source();
    const svc = service();
    const clone = svc.cloneProject({ url, name: "same" });
    await expect(svc.createProject({ name: "same" })).rejects.toMatchObject({ status: 409 });
    await expect(
      svc.createProject({ name: "other", rootPath: join(workspace, "same") }),
    ).rejects.toMatchObject({ status: 409 });
    await clone;
    const create = svc.createProject({ name: "create-first" });
    await expect(svc.cloneProject({ url, name: "create-first" })).rejects.toMatchObject({
      status: 409,
    });
    await create;
    expect(store.list()).toHaveLength(2);
  });

  test("uses argv separation, noninteractive Git, and a bounded timeout", async () => {
    const fake: typeof runText = async (cmd, args, opts) => {
      expect(cmd).toBe("git");
      expect(args).toEqual(["clone", "--", "git@example.test:Repo.git/", join(workspace, "repo")]);
      expect(opts?.timeoutMs).toBe(60_000);
      expect(opts?.env?.GIT_TERMINAL_PROMPT).toBe("0");
      expect(opts?.env?.GIT_SSH_COMMAND).toBe("ssh -o BatchMode=yes");
      if (process.platform !== "win32") expect(opts?.env?.GIT_ASKPASS).toBe("/usr/bin/true");
      return { ok: false, error: "test stop", code: 1 };
    };
    await expect(
      service(fake).cloneProject({ url: "git@example.test:Repo.git/" }),
    ).rejects.toMatchObject({
      status: 502,
    });
  });
});

afterEach(() => {
  db.close();
  rmTemp(temp);
});

const testGit: typeof runText = (cmd, args, opts) =>
  runText(cmd, args, {
    ...opts,
    env: {
      ...opts?.env,
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });

function service(runGit: typeof runText = testGit) {
  return createProjectsService({ store, workspaceRoot: workspace, runGit });
}

async function git(args: string[], cwd: string) {
  const result = await testGit("git", args, { cwd });
  if (!result.ok) throw new Error(result.error);
  return result.data.trim();
}

describe("createProject", () => {
  test("create initializes a missing default target with one empty operator commit", async () => {
    const project = await service().createProject({ name: "demo" });
    expect(project.rootPath).toBe(join(workspace, "demo"));
    expect(store.list()).toEqual([project]);
    expect(readdirSync(project.rootPath)).toEqual([".git"]);
    expect(await git(["rev-list", "--count", "HEAD"], project.rootPath)).toBe("1");
    expect(await git(["log", "-1", "--format=%s|%an|%ae"], project.rootPath)).toBe(
      "Initialize project|Test Operator|operator@example.test",
    );
    expect(await git(["ls-tree", "-r", "--name-only", "HEAD"], project.rootPath)).toBe("");
    const worktree = join(temp, "immediate-write");
    await git(["worktree", "add", "-b", "immediate-write", worktree], project.rootPath);
    expect(await git(["rev-parse", "HEAD"], worktree)).toBe(
      await git(["rev-parse", "HEAD"], project.rootPath),
    );
  });

  test("create initializes an existing empty folder and trims explicit paths", async () => {
    const rootPath = join(temp, "empty");
    mkdirSync(rootPath);
    const project = await service().createProject({ name: "empty", rootPath: ` ${rootPath}/ ` });
    expect(project.rootPath).toBe(rootPath);
    expect(await git(["rev-parse", "--verify", "HEAD"], rootPath)).not.toBe("");
  });

  test("create registers populated non-Git and hidden-file folders untouched", async () => {
    const rootPath = join(temp, "files");
    mkdirSync(rootPath);
    writeFileSync(join(rootPath, ".keep"), "operator data");
    await service().createProject({ name: "files", rootPath });
    expect(readdirSync(rootPath)).toEqual([".keep"]);
    expect(readFileSync(join(rootPath, ".keep"), "utf8")).toBe("operator data");
  });

  test("create preserves existing committed and unborn repositories and linked worktrees", async () => {
    const rootPath = join(temp, "repo");
    mkdirSync(rootPath);
    await git(["init"], rootPath);
    await service().createProject({ name: "unborn", rootPath });
    const head = readFileSync(join(rootPath, ".git", "HEAD"), "utf8");
    expect((await testGit("git", ["rev-parse", "--verify", "HEAD"], { cwd: rootPath })).ok).toBe(
      false,
    );
    await git(["commit", "--allow-empty", "-m", "Existing"], rootPath);
    const before = await git(["rev-parse", "HEAD"], rootPath);
    const worktree = join(temp, "linked");
    await git(["worktree", "add", "-b", "linked", worktree], rootPath);
    await service().createProject({ name: "linked", rootPath: worktree });
    expect(await git(["rev-parse", "HEAD"], worktree)).toBe(before);
    expect(readFileSync(join(rootPath, ".git", "HEAD"), "utf8")).toBe(head);
    expect(await git(["rev-list", "--count", "HEAD"], rootPath)).toBe("1");
  });

  test("create registers a populated non-Git child of a checkout without adopting it", async () => {
    mkdirSync(workspace);
    await git(["init"], workspace);
    const child = join(workspace, "child");
    mkdirSync(child);
    writeFileSync(join(child, "data"), "unchanged");
    await service().createProject({ name: "child" });
    expect(readdirSync(child)).toEqual(["data"]);
  });

  test("create validates runtime bodies, relative/blank roots, files, and broken metadata", async () => {
    const svc = service();
    for (const rootPath of ["relative", "  "]) {
      await expect(svc.createProject({ name: "bad", rootPath })).rejects.toMatchObject({
        status: 400,
      });
    }
    await expect(svc.createProject({ name: "Upper" })).rejects.toMatchObject({ status: 400 });
    const file = join(temp, "file");
    writeFileSync(file, "data");
    await expect(svc.createProject({ name: "file", rootPath: file })).rejects.toMatchObject({
      status: 400,
    });
    const broken = join(temp, "broken");
    mkdirSync(broken);
    writeFileSync(join(broken, ".git"), "invalid");
    await expect(svc.createProject({ name: "broken", rootPath: broken })).rejects.toMatchObject({
      status: 400,
    });
    expect(readFileSync(join(broken, ".git"), "utf8")).toBe("invalid");
  });

  test("create allows nested default projects but rejects exact canonical roots and names", async () => {
    mkdirSync(workspace);
    store.create({ name: "default", rootPath: workspace });
    const svc = service();
    const created = await svc.createProject({ name: "nested" });
    const link = join(temp, "alias");
    symlinkSync(workspace, link, process.platform === "win32" ? "junction" : "dir");
    await expect(
      svc.createProject({ name: "alias", rootPath: join(link, "nested") }),
    ).rejects.toMatchObject({ status: 409 });
    const missing = join(temp, "not-created");
    await expect(svc.createProject({ name: "nested", rootPath: missing })).rejects.toMatchObject({
      status: 409,
    });
    store.create({ name: "gone", rootPath: missing });
    await expect(svc.createProject({ name: "other", rootPath: missing })).rejects.toMatchObject({
      status: 409,
    });
    expect(existsSync(missing)).toBe(false);
    expect(store.get(created.id)).toEqual(created);
  });

  test("create reserves both name and root during asynchronous preparation", async () => {
    const svc = service();
    const first = svc.createProject({ name: "same" });
    await expect(
      svc.createProject({ name: "same", rootPath: join(temp, "other") }),
    ).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      svc.createProject({ name: "other", rootPath: join(workspace, "same") }),
    ).rejects.toMatchObject({
      status: 409,
    });
    await first;
    expect(store.list()).toHaveLength(1);
  });

  test("create rolls back init and persistence failures and releases reservations", async () => {
    const fail: typeof runText = async () => ({ ok: false, error: "git not found", code: null });
    await expect(service(fail).createProject({ name: "failed" })).rejects.toMatchObject({
      status: 500,
      message: "Git initialization failed: git not found",
    });
    expect(existsSync(workspace)).toBe(false);
    const svc = service();
    const create = store.create;
    store.create = () => {
      throw new Error("database write failed");
    };
    await expect(svc.createProject({ name: "retry" })).rejects.toMatchObject({ status: 500 });
    expect(existsSync(workspace)).toBe(false);
    store.create = create;
    await svc.createProject({ name: "retry" });
  });

  test("create reports missing identity config and preserves a pre-existing empty directory", async () => {
    writeFileSync(config, "");
    const noIdentity: typeof runText = (cmd, args, opts) =>
      runText(cmd, args, {
        ...opts,
        env: {
          ...opts?.env,
          GIT_CONFIG_GLOBAL: config,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "user.useConfigOnly",
          GIT_CONFIG_VALUE_0: "true",
          GIT_AUTHOR_NAME: "",
          GIT_AUTHOR_EMAIL: "",
          GIT_COMMITTER_NAME: "",
          GIT_COMMITTER_EMAIL: "",
        },
      });
    const rootPath = join(temp, "empty");
    mkdirSync(rootPath);
    await expect(
      service(noIdentity).createProject({ name: "identity", rootPath }),
    ).rejects.toMatchObject({
      status: 500,
      message: expect.stringContaining("user.name and user.email"),
    });
    expect(readdirSync(rootPath)).toEqual([]);
    expect(store.list()).toEqual([]);
    await expect(service(noIdentity).createProject({ name: "missing" })).rejects.toBeInstanceOf(
      ProjectOperationError,
    );
    expect(existsSync(workspace)).toBe(false);
  });

  test("create retains unexpected content and reports cleanup failure without hiding the cause", async () => {
    const fail: typeof runText = async (_cmd, _args, opts) => {
      if (!opts?.cwd) throw new Error("missing cwd");
      writeFileSync(join(opts.cwd, "operator-file"), "keep");
      return { ok: false, error: "init failed", code: 1 };
    };
    await expect(service(fail).createProject({ name: "retained" })).rejects.toMatchObject({
      status: 500,
      message: expect.stringContaining("Git initialization failed: init failed; cleanup failed:"),
    });
    const rootPath = join(workspace, "retained");
    expect(readFileSync(join(rootPath, "operator-file"), "utf8")).toBe("keep");
    expect(existsSync(join(rootPath, ".git"))).toBe(false);
    expect(store.list()).toEqual([]);
  });

  test("create expands tilde without writing outside fixtures", async () => {
    const rootPath = join(temp, "tilde");
    mkdirSync(rootPath);
    writeFileSync(join(rootPath, "data"), "keep");
    const { homedir } = await import("node:os");
    const project = await service().createProject({
      name: "tilde",
      rootPath: `~/${relative(homedir(), rootPath)}`,
    });
    expect(project.rootPath).toBe(rootPath);
  });
});
