---
name: task
description: The daily driver — take one GitHub issue from research to an open PR. Use to complete a single unit of work end to end.
---

# Task

Complete one issue end to end. Argument: an issue number/URL, or pick the next open issue in the current milestone.

1. **Select & understand.** `gh issue view <n>`. Restate the goal + acceptance criteria. If unclear, ask before coding.
2. **Branch.** From an up-to-date `main`: `feat/<n>-<slug>` (or `fix/`, `chore/`, `docs/`).
3. **Research (if needed).** For anything non-trivial, dispatch `researcher` first.
4. **Build.** Dispatch `builder` (or implement directly for tiny changes). Follow `CLAUDE.md` + `docs/DESIGN.md`.
5. **Test.** Dispatch `tester` for meaningful logic/flows.
6. **Verify.** `pnpm typecheck && pnpm lint && pnpm build` must pass. For DB work, use `/db-change`.
7. **Review.** Dispatch `reviewer` on the diff; fix blocking findings.
8. **PR.** Conventional-commit the work, push the branch, and `gh pr create` with a body that `Closes #<n>` and lists what changed + how it was verified. Ensure CI is green before merge.

Keep the change focused on the issue. Surface scope creep as a new issue instead of silently absorbing it.
