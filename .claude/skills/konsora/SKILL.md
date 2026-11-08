---
name: konsora
description: Plan and track work in this project's Konsora board (.konsora/tasks.json). Use it whenever you plan tasks, pick what to work on, report progress, ask the human something, or finish a task.
---

# Konsora protocol

This project keeps its plan in `.konsora/tasks.json`. You read and change it **only through the `konsora` command or its MCP tools**: never edit that file by hand (Konsora detects and flags hand edits). Pass `--as <your-name>` on every write (e.g. `--as claude`), or set `KONSORA_AGENT`.

Run each `konsora` command on its own, not chained with `&&`, `;` or pipes: permission rules such as `Bash(konsora *)` only match single commands. A heredoc on one `konsora batch` command is fine.

## MCP tools

If this session has Konsora's MCP server (tools named like `mcp__konsora__status`), **prefer its tools over the shell commands**: they are the same operations with the same rules and errors, they need no shell quoting, and they sign your writes for you (no `--as`). Reads: `status`, `list`, `ready`, `blocked`, `show`, `check`. Writes: `propose`, `batch`, `edit`, `withdraw`, `depend`, `undepend`, `start`, `pause`, `note`, `ask`, `finish`. Without the server, use the `konsora` command as described below. The human connects the server with `konsora mcp --print-config claude` (or `codex`).

Inside a Konsora run (the server's instructions say so), the task is already started: use only `note`, `ask` and `finish` on the run's task, or `propose` follow-ups. Everything else is refused as out of scope.

## Roles

| You (agent) may | Only the human may |
|---|---|
| propose tasks (`propose`, `batch`), revise or withdraw **your proposals** (`edit`, `withdraw`, `undepend`) | approve proposals |
| `start` a **ready** task, `pause` it, add `note`s, `ask` questions | change approved tasks |
| `finish` a task with a summary (it goes to **review**) | accept work (mark it done) or send it back |

Never try to mark a task done or approve anything: there is no command for it, on purpose.

## Session flow

1. `konsora status` — what needs attention, what is ready.
2. Pick work: `konsora ready`, then `konsora show <ID>` and read the description, acceptance criteria and notes (a `feedback` note means the human sent the task back: address it).
3. `konsora start <ID> -m "<your plan>"`.
4. Work. Record progress with `konsora note <ID> "<what changed>"` at meaningful steps.
5. Blocked on a decision? `konsora ask <ID> "<question>"`, ask the human in the conversation too, then **stop** and wait.
6. Done? `konsora finish <ID> --summary "<what you did and how it meets each acceptance criterion>"` and stop for review. Stopping midway: `konsora pause <ID> -m "<why>"`.

## Planning

Propose several tasks at once (all-or-nothing; everything becomes a proposal the human must approve):

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
- Each task: an imperative title, a `desc` saying what it achieves, and acceptance criteria that can be verified.
- Estimate each task's `difficulty` (`low`, `medium` or `high`; `--difficulty` on `propose` and `edit`): Konsora runs it with the agent the project recommends for that difficulty, unless the task or the human names one.
- `konsora status` lists the groups. To use a new one, add it in the batch: `"groups": [{"id": "FE", "name": "Frontend"}]`.
- One proposal: `konsora propose "<title>" --group BE --criterion "<check>" --deps BE-01`.

## When a command fails

It prints `Error:` and usually a `Hint:` and exits non-zero. Follow the hint or ask the human. Never edit `.konsora/tasks.json` to get around a rule. Use `--json` on any command when you need machine-readable output.
