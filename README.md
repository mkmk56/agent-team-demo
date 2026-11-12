# agent-team-demo

A tiny multi-agent collaboration workbench running on the InstaBox cloud computer.

## What it is

A web dashboard on port 3000. Type a small JavaScript coding task and three agents work it in sequence:

1. **Planner** — breaks the task into 2–4 concrete steps and writes `plan.md`.
2. **Coder** — writes `solution.js` and `test.js`.
3. **Reviewer** — runs `node test.js` and writes a PASS/FAIL `verdict.md`.

Each run leaves its artifacts in `runs/<id>/`: `plan.md`, `solution.js`, `test.js`, `verdict.md`, `log.txt`.

Supported task templates: palindrome, reverse string, fizzbuzz, factorial, fibonacci, prime. Other tasks fail honestly — the coder writes a stub and the reviewer reports FAIL instead of pretending.

## Run it

```text
node server.js
```

Node.js standard library only, no dependencies, no build step. One run at a time; the dashboard polls `/state` every second.

## Honest limits

- The agents are scripted pipeline steps (keyword templates + real `node` execution), not model calls. The structure is a skeleton: a real model-backed coder can replace the template matcher in `server.js`.
- The machine pauses after 30 minutes idle and runs at most 2 hours per run, so the demo sleeps when idle. Wake it by visiting the link or running a command; the server must be restarted after a stop (a suspend keeps it running).
- No auth on the dashboard: the link is private only because `instabox-port publish 3000 --private` puts a token in the URL. Do not share the URL.
