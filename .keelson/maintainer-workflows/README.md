# Maintainer workflows

Keelson maintaining its own repository, from the maintainer's machine. These
workflows are **local-only**: you run them yourself against your own keelson
server. They are deliberately kept out of `.keelson/workflows/` so they are never
staged into the release bundle or seeded into users' homes.

| File | What |
|---|---|
| `repo-triage.yaml` | Labels open issues by area/type from the repo's existing labels and posts a terse triage comment. Never closes. |
| `direction.md` | The project north-star (what keelson IS / IS NOT) and the label set, consulted by `repo-triage`. Committed and shared. |

## Running it

A workflow needs a real provider (Copilot or Claude). The CLI registers the
same provider set chat uses (`KEELSON_PROVIDERS` / `config.json`), so the
simplest path is headless — no server required:

```sh
# Dry run first: prints intended labels + comments. DRY_RUN defaults to on.
KEELSON_WORKFLOWS_DIR="$PWD/.keelson/maintainer-workflows" \
  keelson workflow run repo-triage --watch
```

To apply for real, set `KEELSON_TRIAGE_DRY_RUN=0` on the same invocation and
run it again. It only uses labels the repo already has, posts each triage
comment once (idempotent via a hidden marker), and never closes an issue.

Routing through a running server works too — start it with the same
`KEELSON_WORKFLOWS_DIR` (the bash nodes then read `KEELSON_TRIAGE_*` from the
**server's** environment, not the invoking shell):

```sh
KEELSON_WORKFLOWS_DIR="$PWD/.keelson/maintainer-workflows" keelson service
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
