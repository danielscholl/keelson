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
| `repo-triage.yaml` | Labels open issues by area/type from the repo's existing labels and posts a terse triage comment. Never closes. |
| `direction.md` | The project north-star (what keelson IS / IS NOT) and the label set, consulted by `repo-triage`. Committed and shared. |

## Running it

A workflow needs a real provider (Copilot or Claude). The CLI registers the same
provider set chat uses (`KEELSON_PROVIDERS` / `config.json`). Because the workflow
lives in this repo's `.keelson/workflows/`, it's discovered by name with no extra
wiring:

```sh
# Dry run first: prints intended labels + comments. DRY_RUN defaults to on.
keelson workflow run repo-triage --watch
```

To apply for real, set `KEELSON_TRIAGE_DRY_RUN=0` on the same invocation and run
it again. It only uses labels the repo already has, posts each triage comment
once (idempotent via a hidden marker), and never closes an issue.

Routing through a running server works too — the bash nodes then read
`KEELSON_TRIAGE_*` from the **server's** environment, not the invoking shell:

```sh
keelson start
keelson workflow run repo-triage --watch   # in another shell
```

## Knobs

| Variable | Default | Effect |
|---|---|---|
| `KEELSON_TRIAGE_DRY_RUN` | `1` | `1` prints intended actions; `0` applies them. Read from the executing process — your shell headless, the server's environment when routed. |
| `KEELSON_TRIAGE_LIMIT` | `30` | Max open issues to fetch. |
| `KEELSON_TRIAGE_STALE_DAYS` | `30` | Age (days since last activity) at which an issue is flagged stale in the comment. |

`gh` must be authenticated (`gh auth status`); the workflow shells out to it for
every read and write.
