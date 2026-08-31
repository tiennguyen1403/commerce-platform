# Milestones

Each milestone is a phase of the roadmap, run through three stages. Skills drive the
stages so the process is repeatable.

```
Research  ──▶  Build  ──▶  Handoff  ──▶ (next milestone)
/milestone-start   /task (per issue)   /milestone-handoff
```

## Stage 1 — Research (`/milestone-start`)

1. `researcher` agent produces `docs/milestones/M<n>-<slug>/research.md` — relevant APIs
   (read `node_modules/next/dist/docs/` for Next 16), library choices, patterns, risks.
2. Turn research into a plan and a **task breakdown**.
3. Create the **GitHub Milestone** + **Issues** (labelled `phase:M<n>`, `type:*`, `area:*`).
4. Write/confirm `GOAL.md`: goal, in/out of scope, **exit criteria** (a checklist).

## Stage 2 — Build (`/task`, repeated)

Per issue: branch (`feat/…`) → plan → `builder` implements → `tester` adds tests →
typecheck + lint → open a PR that `Closes #<issue>`. `reviewer` reviews; CI must be green
before merge. Keep the milestone board moving.

## Stage 3 — Handoff (`/milestone-handoff`)

1. Verify every **exit criterion** in `GOAL.md`.
2. Run `/code-review` (or ultrareview) + `security-review` on the milestone's changes.
3. `scribe` writes `handoff.md`, updates the `docs/ARCHITECTURE.md` decision log, and
   records durable facts to memory.
4. Tag a **release** (`vM<n>`), close the GitHub Milestone, and seed the next one.

## Folder layout

```
docs/milestones/
├─ README.md
├─ _templates/{research.md, handoff.md}
└─ M<n>-<slug>/{GOAL.md, research.md, handoff.md}
```

## GitHub mapping

- Milestone doc ↔ **GitHub Milestone** · Task ↔ **Issue** · Work ↔ **PR** (closes issue)
- Exit criteria live in `GOAL.md` and the Milestone description.
- Trunk is `development` (feature branches → PR into it). `main` is release-only:
  release = PR `development` → `main` + tag `vM<n>`.

## Roadmap

| Milestone | Slug             | Status  |
| --------- | ---------------- | ------- |
| M0        | foundations      | ✅ done |
| M1        | commerce-slice   | ⏳ next |
| M2        | production-grade | planned |
| M3        | platform         | planned |
| M4        | fulfillment      | planned |
