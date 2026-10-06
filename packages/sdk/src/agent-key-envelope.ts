/** Client-only key backups. No secret from this module is an API payload. */
import { bcs } from '@socialproof/bcs';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { blake2b } from '@noble/hashes/blake2.js';
import * as ed from '@noble/ed25519';
import type {AgentRegistrationIntent} from './agent-key-backup-client.js';

export const KEY_BACKUP_VERSION = 1 as const;
export type KeyBinding = {
    chain: string; packageId: string; owner: string; accountId: string;
    rootId: string; keyId: string; organizationId: string; agentId: string;
    publicKey: string; derivedAddress: string; revision: number; intentHash?: string; registrationIntent?: AgentRegistrationIntent | null;
};
export type AgentKeyEnvelopeV1 = KeyBinding & {
    version: 1; algorithm: 'AES-256-GCM'; kdf: 'HKDF-SHA256';
    kind: 'agent' | 'draft'; signingScheme: 'Ed25519'; intentHash: string; registrationIntent: AgentRegistrationIntent | null; salt: string; nonce: string; ciphertext: string;
};
export type RecoveryRootWrapV1 = {
    version: 1; algorithm: 'AES-256-GCM'; kdf: 'HKDF-SHA256';
    chain: string; packageId: string; owner: string; accountId: string;
    rootId: string; credentialId: string; rpId: string; prfInput: string;
    revision: number; salt: string; nonce: string; ciphertext: string;
};
export type UnlockedAgentKey = {
    seed: Uint8Array; publicKey: Uint8Array; address: string;
};
const Address = bcs.fixedArray(32, bcs.u8());
const AgentAAD = bcs.struct('AgentKeyEnvelopeV1', {
    domain: bcs.string(), version: bcs.u8(), algorithm: bcs.string(), kdf: bcs.string(),
    signingScheme: bcs.string(),
    chain: bcs.string(), packageId: Address, owner: Address, accountId: Address,
    rootId: bcs.string(), keyId: bcs.string(), organizationId: Address, agentId: Address,
    publicKey: Address, derivedAddress: Address, intentHash: Address, revision: bcs.u32(), salt: Address,
});
const RootAAD = bcs.struct('RecoveryRootWrapV1', {
    domain: bcs.string(), version: bcs.u8(), algorithm: bcs.string(), kdf: bcs.string(),
    chain: bcs.string(), packageId: Address, owner: Address, accountId: Address,
    rootId: bcs.string(), credentialId: bcs.string(), rpId: bcs.string(),
    prfInput: Address, revision: bcs.u32(), salt: Address,
});
export function normalizeKeyAddress(value: string): string {
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(value)) throw new Error('Invalid address');
    return `0x${value.slice(2).toLowerCase().padStart(64, '0')}`;
}
function address(value: string): number[] {
    return Array.from(unhex(normalizeKeyAddress(value).slice(2)));
}
function unhex(value: string): Uint8Array {
    if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('Invalid public key');
    return Uint8Array.from(value.match(/../g)!, v => parseInt(v, 16));
}
export function keyHex(value: Uint8Array): string {
    return Array.from(value, b => b.toString(16).padStart(2, '0')).join('');
}
export function base64url(value: Uint8Array): string {
    return btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromBase64url(value: string, length?: number): Uint8Array {
    if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 32768) throw new Error('Invalid base64url');
    const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    if (base64url(bytes) !== value || (length !== undefined && bytes.length !== length)) throw new Error('Invalid encoded length');
    return bytes;
}
export function randomKey(): Uint8Array { return crypto.getRandomValues(new Uint8Array(32)); }
function validate(value: {version: number; algorithm: string; kdf: string; revision: number}) {
    if (value.version !== 1 || value.algorithm !== 'AES-256-GCM' || value.kdf !== 'HKDF-SHA256') throw new Error('Unsupported envelope version');
    if (!Number.isInteger(value.revision) || value.revision < 1 || value.revision > 0xffffffff) throw new Error('Invalid revision');
}
export function agentEnvelopeAAD(e: AgentKeyEnvelopeV1): Uint8Array {
    validate(e);
    if (e.registrationIntent !== null && agentRegistrationIntentHash(e.registrationIntent) !== e.intentHash) throw new Error('Registration intent binding mismatch');
    if (e.registrationIntent === null && e.intentHash !== '0'.repeat(64)) throw new Error('Registration intent is missing');
    if (e.signingScheme !== 'Ed25519') throw new Error('Unsupported signing scheme');
    if (!['agent', 'draft'].includes(e.kind)) throw new Error('Invalid envelope kind');
    return AgentAAD.serialize({ ...e, domain: e.kind === 'agent' ? 'mysocial:agent-key-envelope:v1' : 'mysocial:agent-draft-envelope:v1',
        packageId: address(e.packageId), owner: address(e.owner), accountId: address(e.accountId),
        organizationId: address(e.organizationId), agentId: address(e.agentId),
        publicKey: Array.from(unhex(e.publicKey)), derivedAddress: address(e.derivedAddress), intentHash: Array.from(unhex(e.intentHash)),
        salt: Array.from(fromBase64url(e.salt, 32)),
    }).toBytes();
}
export function rootWrapAAD(e: RecoveryRootWrapV1): Uint8Array {
    validate(e);
    return RootAAD.serialize({ ...e, domain: 'mysocial:agent-root-wrap:v1',
        packageId: address(e.packageId), owner: address(e.owner), accountId: address(e.accountId),
        prfInput: Array.from(fromBase64url(e.prfInput, 32)), salt: Array.from(fromBase64url(e.salt, 32)),
    }).toBytes();
}
async function crypt(secret: Uint8Array, salt: string, aad: Uint8Array, nonce: string, data: Uint8Array, decrypt: boolean) {
    if (secret.length !== 32) throw new Error('Expected a 32-byte client secret');
    // AAD contains the domain and all identity fields, so derivation cannot cross identities.
    const derived = hkdf(sha256, secret, fromBase64url(salt, 32), aad, 32);
    try {
        const key = await crypto.subtle.importKey('raw', derived as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
        const params = { name: 'AES-GCM', iv: fromBase64url(nonce, 12) as BufferSource, additionalData: aad as BufferSource, tagLength: 128 };
        return new Uint8Array(await crypto.subtle[decrypt ? 'decrypt' : 'encrypt'](params, key, data as BufferSource));
    } finally { derived.fill(0); }
}
export async function generateAgentKey(): Promise<UnlockedAgentKey> {
    const seed = randomKey();
    return agentKeyFromSeed(seed);
}
export async function agentKeyFromSeed(seed: Uint8Array): Promise<UnlockedAgentKey> {
    if (seed.length !== 32) throw new Error('Invalid agent seed');
    const publicKey = await ed.getPublicKeyAsync(seed);
    const addressBytes = blake2b(new Uint8Array([0, ...publicKey]), { dkLen: 32 });
    return { seed, publicKey, address: `0x${keyHex(addressBytes)}` };
}
export async function encryptAgentKey(root: Uint8Array, seed: Uint8Array, binding: KeyBinding, kind: 'agent' | 'draft' = 'agent'): Promise<AgentKeyEnvelopeV1> {
    const key = await agentKeyFromSeed(seed);
    if (keyHex(key.publicKey) !== binding.publicKey || key.address !== normalizeKeyAddress(binding.derivedAddress)) throw new Error('Agent key binding mismatch');
    const envelope: AgentKeyEnvelopeV1 = { ...binding, version: 1, algorithm: 'AES-256-GCM', kdf: 'HKDF-SHA256', kind, signingScheme: 'Ed25519', intentHash: binding.intentHash ?? '0'.repeat(64), registrationIntent: binding.registrationIntent ?? null,
        salt: base64url(randomKey()), nonce: base64url(crypto.getRandomValues(new Uint8Array(12))), ciphertext: '' };
    envelope.ciphertext = base64url(await crypt(root, envelope.salt, agentEnvelopeAAD(envelope), envelope.nonce, seed, false));
    return envelope;
}
export async function decryptAgentKey(root: Uint8Array, e: AgentKeyEnvelopeV1): Promise<UnlockedAgentKey> {
    const seed = await crypt(root, e.salt, agentEnvelopeAAD(e), e.nonce, fromBase64url(e.ciphertext, 48), true);
    try {
        const key = await agentKeyFromSeed(seed);
        if (keyHex(key.publicKey) !== e.publicKey || key.address !== normalizeKeyAddress(e.derivedAddress)) throw new Error('Decrypted key binding mismatch');
        return key;
    } catch (err) { seed.fill(0); throw err; }
}
export async function wrapRecoveryRoot(prf: Uint8Array, root: Uint8Array, binding: Omit<RecoveryRootWrapV1, 'version' | 'algorithm' | 'kdf' | 'salt' | 'nonce' | 'ciphertext'>): Promise<RecoveryRootWrapV1> {
    if (root.length !== 32) throw new Error('Invalid recovery root');
    const wrap: RecoveryRootWrapV1 = { ...binding, version: 1, algorithm: 'AES-256-GCM', kdf: 'HKDF-SHA256', salt: base64url(randomKey()), nonce: base64url(crypto.getRandomValues(new Uint8Array(12))), ciphertext: '' };
    wrap.ciphertext = base64url(await crypt(prf, wrap.salt, rootWrapAAD(wrap), wrap.nonce, root, false));
    return wrap;
}
export async function unwrapRecoveryRoot(prf: Uint8Array, wrap: RecoveryRootWrapV1): Promise<Uint8Array> {
    return crypt(prf, wrap.salt, rootWrapAAD(wrap), wrap.nonce, fromBase64url(wrap.ciphertext, 48), true);
}

const IntentBudget = bcs.struct('AgentIntentBudget', {balanceId: Address, budgetMist: bcs.option(bcs.u64()), dailyCapMist: bcs.option(bcs.u64()), monthlyCapMist: bcs.option(bcs.u64()), requireApprovalAboveMist: bcs.option(bcs.u64())});
const Intent = bcs.struct('AgentRegistrationIntentV1', {domain: bcs.string(), label: bcs.string(), capabilities: bcs.u64(), delegatableCaps: bcs.u64(), expiresAtMs: bcs.option(bcs.u64()), parentAgentId: bcs.option(Address), budget: bcs.option(IntentBudget)});
/** Bind resumable public registration/budget choices to the encrypted signing seed. */
export function agentRegistrationIntentHash(intent: AgentRegistrationIntent): string {
    const bytes=Intent.serialize({...intent,domain:'mysocial:agent-registration-intent:v1',
        parentAgentId:intent.parentAgentId===null?null:address(intent.parentAgentId),
        budget:intent.budget===null?null:{...intent.budget,balanceId:address(intent.budget.balanceId)},
    }).toBytes();
    return keyHex(sha256(bytes));
}
