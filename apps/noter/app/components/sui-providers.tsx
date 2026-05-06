"use client";

import { useEffect } from "react";
import {
  createNetworkConfig,
  MySoClientProvider,
  WalletProvider,
  useMySoClientContext,
} from "@socialproof/dapp-kit";
import { isEnokiNetwork, registerEnokiWallets } from "@mysten/enoki";
import { getJsonRpcFullnodeUrl } from "@socialproof/myso/jsonRpc";
import { enokiConfig } from "@/lib/enoki/config";

const { networkConfig } = createNetworkConfig({
  testnet: { url: getJsonRpcFullnodeUrl("testnet"), network: "testnet" },
  mainnet: { url: getJsonRpcFullnodeUrl("mainnet"), network: "mainnet" },
});

/** Registers Enoki wallets (Google OAuth) with dapp-kit on mount. No-op if env vars are missing. */
function RegisterEnokiWallets() {
  const { client, network } = useMySoClientContext();

  useEffect(() => {
    if (!isEnokiNetwork(network)) return;
    if (!enokiConfig.enokiApiKey || !enokiConfig.googleClientId) return;

    const { unregister } = registerEnokiWallets({
      apiKey: enokiConfig.enokiApiKey,
      providers: {
        google: { clientId: enokiConfig.googleClientId },
      },
      client,
      network,
    });

    return unregister;
  }, [client, network]);

  return null;
}

/** MySo + Enoki provider stack. Does NOT include React Query — noter's TRPCProvider handles that. */
export function MySoProviders({ children }: { children: React.ReactNode }) {
  return (
    <MySoClientProvider
      networks={networkConfig}
      defaultNetwork={enokiConfig.mysoNetwork}
    >
      <RegisterEnokiWallets />
      <WalletProvider autoConnect>{children}</WalletProvider>
    </MySoClientProvider>
  );
}
