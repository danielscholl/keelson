# Contributing to Keelson

Thanks for your interest in Keelson. This document captures the conventions
and required checks for every pull request.

## Development environment

You need [Bun](https://bun.sh/) on PATH. Everything else is workspace-local.

```bash
git clone https://github.com/danielscholl/keelson.git
cd keelson
bun install
bun --filter '*' typecheck
bun --filter '*' test
bun dev
```

`bun dev` launches the server on `:7878` and the SPA on `:5173` in parallel.
Use `bun dev:server` or `bun dev:web` to run one side alone. In dev the SPA runs
under Vite (HMR) on `:5173` and proxies `/api` to `:7878`; an **installed**
`keelson service` instead serves the built SPA from the cli tarball at `:7878`
(same origin), which `scripts/build-release.ts` bundles in under `web/`. The
server resolves that directory from the bundle location; set `KEELSON_WEB_DIR`
to point it at a different built SPA.

Run the CLI from source (no install) — handy while developing:

```bash
bun apps/cli/bin/keelson.ts doctor
alias keelson="bun $(pwd)/apps/cli/bin/keelson.ts"   # optional shell alias
```

In a checkout, the keelson home resolves to the repo's `.keelson/` (it walks up
from cwd looking for an existing `.keelson/`), so dev runs read the bundled
workflows and a local DB rather than `~/.keelson`. Set `KEELSON_HOME=<dir>` to
point at a throwaway home.

### Release artifacts

`bun run build:release` (the same script CI runs when a release is cut, see
`.github/workflows/release.yml`) bundles `@keelson/cli` and packs
`@keelson/shared` into `dist/release/` along with `install.sh`. To exercise the
full install path locally against those tarballs — install into a throwaway
home, then run `doctor`, `rib add`, and a single-Zod identity check:

```bash
scripts/dry-run-install.sh ../keelson-rib-chamber
```

### Cutting a release

Releases are automated with
[release-please](https://github.com/googleapis/release-please)
(`release-please-config.json`). Conventional commits landing on `main`
accumulate into a rolling release PR that bumps `version` in the root and
every workspace `package.json`, refreshes `bun.lock`, and writes the
`CHANGELOG.md` entry from the commit subjects. Merging that PR tags `vX.Y.Z`
and creates the GitHub Release — its body is what `keelson update` shows as
the release notes — and `release.yml` then builds the CLI + shared tarballs
and the installers and attaches them.

Commit types drive the version while pre-1.0: `fix:` bumps patch, `feat:`
bumps minor, and a breaking change (`!` or `BREAKING CHANGE:`) also bumps
minor, not major. Commit subjects become changelog lines — write them for the
release reader.

GitHub aliases the newest release under `/releases/latest/download/`, which is
where `curl … install.sh | sh` reads.

### Update model

`install.sh` pins the home to **versioned** download URLs
(`/releases/download/vX.Y.Z/`), not `/latest/`. Because the dependency string
differs between versions, re-running a newer `install.sh` (fetched from
`/latest/download/install.sh`) rewrites the home's `@keelson/cli` +
`@keelson/shared` to the new URLs and `bun install` re-resolves them — installed
ribs are preserved (the manifest merge sets keys, never clobbering rib deps).
`keelson update` wraps this: it resolves the latest release, re-pins the home's
`@keelson/cli` + `@keelson/shared` to that version's asset URLs, `bun install`s,
and `bun update`s `github:`-sourced ribs to their latest CI-green `main`.
Re-running `install.sh` does the same cli/shared upgrade (but leaves ribs at
their locked commits).

## Required checks before opening a PR

Every PR must keep these green. CI runs the same commands.

```bash
bun run check               # Biome lint + format check
bun --filter '*' typecheck
bun --filter '*' test
bun --filter '*' build
```

Run `bun run check:fix` to auto-fix the safe lint/format issues, or
`bun run format` to apply formatting only.

If you touched the workflow engine, also run a smoke pass:

```bash
bun apps/cli/bin/keelson.ts workflow validate smoke-test
bun apps/cli/bin/keelson.ts workflow run smoke-test --provider stub
```

If you touched a contract under `packages/shared/src/`, run the conformance
tests explicitly to surface schema drift:

```bash
bun --filter @keelson/shared test
```

## Commit messages

Conventional commit format (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`,
`test:`). One sentence in the subject (under 70 characters). Body — when
needed — explains *why*, not *what*; the diff already shows the what.

## Pull request hygiene

- Keep PRs scoped to one thing. Split refactors out of feature work.
- The PR description should answer: what changed, why now, how it was tested.
- Don't add new abstractions ahead of a concrete second caller.
- Keep narration out of source — see [Comments](#comments). "What changed and
  why" belongs in the PR description, not a code comment.

## Comments

Comments live in source long after the PR that motivated them merges. Default to
**none** — add one only when it captures a non-obvious *why* a future reader
needs: a hidden constraint, a workaround for a specific bug, a non-obvious order
dependency, or an invariant that lives in another module. A well-named
identifier already says *what*; a comment that restates the next line is noise.

Do **not** write:

- **Milestone or issue shorthand** — `#123`, `Slice 4`, `M7`, `C1`, `Tier-0`,
  `Phase 4.5`, "later milestone", "follow-up slice". This is the most common
  drift we clean up: point-in-time narration that goes stale the moment the
  milestone ships. If the *why* is real, keep the sentence and drop the token.
- **What-just-changed notes** — "no longer drives fetching", "renamed from…",
  "per CodeRabbit review", "addresses the review comment". That belongs in the
  commit message or PR description.
- **Verbose narration** — multi-paragraph blocks or bulleted `/* */`
  explanations. A single sentence soft-wrapped over two lines is fine; the rule
  targets the narration, not the line count.

Do keep the rare single line that captures load-bearing intent the code can't
express — an invariant another module depends on, or a workaround for a specific
bug (link it).

This section is authoritative. `CLAUDE.md` mirrors it for agents, and
`.coderabbit.yaml` disables the docstring-coverage check to keep the policy
consistent — don't re-enable it.

## Architecture rules

- Ribs are the only place external systems are touched. Core (under
  `apps/server`, `apps/cli`, `apps/web`, `packages/{shared,workflows,
  providers,skills}`) must not import from `@keelson/rib-*`.
- New tools live in a rib. Don't add tool registrations to core.
- The `Rib` contract in `packages/shared/src/rib.ts` is a public surface —
  breaking changes need a deprecation cycle.

## Reporting bugs

Open an issue at https://github.com/danielscholl/keelson/issues with:

- What you ran (full command line)
- What you saw (paste any error envelope; CLI emits JSON with `--json`)
- What you expected
- `keelson doctor --json` output if a system check is relevant

## Security

For security-sensitive reports, see [SECURITY.md](SECURITY.md). Please do
not file public GitHub issues for vulnerabilities.
