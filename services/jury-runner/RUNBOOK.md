# AI Jury runbook

Operating the jury: turning it on, running it end to end locally, and what to do when a case is stuck.
Unit tests cover each piece; **nothing here has been run end to end yet**, so treat the walkthrough as the
first integration test and record what you find.

## 1. Switches (all default off)

| Switch | Where | Effect |
|---|---|---|
| `JURY_CONFIG_ID` (+ roster id, or `SOCIAL_CHAIN_AUTO_DISCOVERY`) | relayer | Advertises `jury.*` actions. Without it the SDK refuses them. |
| `JURY_AUTOMATION_ENABLED=true` | social server | Forwards jury events and crank events to the engine. |
| `JURY_CRANK_OPERATOR_ID=<account>` | social server, relayer, bridge | The platform's default crank operator: receives one event per crank, and is the only account whose jobs may use the `operator:jury` key. |
| `JURY_CRANK_SIGNER_KEY=<seed>` | bridge | The operator's wallet (a sub-agent seed of `JURY_CRANK_OPERATOR_ID`). It needs no capability: the cranks are permissionless. |
| `set_registry_jury_policy` | chain, per registry | Turns the council and community steps on. No policy means governance is unchanged. |
| `VITE_AUTOMATION_MYDATA_KEY` | chat-app | Enables creating delegates, including `juror`. |
| `RECONCILER_ENABLED=true` (+ `BRIDGE_URL`, `BRIDGE_SECRET`, `JURY_CRANK_OPERATOR_ID`) | runner | Recovery loop: runs cranks the engine left due for `RECONCILER_GRACE_MS` (15 min) through the bridge with the operator key. |

To stop everything: unset `JURY_AUTOMATION_ENABLED` (events stop; cases keep their on-chain deadlines and
anyone can still crank them) and, if needed, disable a registry's policy or call the admin pause.

## 2. Local full-chain walkthrough

1. `myso start --force-regenesis --with-indexer --with-graphql --with-social-indexer --with-social-server`.
2. Start the relayer (`JURY_CONFIG_ID`, `AUTOMATION_ENGINE_URL`, `AUTOMATION_WEBHOOK_ALLOWED_HOSTS`), the engine
   (`AUTOMATION_WEBHOOK_ALLOW_PRIVATE=1` for a local http runner), the bridge, and this runner
   (`pnpm dev:jury`; see `README.md` for its env).
3. Seed a roster of at least `min_eligible_roster` agents with `join_roster` (genesis allowlist for agents
   with no reputation yet). **There is no seeding script yet**: do it from the chat-app Jury tab or a PTB.
4. For each juror agent, create a `juror` delegate in the chat-app Automation panel, then three jobs: accept
   duty, judge (runner URL and secret), claim fee.
5. Pick an operator account, put a sub-agent seed of it in the bridge's `JURY_CRANK_SIGNER_KEY` and its id in
   `JURY_CRANK_OPERATOR_ID` (social server, relayer, bridge). From that account create one job per crank with
   key ref `operator:jury`, and set `JURY_AUTOMATION_ENABLED=true`.
6. Scenarios to run, in order:
   - task dispute to verdict (open, evidence, draw, accept, commit, reveal, finalize, execute);
   - task jury failure to the 72 hour settlement window to the 50/50 split (shorten the windows in the config);
   - governance council referral, jury, then community vote;
   - community no-quorum, finalize, escalate, jury, apply.
7. Also try: a juror that never accepts (replacement), a killed engine (cases still advance by manual crank,
   `GET /jury/cranks` lists what is due), two operators racing (the second run is skipped, not failed), an
   expired delegate (the bridge refuses it).

## 3. A stuck case

1. `GET /jury/cases/:id` for its state and deadlines.
2. `GET /jury/cranks` lists every crank due now. If the case is there, no operator ran it: check
   `JURY_CRANK_OPERATOR_ID` is set on the social server, the bridge holds `JURY_CRANK_SIGNER_KEY` with gas, and
   the engine run history for a skipped or failed run.
3. Cranks are permissionless. Anyone can run the Move entry (`select_jury`, `finalize_round`, ...) directly.
4. A case that cannot finish fails by its deadline and follows its failure path (task: settlement window then
   50/50; governance: the step's default). Admin `void_case` can only declare that failure.

## 4. Rotating a juror delegate (every 90 days at most)

The operator's crank key is not a delegate and does not expire; to rotate it, replace
`JURY_CRANK_SIGNER_KEY` and restart the bridge.

1. Create the new delegate and its jobs first.
2. Revoke the old delegate on chain (the bridge refuses it on its next request), then delete its jobs.
3. A delegate that expires with jobs still pointing at it just makes those runs fail; nothing is lost, because
   the crank events are re-sent hourly.

## 5. Watching it

Every signal below exists as a number an alert can read; nothing here needs a person to look at logs.

| What | Where | Alert when |
|---|---|---|
| Undelivered jury events | `GET /jury/health` on the social server: `oldestUnsentEventMs` | over 5 min (warn), over 30 min (critical) |
| Cranks nobody ran | `GET /jury/health`: `overdueCranks` | over 1 h late (warn), over 6 h (critical) |
| Roster too small to open disputes | `GET /jury/health?minRoster=<config value>`: `roster.active` | below `minRoster` |
| Events the engine dropped | engine `GET /health`: `event_bus.lagged`, `status: degraded` | any increase. These were acknowledged to the sender, so the outbox will not resend them. Raise `AUTOMATION_EVENT_BUS_CAPACITY` or `AUTOMATION_EVENT_CONCURRENCY`. |
| Engine backlog | engine `GET /health`: `event_bus.queued` | growing without bound |
| Juror delegate expiry | runner `/metrics`: `jury_runner_delegate_expires_in_seconds`, `jury_runner_delegate_active` | under 14 days, or `active` 0 |
| Judgments failing or abstaining | runner `/metrics`: `jury_runner_judgments_failed_total`, `..._abstained_total` | any sustained increase |
| Time spent judging | runner `/metrics`: `jury_runner_judgment_seconds_sum / _count` | well above the commit window |
| AI credit spent on judging | runner `/metrics`: `jury_runner_inference_amount_mist_total` | against the juror fee |
| Rationales not reaching the server | runner `/metrics`: `jury_runner_rationales_total{outcome="failed"}` | any sustained increase |

Switches: `METRICS_TOKEN` turns on the runner's `/metrics` (bearer-authenticated; off without it).
`MONITOR_DELEGATES=delegate:<name>@<account>,...` (with `BRIDGE_URL` and `BRIDGE_SECRET`) makes the runner ask
the bridge how long each delegate has left. A juror delegate expires within 90 days, so rotate (section 4)
well before the warning.

What keeps itself running: the operator's cranks refresh every juror's eligibility snapshot daily,
remove jurors who can no longer serve, return a closed governance case's unclaimed juror fees three days
after it ends, and return unclaimed vote refunds to the treasury after 365 days; the juror accept job re-fires on each accept reminder, so a lost "drafted" event does not lose a
seat; and revealed rationales are copied to the social server so they outlive any one runner.

## 6. Admin controls

The wallet that holds the `JuryAdminCap` gets a Jury section in the ecosystem admin dialog: the pause switch,
the five parameter groups (eligibility, timing, duty, selection, reputation), the genesis allowlist (bulk add
or remove agents in one transaction), the date the reputation exemption ends, and an emergency stop for a
stuck case (it can only fail the case, never choose an outcome). A DAO's own jury settings are edited from
its governance page by its governance admin (ecosystem) or platform developer (platform DAO).

## 7. Not built yet

Scripted delegate registration, the engine/bridge/runner smoke scripts, and paging integrations for the
alerts above. The chain is always the source of truth, so none of these block a case from finishing.

## 6. Running the cranks as a third party

Every crank is permissionless on chain, so the platform's operator is a default, not a gatekeeper. To run them
yourself: run an automation bridge with your own `JURY_CRANK_SIGNER_KEY` and `JURY_CRANK_OPERATOR_ID` (any
account and wallet with gas), then this runner with `RECONCILER_ENABLED=true`, `BRIDGE_URL`, `BRIDGE_SECRET`,
`JURY_CRANK_OPERATOR_ID` and `SOCIAL_SERVER_URL` pointing at any social server's public `GET /jury/cranks` feed.
A crank someone else ran first is a 409, counted as a conflict, not a failure.
