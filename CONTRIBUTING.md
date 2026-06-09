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
Use `bun dev:server` or `bun dev:web` to run one side alone.

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

`bun run build:release` (the same script CI runs on a `v*` tag, see
`.github/workflows/release.yml`) bundles `@keelson/cli` and packs
`@keelson/shared` into `dist/release/` along with `install.sh`. To exercise the
full install path locally against those tarballs — install into a throwaway
home, then run `doctor`, `rib add`, and a single-Zod identity check:

```bash
scripts/dry-run-install.sh ../keelson-rib-chamber
```

### Cutting a release

Releases are versioned and tagged. The version lives in
`packages/shared/package.json` (and the root `package.json`); `build-release.ts`
derives the artifact version from it, and `release.yml` refuses to publish if
the pushed tag doesn't match. To cut `vX.Y.Z`:

1. Bump `version` in `package.json` and `packages/shared/package.json` to `X.Y.Z`.
2. Add a `## [X.Y.Z]` entry to `CHANGELOG.md`.
3. Land that on `main`, then tag and push:

   ```bash
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```

`release.yml` builds the CLI + shared tarballs and `install.sh`, and attaches
them to the GitHub Release. GitHub also aliases the newest release under
`/releases/latest/download/`, which is where `curl … install.sh | sh` reads.

### Update model

`install.sh` pins the home to **versioned** download URLs
(`/releases/download/vX.Y.Z/`), not `/latest/`. Because the dependency string
differs between versions, re-running a newer `install.sh` (fetched from
`/latest/download/install.sh`) rewrites the home's `@keelson/cli` +
`@keelson/shared` to the new URLs and `bun install` re-resolves them — installed
ribs are preserved (the manifest merge sets keys, never clobbering rib deps).
For now, upgrade by re-running `install.sh`; a `keelson update` command that
wraps this (and advances `github:`-sourced ribs via `bun update` against their
CI-green `main`) is the planned next step.

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
- Don't add comments that narrate the bug fix — that belongs in the PR
  description, not the source. Add a comment only when it captures
  non-obvious *why* a reader would need.

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
