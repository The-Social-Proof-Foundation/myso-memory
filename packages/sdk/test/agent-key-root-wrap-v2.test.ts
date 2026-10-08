import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  base64url, deriveRecoveryCodeSecret, deriveZkLoginRootSecret, formatRecoveryCodeParams, fromBase64url,
  generateDeviceWrapSecret, isCustodyMethod, isRecoveryRootWrapV2, keyHex, normalizeCustodyBinding,
  normalizeKeyAddress, parseRecoveryCodeParams, rootWrapAAD, rootWrapV2AAD, unwrapAnyRecoveryRoot, unwrapRecoveryRoot,
  unwrapRecoveryRootV2, wrapRecoveryRoot, wrapRecoveryRootV2, ZERO_32_BASE64URL,
} from '../src/agent-key-envelope.js';

/**
 * NOTE: this file asserts behaviour, not pinned hex. Pinned reference bytes for the v2 root-wrap AAD
 * (the analogue of `agent-key-envelope-vectors.json` for v1) still have to be generated from a
 * verified run and added alongside the v1 vectors.
 */

const root = new Uint8Array(32).fill(7);
const owner = normalizeKeyAddress('0x2');
const common = {chain: 'local-chain', packageId: normalizeKeyAddress('0x1'), owner, accountId: normalizeKeyAddress('0x3'), rootId: '00000000-0000-4000-8000-000000000001', revision: 1};
const passkey = () => normalizeCustodyBinding('passkey-prf-v1', {...common, subject: 'credential-a', credentialId: 'credential-a', rpId: 'localhost', prfInput: base64url(new Uint8Array(32).fill(1)), codeKdf: '', codeSalt: ZERO_32_BASE64URL});
const loginRoot = () => normalizeCustodyBinding('zklogin-root-v1', {...common, subject: owner, credentialId: '', rpId: '', prfInput: ZERO_32_BASE64URL, codeKdf: '', codeSalt: ZERO_32_BASE64URL});
const recoveryCode = () => normalizeCustodyBinding('recovery-code-v1', {...common, subject: owner, credentialId: '', rpId: '', prfInput: ZERO_32_BASE64URL, codeKdf: formatRecoveryCodeParams(), codeSalt: base64url(new Uint8Array(32).fill(4))});
const device = () => normalizeCustodyBinding('device-key-v1', {...common, subject: owner, credentialId: '', rpId: '', prfInput: ZERO_32_BASE64URL, codeKdf: '', codeSalt: ZERO_32_BASE64URL});

test('every tier wraps and unwraps the same root independently', async () => {
  const secrets = {
    'passkey-prf-v1': new Uint8Array(32).fill(8),
    'zklogin-root-v1': await deriveZkLoginRootSecret(new Uint8Array(32).fill(5)),
    'recovery-code-v1': await deriveRecoveryCodeSecret(new Uint8Array(32).fill(5), 'correct horse battery staple', new Uint8Array(32).fill(4)),
    'device-key-v1': generateDeviceWrapSecret(),
  } as const;
  const wraps = {
    'passkey-prf-v1': await wrapRecoveryRootV2(secrets['passkey-prf-v1'], root, 'passkey-prf-v1', passkey()),
    'zklogin-root-v1': await wrapRecoveryRootV2(secrets['zklogin-root-v1'], root, 'zklogin-root-v1', loginRoot()),
    'recovery-code-v1': await wrapRecoveryRootV2(secrets['recovery-code-v1'], root, 'recovery-code-v1', recoveryCode()),
    'device-key-v1': await wrapRecoveryRootV2(secrets['device-key-v1'], root, 'device-key-v1', device()),
  };
  for (const [method, wrap] of Object.entries(wraps)) {
    assert.equal(wrap.method, method);
    assert.deepEqual(await unwrapRecoveryRootV2(secrets[method as keyof typeof secrets], wrap), root);
    assert.deepEqual(await unwrapAnyRecoveryRoot(secrets[method as keyof typeof secrets], wrap), root);
  }
  assert.equal(new Set(Object.values(wraps).map(w => w.salt)).size, 4);
  // Cross-tier secrets never unlock another tier's wrap.
  await assert.rejects(() => unwrapRecoveryRootV2(secrets['passkey-prf-v1'], wraps['zklogin-root-v1']));
  await assert.rejects(() => unwrapRecoveryRootV2(secrets['zklogin-root-v1'], wraps['passkey-prf-v1']));
  await assert.rejects(() => unwrapRecoveryRootV2(secrets['zklogin-root-v1'], wraps['recovery-code-v1']));
});

test('the recovery-code tier needs both the login key and the code', async () => {
  const login = new Uint8Array(32).fill(5);
  const salt = new Uint8Array(32).fill(4);
  const params = formatRecoveryCodeParams('pbkdf2-sha256', 100000);
  const secret = await deriveRecoveryCodeSecret(login, 'correct horse battery staple', salt, params);
  const wrap = await wrapRecoveryRootV2(secret, root, 'recovery-code-v1', normalizeCustodyBinding('recovery-code-v1', {...common, subject: owner, credentialId: '', rpId: '', prfInput: ZERO_32_BASE64URL, codeKdf: params, codeSalt: base64url(salt)}));
  assert.deepEqual(await unwrapRecoveryRootV2(secret, wrap), root);
  await assert.rejects(async () => unwrapRecoveryRootV2(await deriveRecoveryCodeSecret(login, 'wrong code', salt, params), wrap));
  await assert.rejects(async () => unwrapRecoveryRootV2(await deriveRecoveryCodeSecret(new Uint8Array(32).fill(6), 'correct horse battery staple', salt, params), wrap));
  // A different iteration count is a different secret, so the wrap carries its own parameters.
  await assert.rejects(async () => unwrapRecoveryRootV2(await deriveRecoveryCodeSecret(login, 'correct horse battery staple', salt, formatRecoveryCodeParams('pbkdf2-sha256', 100001)), wrap));
  assert.throws(() => parseRecoveryCodeParams('pbkdf2-sha256:1'));
  assert.throws(() => formatRecoveryCodeParams('scrypt', 100000));
});

test('method-irrelevant fields must be canonical, so a wrap cannot move between tiers', () => {
  assert.throws(() => normalizeCustodyBinding('zklogin-root-v1', {...common, subject: owner, credentialId: 'credential-a', rpId: 'localhost', prfInput: base64url(new Uint8Array(32).fill(1)), codeKdf: '', codeSalt: ZERO_32_BASE64URL}));
  assert.throws(() => normalizeCustodyBinding('zklogin-root-v1', {...common, subject: normalizeKeyAddress('0x9'), credentialId: '', rpId: '', prfInput: ZERO_32_BASE64URL, codeKdf: '', codeSalt: ZERO_32_BASE64URL}));
  assert.throws(() => normalizeCustodyBinding('passkey-prf-v1', {...common, subject: 'credential-a', credentialId: 'credential-a', rpId: 'localhost', prfInput: ZERO_32_BASE64URL, codeKdf: '', codeSalt: ZERO_32_BASE64URL}));
  assert.throws(() => normalizeCustodyBinding('passkey-prf-v1', {...common, subject: 'credential-a', credentialId: '', rpId: 'localhost', prfInput: base64url(new Uint8Array(32).fill(1)), codeKdf: '', codeSalt: ZERO_32_BASE64URL}));
  assert.throws(() => normalizeCustodyBinding('device-key-v1', {...common, subject: 'device-01', credentialId: '', rpId: '', prfInput: ZERO_32_BASE64URL, codeKdf: '', codeSalt: ZERO_32_BASE64URL}));
  assert.equal(isCustodyMethod('zklogin-root-v2'), false);
});

test('the v2 AAD is domain-separated and covers every bound field', async () => {
  const wrap = await wrapRecoveryRootV2(new Uint8Array(32).fill(8), root, 'passkey-prf-v1', passkey());
  const aad = rootWrapV2AAD(wrap);
  // BCS layout: the purpose domain comes first, as a ULEB128 length prefix plus its UTF-8 bytes.
  const domain = 'mysocial:agent-root-wrap:v2';
  assert.equal(aad[0], domain.length);
  assert.equal(new TextDecoder().decode(aad.slice(1, 1 + domain.length)), domain);
  // Every binding field changes the AAD, so none of them can be dropped from the contract.
  const variants = [
    {...wrap, method: 'zklogin-root-v1', subject: owner, credentialId: '', rpId: '', prfInput: ZERO_32_BASE64URL},
    {...wrap, chain: 'other'}, {...wrap, packageId: normalizeKeyAddress('0xf')}, {...wrap, owner: normalizeKeyAddress('0xf')},
    {...wrap, accountId: normalizeKeyAddress('0xf')}, {...wrap, rootId: 'other'}, {...wrap, subject: 'credential-b'},
    {...wrap, credentialId: 'credential-b'}, {...wrap, rpId: 'other'}, {...wrap, revision: 2},
    {...wrap, salt: base64url(new Uint8Array(32))}, {...wrap, version: 2 as const},
  ];
  for (const variant of variants) {
    const patched = variant as typeof wrap;
    if (patched.method !== wrap.method || patched.subject !== wrap.subject || patched.credentialId !== wrap.credentialId
      || patched.rpId !== wrap.rpId || patched.prfInput !== wrap.prfInput) {
      assert.throws(() => rootWrapV2AAD(patched), `non-canonical variant for ${JSON.stringify(Object.keys(variant))}`);
      continue;
    }
    assert.notEqual(keyHex(rootWrapV2AAD(patched)), keyHex(aad));
  }
});

test('rejects tampering of every v2 binding field and of the ciphertext', async () => {
  const secret = new Uint8Array(32).fill(8);
  const wrap = await wrapRecoveryRootV2(secret, root, 'passkey-prf-v1', passkey());
  for (const patch of [
    {chain: 'other'}, {packageId: normalizeKeyAddress('0xf')}, {owner: normalizeKeyAddress('0xf')}, {accountId: normalizeKeyAddress('0xf')},
    {rootId: 'other'}, {subject: 'credential-b'}, {credentialId: 'credential-b'}, {rpId: 'other'}, {revision: 2},
    {nonce: base64url(new Uint8Array(12))}, {ciphertext: base64url(new Uint8Array(48))}, {salt: base64url(new Uint8Array(32))},
    {method: 'zklogin-root-v1'}, {version: 1},
  ]) {
    await assert.rejects(() => unwrapRecoveryRootV2(secret, {...wrap, ...patch} as typeof wrap));
  }
  await assert.rejects(() => unwrapRecoveryRootV2(new Uint8Array(32), wrap));
  assert.throws(() => rootWrapV2AAD({...wrap, version: 1} as any));
  assert.throws(() => rootWrapV2AAD({...wrap, algorithm: 'AES-128-GCM'} as any));
  assert.throws(() => rootWrapV2AAD({...wrap, revision: 0} as any));
});

test('v1 and v2 wraps of the same root never cross-authenticate', async () => {
  const prf = new Uint8Array(32).fill(8);
  const v1 = await wrapRecoveryRoot(prf, root, {chain: common.chain, packageId: common.packageId, owner, accountId: common.accountId, rootId: common.rootId, credentialId: 'credential-a', rpId: 'localhost', prfInput: base64url(new Uint8Array(32).fill(1)), revision: 1});
  const v2 = await wrapRecoveryRootV2(prf, root, 'passkey-prf-v1', passkey());
  assert.equal(isRecoveryRootWrapV2(v1), false);
  assert.equal(isRecoveryRootWrapV2(v2), true);
  assert.deepEqual(await unwrapAnyRecoveryRoot(prf, v1), root);
  assert.deepEqual(await unwrapAnyRecoveryRoot(prf, v2), root);
  assert.notEqual(keyHex(rootWrapV2AAD(v2)), keyHex(rootWrapV2AAD({...v2, subject: 'credential-b', credentialId: 'credential-b'})));
  // The v1 AAD builder rejects v2 input, so the two domains cannot be confused.
  assert.throws(() => rootWrapAAD(v2 as any));
});
