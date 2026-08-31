---
name: milestone-start
description: Begin a milestone — run research, produce a plan and task breakdown, and create the GitHub milestone + issues. Use at the start of each phase (M1, M2, ...).
---

# Milestone start

Kick off milestone **M<n>**. See `docs/milestones/README.md`.

1. **Confirm the goal.** Read/write `docs/milestones/M<n>-<slug>/GOAL.md` (goal, in/out of scope, exit criteria). Align with the human if scope is unclear.
2. **Research.** Dispatch the `researcher` agent → write `docs/milestones/M<n>-<slug>/research.md` (template in `_templates/`). Cover Next 16 specifics, Stripe/Better Auth/Prisma APIs at the _installed_ versions, patterns to follow, and risks.
3. **Plan → tasks.** Break the milestone into small, shippable issues (each ≈ one PR). Sequence them; note dependencies.
4. **Create on GitHub** (via `gh`):
   - Ensure the **milestone** exists (`gh api repos/{owner}/{repo}/milestones`; create if missing).
   - Create **issues** for each task with labels `phase:M<n>`, `type:*`, `area:*`, assigned to the milestone.
5. **Confirm exit criteria** in `GOAL.md` and the milestone description.
6. Summarize the plan and name the first issue to pick up with `/task`.

Do not start building here — this stage produces the brief, the plan, and the issues.
