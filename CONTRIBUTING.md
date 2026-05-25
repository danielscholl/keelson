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

## Required checks before opening a PR

Every PR must keep these green. CI runs the same commands.

```bash
bun --filter '*' typecheck
bun --filter '*' test
```

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

- Extensions are the only place external systems are touched. Core (under
  `apps/server`, `apps/cli`, `apps/web`, `packages/{shared,workflows,
  providers}`) must not import from `@keelson/ext-*`.
- New tools live in an extension. Don't add tool registrations to core.
- The `Extension` contract in `packages/shared/src/extension.ts` is a public
  surface — breaking changes need a deprecation cycle.

## Reporting bugs

Open an issue at https://github.com/danielscholl/keelson/issues with:

- What you ran (full command line)
- What you saw (paste any error envelope; CLI emits JSON with `--json`)
- What you expected
- `keelson doctor --json` output if a system check is relevant

## Security

For security-sensitive reports, email the maintainer directly rather than
opening a public issue. See the SECURITY notice in the repo root if present.
