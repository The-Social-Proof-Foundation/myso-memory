# Juror runner

Answers the automation engine's jury webhooks. A juror agent's delegate key lives in the engine and
bridge; this service holds **no keys**. It decides *what* to do, the engine and bridge sign it.

```
chain ── events ──► indexer ── outbox ──► engine ──(signed webhook)──► runner
                                            │                             │ judges with an LLM
                                            ◄──── {action_id, params} ────┘
                                            │
                                         bridge ──► relayer ──► chain  (jury.accept / commit_vote / reveal_vote / claim_fee)
```

## Why two steps

The engine waits 15 seconds for a webhook reply; judging takes longer. So the runner answers across
polls (the indexer's `duty_poll` event repeats every five minutes while a duty is open):

1. `duty_drafted` → reply `jury.accept.v1` at once.
2. `voting_started` or the first `duty_poll` (commit) → start judging in the background, reply `noop`.
3. A later commit poll → the judgment is ready → reply `jury.commit_vote.v1` with its commitment.
4. The reveal poll → reply `jury.reveal_vote.v1`, which opens exactly that commitment.
5. `fee_claimable` → reply `jury.claim_fee.v1`.

Every reply to one `delivery_id` is cached, because the engine retries a delivery under the same id.

## What keeps a case file from steering a vote

The material is written by parties with a stake in the outcome (and a proposal by anyone who paid to
submit it). So: the model has no tools and nothing it says is executed; all untrusted text is fenced
and the model is told it is data; evidence is fetched only over https from public addresses and is
shown to the model only if its bytes match the digest the chain recorded; and the only thing that
leaves `judge.ts` is a vote the validator accepts (an outcome from the case's own menu, a short
rationale, and evidence references that exist). Anything else becomes an abstention.

## Commitment

`sha3_256(bcs(case_id) ‖ bcs(round) ‖ bcs(agent_id) ‖ bcs(outcome) ‖ rationale_digest ‖ bcs(refs) ‖
bundle_digest ‖ salt)`, the same as `jury::compute_commitment`. `src/commitment.test.ts` and the Move
test `the_commitment_matches_the_reference_vector_the_runner_uses` share one reference vector. The
salt is `HMAC-SHA256(JUROR_SALT_SECRET, case ‖ round ‖ agent ‖ "salt")`, so a restart reveals the same
vote it committed.

## Running a juror

1. Register a `juror` delegate for the juror agent (zero spend limit, expiry within 90 days, allowed
   actions `jury.accept.v1`, `jury.commit_vote.v1`, `jury.reveal_vote.v1`, `jury.claim_fee.v1`).
2. Create one `webhook` job per event type (`duty_drafted`, `duty_poll`, `voting_started`,
   `fee_claimable`) with this service's public URL, `JUROR_WEBHOOK_SECRET` as its `secret`, the host in
   `allowed_hosts`, and the four actions as `allowed_action_ids`.
3. Join the roster with the agent (free; nothing is staked).

## Configuration

See `.env.example`. In production the service refuses short secrets and non-https upstreams.

## Not in this service

No signing keys, no TEE and no attestation: nothing proves which model produced a vote. The audit trail
is the commitment, the rationale digest and the bundle digest on chain.
