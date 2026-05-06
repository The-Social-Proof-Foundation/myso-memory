/** Enoki zkLogin configuration from NEXT_PUBLIC_* environment variables. */
export const enokiConfig = {
  enokiApiKey: process.env.NEXT_PUBLIC_ENOKI_API_KEY || "",
  googleClientId: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || "",
  mysoNetwork: (process.env.NEXT_PUBLIC_MYSO_NETWORK || "testnet") as
    | "testnet"
    | "mainnet",
  memoryPackageId: process.env.NEXT_PUBLIC_MEMORY_PACKAGE_ID || "",
  memoryRegistryId: process.env.NEXT_PUBLIC_MEMORY_REGISTRY_ID || "",
  memoryServerUrl:
    process.env.NEXT_PUBLIC_MEMORY_SERVER_URL || "http://localhost:9000",
} as const;
