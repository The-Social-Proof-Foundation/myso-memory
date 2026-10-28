import type {AgentKeyEnvelopeV1, AnyRecoveryRootWrap, CustodyMethod, RecoveryRootWrapV1} from './agent-key-envelope.js';

export type AgentRegistrationIntent = {
    label: string; capabilities: number; delegatableCaps: number; expiresAtMs: number | null; parentAgentId: string | null;
    budget: {balanceId: string; budgetMist: string | null; dailyCapMist: string | null; monthlyCapMist: string | null; requireApprovalAboveMist: string | null} | null;
};
export type AgentKeySetup = {agentId: string; intent: AgentRegistrationIntent | null; state: {vault: 'pending' | 'complete'; budget: 'pending' | 'complete' | 'skipped'}};
export type CustodyPurpose = 'unlock-agent-backups' | 'custody-unlock-zklogin-root-v1' | 'custody-unlock-recovery-code-v1' | 'custody-unlock-device-key-v1';
export type OwnerChallenge = {challenge_id: string; message: string; expires_in: number; purpose: CustodyPurpose};
export type OwnerSession = {owner_token: string; expires_in: number; owner: string; chain: string; package_id: string; vault_token?: string; vault_method?: CustodyMethod; vault_subject?: string};
export type CustodyPolicy = {allowed_methods: CustodyMethod[]; active_method: CustodyMethod | null; updated_at: string | null};
export type CustodyWrapSummary = {method: CustodyMethod; subject: string; revision: number};

export class KeyBackupError extends Error {
    constructor(readonly status: number, readonly code: string) { super(`Key backup: ${code}`); }
}
/** Tokens live only in memory; callers supply only public metadata and ciphertext. */
export class AgentKeyBackupClient {
    signal?: AbortSignal;
    onUnauthorized?: () => void;
    ownerToken = '';
    vaultToken = '';
    constructor(readonly serverUrl: string, readonly accountId: string) {}
    clear() { this.ownerToken = ''; this.vaultToken = ''; }
    async request<T>(method: string, path: string, body?: unknown, revision?: number): Promise<T> {
        const headers: Record<string, string> = {'Content-Type': 'application/json'};
        if (this.ownerToken) headers.Authorization = `Bearer ${this.ownerToken}`;
        if (this.vaultToken) headers['x-vault-token'] = this.vaultToken;
        if (revision !== undefined) headers['If-Match'] = String(revision);
        const response = await fetch(`${this.serverUrl.replace(/\/$/, '')}${path}`, {method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', signal: this.signal});
        if (!response.ok) {
            if (response.status === 401) this.onUnauthorized?.();
            const error = await response.json().catch(() => ({code: 'unavailable'}));
            throw new KeyBackupError(response.status, error.code ?? 'unavailable');
        }
        return response.json();
    }
    path(suffix: string) { return `/api/accounts/${encodeURIComponent(this.accountId)}/${suffix}`; }
    /**
     * Purpose-bound owner challenge. Non-passkey custody tiers unlock a vault by signing this
     * message, which returns a vault token bound to that method; the passkey tier ignores it.
     */
    ownerChallenge(purpose: CustodyPurpose = 'unlock-agent-backups') { return this.request<OwnerChallenge>('POST', '/api/owner/auth/challenge', {account_id: this.accountId, purpose}); }
    ownerVerify(challenge_id: string, signature: string) { return this.request<OwnerSession>('POST', '/api/owner/auth/verify', {challenge_id, signature}); }
    /** The caller's own wrap for the active vault credential/method (server resolves it). */
    getRoot<T extends AnyRecoveryRootWrap = AnyRecoveryRootWrap>() { return this.request<T>('GET', this.path('recovery-root')); }
    putRoot(wrap: AnyRecoveryRootWrap, revision = 0) { return this.request('PUT', this.path('recovery-root'), wrap, revision); }
    /** Public summaries of every wrap of this account's root (no ciphertext). */
    listRoots() { return this.request<CustodyWrapSummary[]>('GET', this.path('recovery-roots')); }
    getCustodyPolicy() { return this.request<CustodyPolicy>('GET', this.path('custody-policy')); }
    putCustodyPolicy(policy: {allowed_methods: CustodyMethod[]; active_method: CustodyMethod | null}) { return this.request('PUT', this.path('custody-policy'), policy); }
    /** v1 wraps are the passkey-PRF format; v2 wraps carry a custody method. */
    getRootV1() { return this.request<RecoveryRootWrapV1>('GET', this.path('recovery-root')); }
    list() { return this.request<AgentKeyEnvelopeV1[]>('GET', this.path('agent-key-envelopes')); }
    get(agentId: string) { return this.request<AgentKeyEnvelopeV1>('GET', this.path(`agents/${encodeURIComponent(agentId)}/key-envelope`)); }
    put(envelope: AgentKeyEnvelopeV1, revision = 0) { return this.request('PUT', this.path(`agents/${encodeURIComponent(envelope.agentId)}/key-envelope`), envelope, revision); }
    drafts() { return this.request<AgentKeyEnvelopeV1[]>('GET', this.path('agent-key-drafts')); }
    putDraft(envelope: AgentKeyEnvelopeV1, revision = 0) { return this.request('PUT', this.path(`agent-key-drafts/${encodeURIComponent(envelope.keyId)}`), envelope, revision); }
    setIntent(keyId: string, intent: AgentRegistrationIntent) { return this.request('PUT', this.path(`agent-key-drafts/${encodeURIComponent(keyId)}/intent`), intent); }
    getIntent(keyId: string) { return this.request<AgentRegistrationIntent | null>('GET', this.path(`agent-key-drafts/${encodeURIComponent(keyId)}/intent`)); }
    setups() { return this.request<AgentKeySetup[]>('GET', this.path('agent-key-setups')); }
    getSetup(agentId: string) { return this.request<AgentKeySetup>('GET', this.path(`agents/${encodeURIComponent(agentId)}/key-setup`)); }
    setSetup(agentId: string, state: AgentKeySetup['state']) { return this.request('PUT', this.path(`agents/${encodeURIComponent(agentId)}/key-setup`), state); }
    finalize(envelope: AgentKeyEnvelopeV1) { return this.request('POST', this.path(`agent-key-drafts/${encodeURIComponent(envelope.keyId)}/finalize`), envelope); }
}
