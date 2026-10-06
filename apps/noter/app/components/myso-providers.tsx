"use client";

import {
  createNetworkConfig,
  MySoClientProvider,
  WalletProvider,
} from "@socialproof/dapp-kit";
import { getJsonRpcFullnodeUrl } from "@socialproof/myso/jsonRpc";
import { enokiConfig } from "@/lib/enoki/config";

const { networkConfig } = createNetworkConfig({
  testnet: { url: getJsonRpcFullnodeUrl("testnet"), network: "testnet" },
  mainnet: { url: getJsonRpcFullnodeUrl("mainnet"), network: "mainnet" },
});

// Address-only Enoki sessions and server-held agent credentials are retired.
/** MySo + Enoki provider stack. Does NOT include React Query — noter's TRPCProvider handles that. */
export function MySoProviders({ children }: { children: React.ReactNode }) {
  return (
    <MySoClientProvider
      networks={networkConfig}
      defaultNetwork={enokiConfig.mysoNetwork}
    >
      <WalletProvider autoConnect>{children}</WalletProvider>
    </MySoClientProvider>
  );
}
