import {Memory} from '@socialproof/memory';
/** Keys stay on the client; the SDK sends signatures and scoped MYDATA sessions. */
export async function apiCall(privateKeyHex: string, serverUrl: string, path: string, body: object, accountId?: string) {
  if (!accountId) throw new Error('A memory account is required');
  const client = Memory.create({key: privateKeyHex, serverUrl, accountId});
  try {return await client.request('POST',path,body);} finally {client.destroy();}
}
