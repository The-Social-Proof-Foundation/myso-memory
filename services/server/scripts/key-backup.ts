/** Public verification only: never accept PRF output, roots, or signing seeds. */
import {generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse} from '@simplewebauthn/server';
import {verifyPersonalMessageSignature} from '@socialproof/myso/verify';
import {MySoJsonRpcClient} from '@socialproof/myso/jsonRpc';
import {parseZkLoginSignature} from '@socialproof/myso/zklogin';
/** Purposes a signed owner intent may carry; anything else is rejected before verification. */
const OWNER_PURPOSES = new Set(['unlock-agent-backups', 'custody-unlock-zklogin-root-v1', 'custody-unlock-recovery-code-v1', 'custody-unlock-device-key-v1']);
export async function keyBackupOperation(operation: string, input: any) {
    if (operation === 'owner') {
        if (typeof input.message !== 'string' || !/^mysocial-key-backup-owner-v[12]\|/.test(input.message) || input.message.length > 4096) throw new Error('Invalid owner intent');
        // Ownership intents bind the purpose; custody unlocks must name one of the pinned purposes.
        if (input.message.startsWith('mysocial-key-backup-owner-v2|') && !OWNER_PURPOSES.has(input.message.split('|')[5])) throw new Error('Invalid owner intent');
        const client = new MySoJsonRpcClient({url: process.env.MYSO_RPC_URL!, network: process.env.MYSO_NETWORK === 'mainnet' ? 'mainnet' : 'testnet'});
        if (Buffer.from(input.signature, 'base64')[0] === 5) {
            const parsed = parseZkLoginSignature(new Uint8Array(Buffer.from(input.signature, 'base64').subarray(1)));
            const system = await client.getLatestMySoSystemState();
            if (BigInt(system.epoch) > BigInt(parsed.maxEpoch)) throw new Error('Expired zkLogin signature');
        }
        await verifyPersonalMessageSignature(new TextEncoder().encode(input.message), input.signature, {client, address: input.owner});
        return {verified: true};
    }
    if (operation === 'registration-options') {
        return generateRegistrationOptions({rpName: 'MySocial agent backups', rpID: input.rpId,
            userName: input.owner, userID: new Uint8Array(Buffer.from(input.accountId.slice(2), 'hex')),
            attestationType: 'none', authenticatorSelection: {residentKey: 'required', userVerification: 'required'},
            excludeCredentials: input.credentials.map((c: any) => ({id: c.id, transports: c.transports}))});
    }
    if (operation === 'registration-verify') {
        const result = await verifyRegistrationResponse({response: input.response,
            expectedChallenge: input.challenge, expectedOrigin: input.origins, expectedRPID: input.rpId, requireUserVerification: true});
        if (!result.verified || !result.registrationInfo) throw new Error('Registration rejected');
        const {credential, credentialDeviceType, credentialBackedUp} = result.registrationInfo;
        return {id: credential.id, publicKey: Buffer.from(credential.publicKey).toString('base64url'),
            counter: credential.counter, transports: credential.transports ?? [], credentialDeviceType, credentialBackedUp};
    }
    if (operation === 'authentication-options') return generateAuthenticationOptions({rpID: input.rpId, userVerification: 'required', allowCredentials: input.credentials.map((c: any) => ({id: c.id, transports: c.transports}))});
    if (operation === 'authentication-verify') {
        const c = input.credential;
        const result = await verifyAuthenticationResponse({response: input.response,
            expectedChallenge: input.challenge, expectedOrigin: input.origins, expectedRPID: input.rpId, requireUserVerification: true,
            credential: {id: c.id, publicKey: new Uint8Array(Buffer.from(c.publicKey, 'base64url')), counter: c.counter, transports: c.transports}});
        if (!result.verified) throw new Error('Assertion rejected');
        return {counter: result.authenticationInfo.newCounter};
    }
    throw new Error('Unsupported verification operation');
}
