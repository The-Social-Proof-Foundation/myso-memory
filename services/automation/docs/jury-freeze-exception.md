# AI Jury automation — proposed second freeze exception (DRAFT)

Status: **written into `README.md` §15 (2026-10-11); the code is built and unit-tested** (engine class
map, proxy, bridge, relayer, SDK, runner). The §12 gate below is the user's to run and record before
production use; development is not blocked on it.

## Why this needs an exception

`README.md` L45–46: "Feature development on these three services is frozen until the §12
integration test passes end to end on Railway. Fixes that unblock that test are in scope; new
capabilities are not." The task market (§14) is the one existing exception, and it was conditioned
on adding a task scenario to the §12 checklist and shipping behind `AUTOMATION_ENABLED`. Neither
condition is recorded as met (`AUTOMATION_ENABLED` defaults to `true` in `src/config.rs:107` and
`.env.example:12`, and §12 has no task scenario). The jury stacks a second unproven surface on the
first, so it needs its own explicit exception rather than riding on §14.

## Proposed README §15 wording

> **§15 AI Jury automation (second declared exception).** The AI Jury (plan: `jury.move`) needs
> juror agents and a first-party keeper to act through the engine. The following are added and
> nothing else is unfrozen:
>
> - the `jury` event family (and the dispute event types added to the `task` family);
> - the `juror` and `jury_keeper` delegate classes, with `CAP_JURY` / `CAP_JURY_KEEPER`;
> - the `jury.*` registered actions and the dispute actions added to `task_worker`;
> - the proxy and bridge allow-list changes that make the class → action → family mapping
>   data-driven instead of `task`-only, and the relayer's registry bump to 1.5.0 together with
>   the SDK and the `workspace/social` mirror;
> - the relayer's 409 classification for expected jury races.
>
> Both new classes are **zero-spend** and expire within 90 days; the bridge enforces both for every
> chain-acting class. Jury jobs run with an empty `ActionPolicy` and rely on the delegate's class and
> allow-list. The feature ships dark: the social server forwards no jury event unless
> `JURY_AUTOMATION_ENABLED=true`, and the relayer only advertises `jury.*` actions when
> `JURY_CONFIG_ID` is set. Before production use, the §12 checklist below must include the jury
> scenario and be recorded as passed. This exception does not lift the freeze for anything else.

## §12 gate: what has to be recorded first (user-run)

1. Existing ladder (`README.md` L751–796) on Railway: bridge `/health`; `POST
   /internal/memory/probe` through the bridge to the relayer; engine run history with no stuck
   `running` rows; relayer → engine check from the chat-app Automation panel.
2. **Add the task scenario** that §14 required: a `task_worker` delegate registered on chain, a
   `registered_action` job reacting to a `task` event, an idempotent retry, and a 409 skip.
3. **Add the jury scenario** once the jury ships: a drafted `juror` delegate accepts, the runner
   webhook returns a commit directive within the poll-by-event pattern, the reveal lands, and a
   `jury_keeper` job advances a case.
4. Record the result (date, commit SHAs of engine/bridge/relayer/runner, who ran it) in this file.

Gate result: **not recorded.**

## Known stale items to fix with the exception

- §13 still describes delegates as memory-only (L813, L822); it must cover `task_worker`, `juror`
  and `jury_keeper`.
- §11 says "15-family registry" (L460); `docs/event_registry.json` lists 17 families.
- `scripts/smoke.ts` / `scripts/live-check.ts` contain no task or jury flow.
