---
name: konsora
description: Plan and track work in this project's Konsora board (.konsora/tasks.json). Use it whenever you plan tasks, pick what to work on, report progress, ask the human something, or finish a task.
---

# Konsora protocol

This project keeps its plan in `.konsora/tasks.json`. You read and change it **only through the `konsora` command or its MCP tools**: never edit that file by hand (Konsora detects and flags hand edits). Pass `--as <your-name>` on every write (e.g. `--as claude`), or set `KONSORA_AGENT`.

Run each `konsora` command on its own, not chained with `&&`, `;` or pipes: permission rules such as `Bash(konsora *)` only match single commands. A heredoc on one `konsora batch` command is fine.

## MCP tools

If this session has Konsora's MCP server (tools named like `mcp__konsora__status`), **prefer its tools over the shell commands**: they are the same operations with the same rules and errors, they need no shell quoting, and they sign your writes for you (no `--as`). Reads: `status`, `list`, `ready`, `blocked`, `show`, `check`. Writes: `propose`, `batch`, `edit`, `move`, `delete`, `promote`, `demote`, `depend`, `undepend`, `start`, `pause`, `note`, `ask`, `finish`, and `add_group`, `rename_group`, `remove_group` for groups and `add_milestone`, `edit_milestone`, `remove_milestone` for milestones. Without the server, use the `konsora` command as described below. `konsora init` (or `konsora skill`) adds the server to the project's `.mcp.json`.

In a planning session (`konsora plan` or the AI panel of the Konsora UI; the server's instructions say so), interview the human, then create the tasks with `batch`; you may only create, revise or delete tasks nobody started, and nothing is started.

## States and roles

Tasks go `todo → doing → done`. There is **no approval and no review**: what you create is ready to work on, and `finish` marks it done. `proposed` holds loose **ideas**; anyone can `promote` an idea to `todo`, or `demote` a `todo` task nobody started back to an idea.

| You (agent) may | Only the human may |
|---|---|
| create tasks (`propose`, `batch`), promote ideas | reopen a done task, change or delete finished work |
| `edit`, `depend`/`undepend` tasks that are not done; `delete` tasks nobody started | delete started work |
| `start` a **ready** task, `pause` it, add `note`s, `ask` questions, `finish` it | answer questions |

## Session flow

1. `konsora status`: what is waiting for an answer, what is in progress and what is ready.
2. Pick work: `konsora ready`, then `konsora show <ID>` and read the description, acceptance criteria and notes.
3. `konsora start <ID> -m "<your plan>"`.
4. Work. Record progress with `konsora note <ID> "<what changed>"` at meaningful steps.
5. Blocked on a decision? `konsora ask <ID> "<question>"`, ask the human in the conversation too, then **stop** and wait. When the decision is a choice, offer the answers with `--option "<A>" --option "<B>"` (`options` in the MCP tool): the human picks one with a click.
6. Done? Commit your work, then `konsora finish <ID> --summary "<what you did and how it meets each acceptance criterion>"`, with the evidence for each criterion: `--evidence ac1="<command that passes or result>"` (repeat per criterion; `--unmet ac2="<why>"` for one you could not meet; `evidence` in the MCP tool). The human sees it next to each criterion. Stopping midway: `konsora pause <ID> -m "<why>"`.

## Planning

Create several tasks at once (all-or-nothing; they go straight to `todo`):

```bash
konsora batch --as claude <<'JSON'
{"tasks": [
  {"title": "Add forecast cache", "group": "BE", "desc": "What it achieves and why.",
   "acceptance": ["A repeated request within 10 min does not hit upstream"], "difficulty": "medium"},
  {"title": "Show cache age in the UI", "group": "FE", "deps": ["Add forecast cache"]}
]}
JSON
```

- `deps` take task ids or titles of **earlier** tasks in the same batch.
- A task with `"idea": true` is created as an idea (`proposed`) instead of in `todo`: use it for loose ideas the human has not committed to.
- If `konsora status` lists templates that fit, start from one with `"template": "<id>"` (or `--template <id>`): the task takes its description, criteria and labels, and what you pass completes or replaces them.
- Each task: an imperative title, a `desc` saying what it achieves, acceptance criteria that can be verified, and a `difficulty` you estimate: `low` (mechanical, a few files), `medium` (a feature within one area) or `high` (cross-cutting, design decisions or risky). `--difficulty` in `propose` and `edit`.
- Keep each task small enough for one working session; split bigger work into tasks with `deps`.
- `konsora status` lists the groups. To use a new one, add it in the batch: `"groups": [{"id": "FE", "name": "Frontend"}]`, or with `konsora group add FE Frontend`. `konsora group rename` and `konsora group remove` (only a group no task uses) manage them.
- One task: `konsora propose "<title>" --group BE --criterion "<check>" --deps BE-01`. An idea for later: `konsora propose "<title>" --group BE --idea`.
- Milestones group tasks into a goal with its progress (`konsora status` lists them). Put a task in one with `"milestone": "<id>"` in the batch, `--milestone <id>` in `propose` and `edit` (`none` takes it out); `konsora milestone add <id> "<name>" --criterion "<when it is done>"` creates one.
- Priority is the order of the tasks: `konsora ready` lists what to take first. Reorder with `konsora move <ID> --before <ID>`, `--after <ID>` or `--top`.

## When a command fails

It prints `Error:` and usually a `Hint:` and exits non-zero. Follow the hint or ask the human. Never edit `.konsora/tasks.json` to get around a rule. Use `--json` on any command when you need machine-readable output.
