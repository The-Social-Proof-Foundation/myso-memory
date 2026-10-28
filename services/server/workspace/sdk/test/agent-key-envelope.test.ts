import {test} from 'node:test';
import assert from 'node:assert/strict';
import {agentKeyFromSeed, encryptAgentKey, decryptAgentKey, wrapRecoveryRoot, unwrapRecoveryRoot, base64url, agentEnvelopeAAD, rootWrapAAD, keyHex, normalizeKeyAddress, fromBase64url} from '../src/agent-key-envelope.js';
const root=new Uint8Array(32).fill(7), prf=new Uint8Array(32).fill(8);
const key=await agentKeyFromSeed(new Uint8Array(32).fill(9));
const binding={chain:'local-chain',packageId:normalizeKeyAddress('0x1'),owner:normalizeKeyAddress('0x2'),accountId:normalizeKeyAddress('0x3'),rootId:'00000000-0000-4000-8000-000000000001',keyId:'00000000-0000-4000-8000-000000000002',organizationId:normalizeKeyAddress('0x4'),agentId:normalizeKeyAddress('0x5'),publicKey:keyHex(key.publicKey),derivedAddress:key.address,revision:1};
test('same seed survives fresh encryption; identities produce distinct authenticated envelopes',async()=>{
  const a=await encryptAgentKey(root,key.seed,binding),b=await encryptAgentKey(root,key.seed,{...binding,agentId:normalizeKeyAddress('0x6')});
  assert.notEqual(a.ciphertext,b.ciphertext);assert.notEqual(a.nonce,b.nonce);
  assert.deepEqual((await decryptAgentKey(root,a)).seed,key.seed);
});
test('rejects tampering of every binding and ciphertext',async()=>{
  const a=await encryptAgentKey(root,key.seed,binding);
  for(const patch of [{chain:'other'},{owner:normalizeKeyAddress('0xf')},{accountId:normalizeKeyAddress('0xf')},{rootId:'other'},{keyId:'other'},{organizationId:normalizeKeyAddress('0xf')},{agentId:normalizeKeyAddress('0xf')},{revision:2},{kind:'draft'},{nonce:base64url(new Uint8Array(12))},{ciphertext:base64url(new Uint8Array(48))},{salt:base64url(new Uint8Array(32))}]) {
    await assert.rejects(()=>decryptAgentKey(root,{...a,...patch} as typeof a));
  }
  await assert.rejects(()=>decryptAgentKey(new Uint8Array(32),a));
});
test('draft domain cannot become a finalized envelope',async()=>{
  const a=await encryptAgentKey(root,key.seed,{...binding,agentId:normalizeKeyAddress('0x0')},'draft');
  await assert.rejects(()=>decryptAgentKey(root,{...a,kind:'agent'}));
});
test('additional passkeys independently unlock the same root',async()=>{
  const identity={chain:binding.chain,packageId:binding.packageId,owner:binding.owner,accountId:binding.accountId,rootId:binding.rootId,credentialId:'credential-a',rpId:'localhost',prfInput:base64url(new Uint8Array(32).fill(1)),revision:1};
  const a=await wrapRecoveryRoot(prf,root,identity),b=await wrapRecoveryRoot(new Uint8Array(32).fill(10),root,{...identity,credentialId:'credential-b'});
  assert.deepEqual(await unwrapRecoveryRoot(prf,a),root);
  assert.deepEqual(await unwrapRecoveryRoot(new Uint8Array(32).fill(10),b),root);
  await assert.rejects(()=>unwrapRecoveryRoot(prf,b));
  await assert.rejects(()=>unwrapRecoveryRoot(prf,{...a,rpId:'other'}));
});
test('strict version, key binding, and transport encoding',async()=>{
  await assert.rejects(()=>encryptAgentKey(root,key.seed,{...binding,publicKey:'0'.repeat(64)}));
  const a=await encryptAgentKey(root,key.seed,binding);
  assert.throws(()=>agentEnvelopeAAD({...a,version:2} as any));
  assert.throws(()=>fromBase64url(a.ciphertext+'='));
  assert.throws(()=>fromBase64url('A'));
  assert.throws(()=>normalizeKeyAddress('0xzz'));
  assert.throws(()=>rootWrapAAD({version:2} as any));
});

test('fixed BCS/HKDF reference vector matches the independently encoded contract',async()=>{
  const {readFile}=await import('node:fs/promises');
  const vector=JSON.parse(await readFile(new URL('./agent-key-envelope-vectors.json',import.meta.url),'utf8'));
  const {hkdf}=await import('@noble/hashes/hkdf.js');
  const {sha256}=await import('@noble/hashes/sha2.js');
  const aad=agentEnvelopeAAD(vector.envelope);
  assert.equal(keyHex(aad),vector.aadHex);
  assert.equal(keyHex(hkdf(sha256,new Uint8Array(Buffer.from(vector.secretHex,'hex')),fromBase64url(vector.envelope.salt),aad,32)),vector.derivedKeyHex);
});

test('registration and budget choices cannot be altered independently of the backup',async()=>{
  const {agentRegistrationIntentHash}=await import('../src/agent-key-envelope.js');
  const intent={label:'My agent',capabilities:3,delegatableCaps:0,expiresAtMs:null,parentAgentId:null,budget:{balanceId:normalizeKeyAddress('0x7'),budgetMist:'100',dailyCapMist:null,monthlyCapMist:null,requireApprovalAboveMist:null}};
  const e=await encryptAgentKey(root,key.seed,{...binding,registrationIntent:intent,intentHash:agentRegistrationIntentHash(intent)});
  assert.deepEqual((await decryptAgentKey(root,e)).seed,key.seed);
  await assert.rejects(()=>decryptAgentKey(root,{...e,registrationIntent:{...intent,capabilities:16387}}));
  await assert.rejects(()=>decryptAgentKey(root,{...e,registrationIntent:{...intent,budget:{...intent.budget,budgetMist:'1000000'}}}));
});
