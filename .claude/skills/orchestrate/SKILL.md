---
name: orchestrate
description: Coordinate the specialist agents (researcher, builder, tester, reviewer, scribe) to complete a task or milestone. The main session is the central orchestrator. Use whenever a piece of work needs more than one step or role.
---

# Orchestrate

You (the main session) are the **central orchestrator**. There is no background "manager" agent — you hold the plan, delegate to specialist subagents via the Agent tool, keep context across steps, and make the calls between them.

## Roles

- `researcher` (read-only) → understand + brief
- `builder` → implement
- `tester` → tests
- `reviewer` → review (reports only)
- `scribe` → docs / handoff / memory

## Default flow for a task

1. **Plan** — restate the goal + acceptance criteria. For anything non-trivial, dispatch `researcher` first.
2. **Build** — dispatch `builder` with the plan and relevant research. Keep scope tight.
3. **Test** — dispatch `tester` for critical logic/flows.
4. **Review** — dispatch `reviewer` on the diff; address blocking findings (loop back to `builder`).
5. **Record** — dispatch `scribe` if docs/decisions/memory need updating.

## Rules

- Run independent subagents in parallel; sequence dependent ones. Never fabricate a pending agent's result — wait for it.
- Relay only what matters from each agent (their full output is not shown to the user).
- Keep the human in the loop at forks: if agents surface an architectural decision, stop and ask.
- For large, well-defined parallel build-outs, consider the **Workflow tool** (requires explicit user opt-in).
- Respect the golden rules in `CLAUDE.md` at every step; never bypass the PR/CI flow on `main`.
