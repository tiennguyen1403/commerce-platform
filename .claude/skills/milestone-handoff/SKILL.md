---
name: milestone-handoff
description: Close a milestone — verify exit criteria, run review + security review, write the handoff doc, tag a release, and seed the next milestone. Use when a milestone's issues are done.
---

# Milestone handoff

Close milestone **M<n>**. See `docs/milestones/README.md`.

1. **Verify exit criteria.** Check every box in `GOAL.md` with evidence (PRs, tests, a manual click-through of the happy path). Anything unmet → finish it, or file a follow-up issue and mark it deferred.
2. **Review.** Run `/code-review` (or ultrareview for a big milestone) and the `security-review` skill over the milestone's changes — especially auth, the Stripe webhook, and tenant isolation. Resolve blocking findings.
3. **Document.** Dispatch `scribe`: write `docs/milestones/M<n>-<slug>/handoff.md`, append decisions to `docs/ARCHITECTURE.md`, update `CHANGELOG.md`, and record durable facts to memory.
4. **Release.** Open a PR `development` → `main`; when CI is green, merge it, tag `vM<n>` on `main`, and create a GitHub release with notes; close the GitHub milestone.
5. **Seed next.** Create the `M<n+1>` folder + `GOAL.md` stub, then run `/milestone-start` when ready.

Report a crisp status: what shipped, what deferred, what the next milestone inherits.
