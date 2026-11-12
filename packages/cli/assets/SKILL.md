---
name: konsora
description: Plan and track work in this project's Konsora board (.konsora/tasks.json). Use it whenever you plan tasks, pick what to work on, report progress, ask the human something, or finish a task.
---

# Konsora protocol

This project keeps its plan in `.konsora/tasks.json`. You read and change it **only through the `konsora` command or its MCP tools**: never edit that file by hand (Konsora detects and flags hand edits). Pass `--as <your-name>` on every write (e.g. `--as claude`), or set `KONSORA_AGENT`.

Run each `konsora` command on its own, not chained with `&&`, `;` or pipes: permission rules such as `Bash(konsora *)` only match single commands. A heredoc on one `konsora batch` command is fine.

## MCP tools

If this session has Konsora's MCP server (tools named like `mcp__konsora__status`), **prefer its tools over the shell commands**: they are the same operations with the same rules and errors, they need no shell quoting, and they sign your writes for you (no `--as`). Reads: `status`, `list`, `ready`, `blocked`, `show`, `check`. Writes: `propose`, `batch`, `edit`, `delete`, `promote`, `depend`, `undepend`, `add_block`, `edit_block`, `set_block`, `start`, `pause`, `note`, `ask`, `finish`. Without the server, use the `konsora` command as described below. `konsora init` (or `konsora skill`) adds the server to the project's `.mcp.json`.

In a planning session (`konsora plan` or the AI panel of the Konsora UI; the server's instructions say so), interview the human, then create the tasks with `batch`; you may only create, revise or delete tasks nobody started and set up blocks, and nothing is started.

## States and roles

Tasks go `todo → doing → done`. There is **no approval and no review**: what you create is ready to work on, and `finish` marks it done. `proposed` holds loose **ideas**; anyone can `promote` an idea to `todo`.

| You (agent) may | Only the human may |
|---|---|
| create tasks (`propose`, `batch`) and blocks (`add-block`), promote ideas | reopen a done task, change or delete finished work |
| `edit`, `depend`/`undepend`, `set-block` tasks that are not done; `delete` tasks nobody started | delete started work, delete a block |
| `start` a **ready** task, `pause` it, add `note`s, `ask` questions, `finish` it | answer questions, **merge a block** into its base branch |

## Blocks: one branch for dependent tasks

A **block** groups tasks that should land together. All its tasks are worked on **one git branch** (`konsora/<id>` by default), and when the last one is done the human merges the branch into its base from the Konsora UI. Tasks outside any block are worked on wherever you normally work.

- When you `start` a task of a block, Konsora tells you its branch. Switch to it (`git switch <branch>`, or `git switch -c <branch> <base>` the first time) and commit your work there.
- Leave `.konsora/tasks.json` out of those commits: Konsora keeps it up to date in the working tree.
- Never merge, rebase or push the block's branch yourself: merging is the human's.

## Session flow

1. `konsora status`: what is waiting for an answer, what is in progress, what is ready, and the blocks.
2. Pick work: `konsora ready`, then `konsora show <ID>` and read the description, acceptance criteria and notes.
3. `konsora start <ID> -m "<your plan>"`. If it is in a block, switch to the block's branch.
4. Work. Record progress with `konsora note <ID> "<what changed>"` at meaningful steps.
5. Blocked on a decision? `konsora ask <ID> "<question>"`, ask the human in the conversation too, then **stop** and wait.
6. Done? Commit your work, then `konsora finish <ID> --summary "<what you did and how it meets each acceptance criterion>"`. Stopping midway: `konsora pause <ID> -m "<why>"`.

## Planning

Create several tasks at once (all-or-nothing; they go straight to `todo`):

```bash
konsora batch --as claude <<'JSON'
{"blocks": [{"id": "cache", "name": "Forecast cache"}],
 "tasks": [
  {"title": "Add forecast cache", "group": "BE", "desc": "What it achieves and why.",
   "acceptance": ["A repeated request within 10 min does not hit upstream"], "block": "cache"},
  {"title": "Show cache age in the UI", "group": "FE", "deps": ["Add forecast cache"], "block": "cache"}
]}
JSON
```

- `deps` take task ids or titles of **earlier** tasks in the same batch.
- A task with `"idea": true` is created as an idea (`proposed`) instead of in `todo`: use it for loose ideas the human has not committed to.
- A block in `blocks` takes `id` and `name`; `branch` defaults to `konsora/<id>` and `base` to the current git branch. Use a block when several dependent tasks should be merged together; a lone task needs none.
- If `konsora status` lists templates that fit, start from one with `"template": "<id>"` (or `--template <id>`): the task takes its description, criteria and labels, and what you pass completes or replaces them.
- Each task: an imperative title, a `desc` saying what it achieves, and acceptance criteria that can be verified.
- Keep each task small enough for one working session; split bigger work into tasks with `deps`.
- `konsora status` lists the groups. To use a new one, add it in the batch: `"groups": [{"id": "FE", "name": "Frontend"}]`.
- One task: `konsora propose "<title>" --group BE --criterion "<check>" --deps BE-01 [--block cache]`. An idea for later: `konsora propose "<title>" --group BE --idea`.

## When a command fails

It prints `Error:` and usually a `Hint:` and exits non-zero. Follow the hint or ask the human. Never edit `.konsora/tasks.json` to get around a rule. Use `--json` on any command when you need machine-readable output.
