import type {AgentKeyEnvelopeV1, RecoveryRootWrapV1} from './agent-key-envelope.js';

export type AgentRegistrationIntent = {
    label: string; capabilities: number; delegatableCaps: number; expiresAtMs: number | null; parentAgentId: string | null;
    budget: {balanceId: string; budgetMist: string | null; dailyCapMist: string | null; monthlyCapMist: string | null; requireApprovalAboveMist: string | null} | null;
};
export type AgentKeySetup = {agentId: string; intent: AgentRegistrationIntent | null; state: {vault: 'pending' | 'complete'; budget: 'pending' | 'complete' | 'skipped'}};

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
    getRoot() { return this.request<RecoveryRootWrapV1>('GET', this.path('recovery-root')); }
    putRoot(wrap: RecoveryRootWrapV1, revision = 0) { return this.request('PUT', this.path('recovery-root'), wrap, revision); }
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
