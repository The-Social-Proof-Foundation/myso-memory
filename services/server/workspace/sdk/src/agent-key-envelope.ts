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

/* ------------------------------------------------------------------------------------------------
 * Custody tiers (root wrap v2)
 *
 * One random recovery root per account encrypts every agent envelope. The root is stored only as
 * one or more independently encrypted wraps, each bound to a custody method. Any wrap of the same
 * rootId unlocks the same agents, so adding or removing a method never re-encrypts an envelope and
 * never changes an agent identity. Agent seeds and the root are always random: no tier derives key
 * material from a credential.
 * ---------------------------------------------------------------------------------------------- */

export const ROOT_WRAP_VERSION = 2 as const;
export const CUSTODY_METHODS = ['passkey-prf-v1', 'zklogin-root-v1', 'recovery-code-v1', 'device-key-v1'] as const;
export type CustodyMethod = (typeof CUSTODY_METHODS)[number];

/** Canonical empty for a method-irrelevant 32-byte field. */
export const ZERO_32_BASE64URL = base64url(new Uint8Array(32));

export const RECOVERY_CODE_KDF = 'pbkdf2-sha256' as const;
export const RECOVERY_CODE_ITERATIONS = 600000;
const LOGIN_ROOT_DOMAIN = 'mysocial:agent-custody-secret:zklogin-root:v1';
const RECOVERY_CODE_DOMAIN = 'mysocial:agent-custody-secret:recovery-code:v1';

export type CustodyBinding = {
    chain: string; packageId: string; owner: string; accountId: string;
    rootId: string; subject: string; revision: number;
    credentialId: string; rpId: string; prfInput: string;
    codeKdf: string; codeSalt: string;
};
export type RecoveryRootWrapV2 = CustodyBinding & {
    version: 2; algorithm: 'AES-256-GCM'; kdf: 'HKDF-SHA256'; method: CustodyMethod;
    salt: string; nonce: string; ciphertext: string;
};
export type AnyRecoveryRootWrap = RecoveryRootWrapV1 | RecoveryRootWrapV2;

export function isCustodyMethod(value: unknown): value is CustodyMethod {
    return typeof value === 'string' && (CUSTODY_METHODS as readonly string[]).includes(value);
}

/** Canonical empty field rules; a wrap cannot be replayed under a different method. */
export function normalizeCustodyBinding(method: CustodyMethod, binding: CustodyBinding): CustodyBinding {
    if (!isCustodyMethod(method)) throw new Error('Unsupported custody method');
    if (!binding.subject) throw new Error('Custody subject is required');
    const address = (value: string) => normalizeKeyAddress(value);
    const base: CustodyBinding = {
        chain: binding.chain, packageId: address(binding.packageId), owner: address(binding.owner), accountId: address(binding.accountId),
        rootId: binding.rootId, subject: binding.subject, revision: binding.revision,
        credentialId: '', rpId: '', prfInput: ZERO_32_BASE64URL, codeKdf: '', codeSalt: ZERO_32_BASE64URL,
    };
    if (!Number.isInteger(base.revision) || base.revision < 1 || base.revision > 0xffffffff) throw new Error('Invalid revision');
    if (method === 'passkey-prf-v1') {
        if (!binding.credentialId || !binding.rpId) throw new Error('Passkey custody requires a credential id and rp id');
        const prfInput = fromBase64url(binding.prfInput, 32);
        if (prfInput.every(b => b === 0)) throw new Error('Passkey custody requires a PRF input');
        base.credentialId = binding.credentialId; base.rpId = binding.rpId; base.prfInput = base64url(prfInput);
    } else if (method === 'recovery-code-v1') {
        const {kdf, iterations} = parseRecoveryCodeParams(binding.codeKdf);
        const codeSalt = fromBase64url(binding.codeSalt, 32);
        if (codeSalt.every(b => b === 0)) throw new Error('Recovery-code custody requires a code salt');
        if (base.subject !== address(binding.owner)) throw new Error('Recovery-code subject must be the account owner');
        base.codeKdf = formatRecoveryCodeParams(kdf, iterations); base.codeSalt = base64url(codeSalt);
    } else if (method === 'zklogin-root-v1') {
        if (base.subject !== address(binding.owner)) throw new Error('Login-root subject must be the account owner');
    } else if (method === 'device-key-v1') {
        if (base.subject !== address(binding.owner)) throw new Error('Device-key subject must be the account owner');
    }
    if (binding.credentialId !== base.credentialId || binding.prfInput !== base.prfInput
        || binding.codeKdf !== base.codeKdf || binding.codeSalt !== base.codeSalt) {
        throw new Error('Custody binding carries fields that do not belong to its method');
    }
    return base;
}

const RootAAD2 = bcs.struct('RecoveryRootWrapV2', {
    domain: bcs.string(), version: bcs.u8(), algorithm: bcs.string(), kdf: bcs.string(),
    method: bcs.string(),
    chain: bcs.string(), packageId: Address, owner: Address, accountId: Address,
    rootId: bcs.string(), subject: bcs.string(),
    credentialId: bcs.string(), rpId: bcs.string(), prfInput: Address,
    codeKdf: bcs.string(), codeSalt: Address,
    revision: bcs.u32(), salt: Address,
});
export function rootWrapV2AAD(e: RecoveryRootWrapV2): Uint8Array {
    if (e.version !== ROOT_WRAP_VERSION) throw new Error('Unsupported root wrap version');
    if (e.algorithm !== 'AES-256-GCM' || e.kdf !== 'HKDF-SHA256') throw new Error('Unsupported envelope version');
    if (!Number.isInteger(e.revision) || e.revision < 1 || e.revision > 0xffffffff) throw new Error('Invalid revision');
    const binding = normalizeCustodyBinding(e.method, e);
    return RootAAD2.serialize({
        ...binding, domain: 'mysocial:agent-root-wrap:v2', version: ROOT_WRAP_VERSION, algorithm: e.algorithm, kdf: e.kdf, method: e.method,
        packageId: address(binding.packageId), owner: address(binding.owner), accountId: address(binding.accountId),
        prfInput: Array.from(fromBase64url(binding.prfInput, 32)), codeSalt: Array.from(fromBase64url(binding.codeSalt, 32)),
        salt: Array.from(fromBase64url(e.salt, 32)),
    }).toBytes();
}
export async function wrapRecoveryRootV2(secret: Uint8Array, root: Uint8Array, method: CustodyMethod, binding: CustodyBinding): Promise<RecoveryRootWrapV2> {
    if (root.length !== 32) throw new Error('Invalid recovery root');
    const b = normalizeCustodyBinding(method, binding);
    const wrap: RecoveryRootWrapV2 = {
        ...b, version: ROOT_WRAP_VERSION, algorithm: 'AES-256-GCM', kdf: 'HKDF-SHA256', method,
        salt: base64url(randomKey()), nonce: base64url(crypto.getRandomValues(new Uint8Array(12))), ciphertext: '',
    };
    wrap.ciphertext = base64url(await crypt(secret, wrap.salt, rootWrapV2AAD(wrap), wrap.nonce, root, false));
    return wrap;
}
export async function unwrapRecoveryRootV2(secret: Uint8Array, wrap: RecoveryRootWrapV2): Promise<Uint8Array> {
    return crypt(secret, wrap.salt, rootWrapV2AAD(wrap), wrap.nonce, fromBase64url(wrap.ciphertext, 48), true);
}
export function isRecoveryRootWrapV2(value: unknown): value is RecoveryRootWrapV2 {
    const v = value as RecoveryRootWrapV2 | null;
    return !!v && typeof v === 'object' && v.version === ROOT_WRAP_VERSION && isCustodyMethod((v as {method?: unknown}).method);
}
/** Dual-read: v1 wraps (passkey PRF) and v2 wraps both unlock the same root. */
export async function unwrapAnyRecoveryRoot(secret: Uint8Array, wrap: AnyRecoveryRootWrap): Promise<Uint8Array> {
    return isRecoveryRootWrapV2(wrap) ? unwrapRecoveryRootV2(secret, wrap) : unwrapRecoveryRoot(secret, wrap);
}

export function formatRecoveryCodeParams(kdf: string = RECOVERY_CODE_KDF, iterations: number = RECOVERY_CODE_ITERATIONS): string {
    if (kdf !== RECOVERY_CODE_KDF) throw new Error('Unsupported recovery-code KDF');
    if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 10000000) throw new Error('Invalid recovery-code iterations');
    return `${kdf}:${iterations}`;
}
export function parseRecoveryCodeParams(params: string): {kdf: string; iterations: number} {
    const [kdf, raw] = (params ?? '').split(':');
    const iterations = Number(raw);
    if (kdf !== RECOVERY_CODE_KDF || !Number.isInteger(iterations) || iterations < 100000 || iterations > 10000000) throw new Error('Invalid recovery-code parameters');
    return {kdf, iterations};
}

/** `zklogin-root-v1` wrap secret: the deterministic login key, domain-separated. */
export async function deriveZkLoginRootSecret(loginSeed: Uint8Array): Promise<Uint8Array> {
    if (loginSeed.length !== 32) throw new Error('Expected a 32-byte login seed');
    const info = new TextEncoder().encode(LOGIN_ROOT_DOMAIN);
    return hkdf(sha256, loginSeed, new Uint8Array(32), info, 32);
}
/**
 * `recovery-code-v1` wrap secret: requires both the login key and the user code, so neither the
 * salt service nor the user's code alone can unwrap. Parameter order is fixed by the KDF params
 * stored in the wrap, so changing the iteration count requires a new wrap.
 */
export async function deriveRecoveryCodeSecret(loginSeed: Uint8Array, code: string, codeSalt: Uint8Array, codeKdf: string = formatRecoveryCodeParams()): Promise<Uint8Array> {
    if (loginSeed.length !== 32) throw new Error('Expected a 32-byte login seed');
    if (codeSalt.length !== 32) throw new Error('Expected a 32-byte code salt');
    if (!code) throw new Error('Recovery code is required');
    const {iterations} = parseRecoveryCodeParams(codeKdf);
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(code) as BufferSource, 'PBKDF2', false, ['deriveBits']);
    const stretched = new Uint8Array(await crypto.subtle.deriveBits({name: 'PBKDF2', salt: codeSalt as BufferSource, iterations, hash: 'SHA-256'}, base, 256));
    const ikm = new Uint8Array(64);
    try {
        ikm.set(loginSeed, 0); ikm.set(stretched, 32);
        return hkdf(sha256, ikm, codeSalt, new TextEncoder().encode(RECOVERY_CODE_DOMAIN), 32);
    } finally { stretched.fill(0); ikm.fill(0); }
}
/** `device-key-v1`: random wrap secret held only on the device; never sent to a server. */
export function generateDeviceWrapSecret(): Uint8Array { return randomKey(); }

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
