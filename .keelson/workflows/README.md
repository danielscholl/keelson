# Maintainer workflows

Keelson maintaining its own repository, from the maintainer's machine. These
workflows are **local-only**: you run them yourself against your own keelson
server. They live in this `.keelson/workflows/` directory so keelson-on-keelson
discovers them as ordinary project workflows — but they are **not** part of the
release. The shipped starter kit is sourced from `packages/workflows/assets/`;
`.keelson/` is otherwise a gitignored runtime home, and this `workflows/`
directory is the one committed exception (a `.gitignore` negation).

The four bundled starter workflows (`smoke-test`, `fix-issue`, `pr-review`,
`plan-act-evaluate`) therefore do **not** appear in this dev home — seeding skips
a populated `.keelson/workflows/`. They live under
`packages/workflows/assets/workflows/`.

| File | What |
|---|---|
| `repo-triage.yaml` | Labels open issues by area/type, surfaces duplicates / already-fixed / stale / off-direction work, and publishes a triage dashboard to the canvas. Never closes. |
| `repo-cleanup.yaml` | The closing half: proposes closes with evidence, pauses for approval, then closes only what you approve. |
| `direction.md` | The project north-star (what keelson IS / IS NOT) and what each label means, consulted by both. Committed and shared. |

The two are deliberately split. `repo-triage` is safe to run on a whim — it reads
and annotates. `repo-cleanup` ends in an irreversible, public action, so it earns
its own workflow and its own gate.

## Running it

A workflow needs a real provider (Copilot or Claude). The CLI registers the same
provider set chat uses (`KEELSON_PROVIDERS` / `config.json`). Because the workflow
lives in this repo's `.keelson/workflows/`, it's discovered by name with no extra
wiring:

```sh
keelson start
keelson workflow run repo-triage --watch   # in another shell
```

That writes nothing to GitHub — it still publishes the full dashboard, which is
the normal way to use this. When the dashboard looks right, apply it:

```sh
keelson workflow run repo-triage --inputs APPLY=1 --watch
```

`APPLY` is a per-run input and overrides the environment default for that run
alone. Prefer it to `KEELSON_TRIAGE_DRY_RUN=0`: env vars are read from the
**executing** process, which is the server when routed, so the env route means
restarting the server — and every other workflow then inherits that setting for
the server's life. `APPLY=0` forces a dry run even where the environment says
otherwise; an unrecognized value fails the node rather than guessing.

An optional argument steers emphasis without changing any factual finding:

```sh
keelson workflow run repo-triage --arguments "focus on the workflow engine" --watch
```

## Closing things out

`repo-cleanup` is the only workflow here that closes an issue, and it cannot do
so without a reply from you:

```sh
keelson workflow run repo-cleanup --watch
```

It finds closeable issues, has a second model on a different vendor try to
**refute** each one against the code, writes a plan, then **pauses**. Nothing has
touched GitHub at that point. Open `close-plan.md` from the paused node — the run
trace offers it in the canvas with the approval composer docked beneath — and
reply:

| Reply | Effect |
|---|---|
| `approve` | closes every issue in the plan |
| `skip 618 686` (or `keep …`) | closes the plan minus those numbers |
| anything else | closes nothing |

The parser requires the `skip`/`keep` keyword rather than accepting any reply
containing digits: "close 902 only" reads as intent to close 902, but a
bare-number rule would exclude it. Ambiguity declines instead of guessing.

Each close posts a comment citing the evidence first — if the comment fails, the
issue is not closed — then labels and closes with a reason:

| Category | Reason | Label |
|---|---|---|
| duplicate | `not planned` | `duplicate` |
| already-resolved | `completed` | — |
| off-direction | `not planned` | `wontfix` |

An issue an open PR would close on merge is **never** a close candidate; it is
reported as superseded and left for the PR.

**Run it against a running server.** The dashboard is published with
`canvas_publish`, which lives in the server's tool registry, not the headless
in-process one. A headless `keelson workflow run` with no server still labels,
notes, and prints every node's output — you just don't get the page.

## What it does

| Node | Kind | Model / effort | Job |
|---|---|---|---|
| `context` | bash | — | Reads `direction.md`, derives the label allow-list from `gh label list`, reports areas with no label |
| `gather` | bash | — | Open issues, open PRs (with changed files), and recently closed issues as one JSON fact block |
| `classify` | AI | `gpt-5.6-sol` · high | Per-issue area + type, grounded by grepping the repo for where the change lands |
| `analyze` | AI | `claude-opus-5` · xhigh | The cross-issue view: duplicates, already-fixed, superseded, stale, off-direction, and what to do next |
| `verify` | AI | `gpt-5.6-terra` · xhigh | Tries to **refute** those claims against source before any of them reach a public comment |
| `decide` | AI | `claude-opus-4.8` · xhigh | Rules on what survived; emits the structured decision. Holds no tools |
| `apply` | bash | — | Labels and notes, dry-run aware, idempotent on a decision hash |
| `report` | AI | `claude-opus-5` · high | Publishes the dashboard via `canvas_publish` |
| `summary` | bash | — | Deterministic tail so the run record ends with facts |

The two finders never see each other (`context: fresh`), the verifier is a
different vendor from the classifier whose claims it re-derives, and the judge is
a different model from both finders — so no node checks or judges its own
reasoning. Model ids are account-dependent; each must appear in
`GET /api/providers/copilot/models`. Swap one, or drop a node to `auto` and
remove its `effort:`, if your account doesn't expose it.

Issue text is attacker-controlled, so every AI node holds read-only tools at
most, `decide` holds none, and `apply` re-validates each label against the
allow-list and strips HTML comments from notes before posting.

`repo-cleanup` runs the same spine — `find` (`claude-opus-5` xhigh) →
`refute` (`gpt-5.6-terra` xhigh) → `plan` (`claude-opus-4.8` xhigh, no tools) →
`render` → **`gate`** → `close`. Only `close` writes, and it runs only after the
gate resolves.

## Knobs

Per-run inputs (`--inputs K=V`) beat the environment for that run alone:

| Input | Effect |
|---|---|
| `APPLY` | `1`/`true`/`yes` applies this `repo-triage` run; `0`/`false`/`no` forces a dry run. Unset falls back to `KEELSON_TRIAGE_DRY_RUN`. An unrecognized value fails the node. |

Environment defaults, read from the **executing** process — your shell when
headless, the server's environment when routed:

| Variable | Default | Effect |
|---|---|---|
| `KEELSON_TRIAGE_DRY_RUN` | `1` | `1` writes nothing to GitHub (the dashboard still publishes); `0` applies. Overridden by `--inputs APPLY=…`. |
| `KEELSON_TRIAGE_COMMENT` | `1` | `0` applies labels only and posts no notes. |
| `KEELSON_TRIAGE_LIMIT` | `30` | Max open issues to fetch. |
| `KEELSON_TRIAGE_STALE_DAYS` | `30` | Age (days since last activity) at which an issue is flagged stale. |
| `KEELSON_TRIAGE_CLOSED_DAYS` | `60` | How far back to pull closed issues for already-fixed and duplicate detection. |
| `KEELSON_CLEANUP_LIMIT` | `40` | Max open issues `repo-cleanup` considers. |
| `KEELSON_CLEANUP_CLOSED_DAYS` | `120` | How far back `repo-cleanup` pulls closed issues. Wider than triage's: "this already shipped" is usually settled by an issue closed months ago. |

`repo-cleanup` has no dry-run knob by design — the approval gate is its dry run,
and every run stops there.

Re-runs converge rather than pile up: each note carries a hash of the *decision*
(labels and signals), not its prose, so an unchanged assessment posts nothing and
a changed one posts an update. The dashboard republishes under the same artifact
name, updating in place.

`gh` must be authenticated (`gh auth status`); the workflow shells out to it for
every read and write.
