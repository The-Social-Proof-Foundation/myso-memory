---
title: "Quick Start"
---

The fastest way to get Memory running is through the TypeScript SDK.

## Prerequisites

- [Node.js](https://nodejs.org/) v18+ or [Bun](https://bun.sh/) v1+

## Quick Start

<Steps>
  <Step>
    ### Install the SDK

    <Tabs>
      <Tab title="pnpm">
        ```bash
        pnpm add @socialproof/memory
        ```
      </Tab>
      <Tab title="npm">
        ```bash
        npm install @socialproof/memory
        ```
      </Tab>
      <Tab title="yarn">
        ```bash
        yarn add @socialproof/memory
        ```
      </Tab>
      <Tab title="bun">
        ```bash
        bun add @socialproof/memory
        ```
      </Tab>
    </Tabs>

    **Optional packages**

    For AI middleware with [Vercel AI SDK](https://sdk.vercel.ai/) (`@socialproof/memory/ai`):

    <Tabs>
      <Tab title="pnpm">
        ```bash
        pnpm add ai
        ```
      </Tab>
      <Tab title="npm">
        ```bash
        npm install ai
        ```
      </Tab>
      <Tab title="yarn">
        ```bash
        yarn add ai
        ```
      </Tab>
      <Tab title="bun">
        ```bash
        bun add ai
        ```
      </Tab>
    </Tabs>

    For the [manual client flow](/getting-started/choose-your-path) (`@socialproof/memory/manual`):

    <Tabs>
      <Tab title="pnpm">
        ```bash
        pnpm add @socialproof/myso @socialproof/mydata @socialproof/file-storage
        ```
      </Tab>
      <Tab title="npm">
        ```bash
        npm install @socialproof/myso @socialproof/mydata @socialproof/file-storage
        ```
      </Tab>
      <Tab title="yarn">
        ```bash
        yarn add @socialproof/myso @socialproof/mydata @socialproof/file-storage
        ```
      </Tab>
      <Tab title="bun">
        ```bash
        bun add @socialproof/myso @socialproof/mydata @socialproof/file-storage
        ```
      </Tab>
    </Tabs>
  </Step>

  <Step>
    ### Generate your account ID and delegate key

    Create a Memory account ID and delegate private key for your SDK client using one of the hosted endpoints below.

    <Note>
    The following endpoints are provided as a public good by File Storage Foundation.
    </Note>

    | App | URL |
    | --- | --- |
    | **Memory Playground** | [mysocial.network](https://mysocial.network) |
    | **File Storage-hosted Playground** | [memory.wal.app](https://memory.wal.app) |

    For the contract-based setup flow, see [Delegate Key Management](/contract/delegate-key-management) and [Memory smart contract](/contract/overview).
  </Step>

  <Step>
    ### Choose a relayer

    Use a hosted relayer, or deploy your own [self-hosted relayer](/relayer/self-hosting) with access to a wallet funded with WAL and MYSO:

    <Note>
    Following endpoints are provided as public good by File Storage Foundation.
    </Note>

    | Network | Relayer URL |
    | --- | --- |
    | **Production** (mainnet) | `https://memory.mysocial.network` |
    | **Staging** (testnet) | `https://relayer.testnet.mysocial.network` |
  </Step>

  <Step>
    ### Configure the SDK

    Set up the SDK with your delegate key, account ID, and relayer URL:

    ```ts
    import { Memory } from "@socialproof/memory";

    const memory = Memory.create({
      key: "<your-ed25519-private-key>",
      accountId: "<your-memory-account-id>",
      serverUrl: "https://memory.mysocial.network",
      namespace: "my-app",
    });
    ```
  </Step>

  <Step>
    ### Verify your connection

    Run a health check to confirm everything is working:

    ```ts
    await memory.health();
    ```
  </Step>

  <Step>
    ### Store and recall your first memory

    ```ts
    await memory.remember("User prefers dark mode and works in TypeScript.");

    const result = await memory.recall("What do we know about this user?");
    console.log(result.results);
    ```

    That's it - you're up and running.
  </Step>
</Steps>
