
### Profile subscription owner actions (registry 1.8)

`ptb/subscription.ts` provides typed subscribe, renew, cancel and renewal-preference
builders. Registry 1.8 includes all five actions with nested exact-term schemas.
The memory service supplies typed fullnode quotes, renewal quotes, plan and
owned-subscription lists, and scoped native-event receipts. MCP exposes the
actions through exact-input owner approvals. `SUBSCRIPTION_ACTIONS_ENABLED`
defaults to false; source coverage is not deployed readiness.

Deploy the matching native `subscription::assert_plan_terms`,
`assert_subscription_terms` and `set_auto_renew` extensions before using the
builders. Plan guards pin seller, plan, coin type, price, duration, tier and
platform. Renewal additionally binds the quote to the subscription's actual
plan. Native renewal distributes the entire coin passed to it, so its builder
splits exactly `priceBaseUnits`. Subscribe splits the initial period plus the
explicit prepaid renewal count and consumes the resulting zero coin. The
original funding coin retains its unused balance. No amount is assumed to be
MIST unless its coin type is MYSO.

The new renewal toggle changes only the subscriber's preference and emits an
event. It does not fund the renewal bag or change expiry. Disabling remains
possible for an inactive service or blocked creator. Enabling checks the
existing service/block/coin rules; future automatic renewals retain their native
live-plan semantics and can spend only the existing prepaid bag. A new per-period
spend policy is not implemented by this toggle.

Coin type parsing is bounded to 512 characters and 8 levels of nesting and
accepts complete struct tags, including generic coin types. Numeric quantities
are exact decimal u64 strings. Source-only regressions compile; no transaction,
key request, runtime or test was executed by this implementation.

Configure `SUBSCRIPTION_CONFIG_ID` and existing treasury/bootstrap IDs, deploy the
matching native extensions and apply server migration
`018_chain_action_receipt_context.sql` before enabling writes. Read discovery
requires the authenticated trade capability and configured subscription ID; writes
also require the explicit rollout flag. Profile subscriptions belong to the
approving owner wallet, not automatically its agents or organization. Renewal
quotes distinguish current payment terms from the subscription's retained
original tier/platform. Cancellation receipts require actual object deletion.

Upgrade SDK, server, sidecar and MCP together. Older supported requests retain
their negotiated registry version. Pending operations must retain their original
input, key and version; reconcile existing effects before creating a new key.
Cross-upgrade recovery is not automatically implemented.


### Exact owner-wallet token transfers (registry 1.9)

`payments_send_token` (`payments:write`) requests an exact-input wallet approval.
It splits exactly `amountBaseUnits` from the named owned `Coin<T>` and transfers
that new coin to the named recipient. Unused funding stays in the original coin.
An explicit bounded coin type and positive decimal u64 amount are required; there
is no implicit MIST conversion, arbitrary Move target, coin merge or self-transfer.
The native chain still enforces transferability/deny-list rules during simulation
and execution. This action does not grant an agent an autonomous wallet allowance.

`payments:read` exposes `payments_list_coins`, `payments_get_balance`,
`payments_get_transfer_quote`, and `payments_get_transfer_receipt`. Caller identity,
platform, endpoint and RPC methods are fixed by the authenticated deployment.
Funding reads describe the approving wallet, not agent or organization treasuries.
Coin cursors retain the native order and exact u64 values, are currency-bound and
bounded, and advance over excluded address-balance reservation placeholders.
Balance totals are decimal u128 strings and include the separately reported
`fundsInAddressBalance`; never add that subset to the total. This transfer path
uses owned coin objects and cannot spend a synthetic address-balance entry.
Quotes verify the owned coin/type/balance but do not reserve funds.

Transfer receipts are scoped to the recorded account/agent/platform preparation.
They verify the unique created `Coin<T>` and fetch its exact historical effect
version, checking owner, amount, currency, digest and previous transaction. Net
recipient balance changes alone are insufficient when the recipient is also the
gas sponsor. A pruned/missing version fails closed for reconciliation; the reader
never substitutes the latest coin state. Checkpointed success differs from
execution, current ownership and task settlement. Signed service responses use
`Cache-Control: private, no-store` without replacing CORS Vary headers.

Apply migration 018 and deploy matching SDK/server/sidecar/MCP sources together.
Authorize `payments:read` / `payments:write` plus the existing generic approval/
signing scopes. Writes require CAP_TRADE_EXECUTE, explicit live advertisement and
`TOKEN_TRANSFERS_ENABLED=true`; the flag defaults to false. No new Move entry point
is required. Registry 1.9 is required for this action; subscriptions retain 1.8+
compatibility, owner MyData actions 1.7+, purchases 1.6+, and legacy actions 1.5+.
Keep original inputs/keys/versions for in-flight operations and reconcile before
issuing another key. Owner approval UI, delegated wallet allowances, per-run
budgets and profile/post tipping remain separate work.

Source and regressions were compiled only. No wallet approval, simulation,
transaction, service, migration or test was executed by the coding agent.
