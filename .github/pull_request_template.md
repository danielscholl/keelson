<!--
Title must be a conventional commit — it becomes the squash commit that
release-please reads to build the CHANGELOG and pick the version bump.
  <type>[(scope)][!]: <subject>   (subject one sentence, under ~70 chars)
  types: feat fix perf refactor docs chore style test build ci revert
  e.g.  fix(web): show cost badge in light mode
-->

## What

<!-- The functional change in 1–3 sentences. The diff shows the what; group by
behavior, not file. Name the issue/slice if there is one. -->

## Why now

<!-- The motivation: what this fixes or unblocks, and what drove the timing. -->

## Test plan

<!-- A record of what you actually ran and the result (counts, "green") — not a
checklist of intent. -->

- [ ] `bun run check`
- [ ] `bun --filter '*' typecheck`
- [ ] `bun --filter '*' test`

<!-- Closes #
Keep the PR scoped to one thing; split refactors out of feature work. -->
