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

A workflow needs a real provider (Copilot or Claude), and today that means
routing through your running server. Headless real-provider runs
(`keelson workflow run --provider claude` with no server) are tracked in
[#171](https://github.com/danielscholl/keelson/issues/171); once that lands, the
server step goes away.

Point your server at this directory so it discovers these workflows, then run:

```sh
# Start the server with this dir as the workflow catalog (foreground shown;
# `service start` works too). DRY_RUN defaults to on, so this is safe.
KEELSON_WORKFLOWS_DIR="$PWD/.keelson/maintainer-workflows" keelson service

# In another shell — dry run first: prints intended labels + comments.
keelson workflow run repo-triage --watch
```

To apply for real, restart the server with `KEELSON_TRIAGE_DRY_RUN=0` (the bash
nodes read it from the server's environment), then run it again. It only uses
labels the repo already has, posts each triage comment once (idempotent via a
hidden marker), and never closes an issue.

## Knobs

| Variable | Default | Effect |
|---|---|---|
| `KEELSON_TRIAGE_DRY_RUN` | `1` | `1` prints intended actions; `0` applies them. Read from the server's environment. |
| `KEELSON_TRIAGE_LIMIT` | `30` | Max open issues to fetch. |
| `KEELSON_TRIAGE_STALE_DAYS` | `30` | Age (days since last activity) at which an issue is flagged stale in the comment. |

`gh` must be authenticated (`gh auth status`); the workflow shells out to it for
every read and write.
