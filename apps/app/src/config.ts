/**
 * App-wide configuration from environment variables
 */
export const config = {
    enokiApiKey: import.meta.env.VITE_ENOKI_API_KEY as string || '',
    googleClientId: import.meta.env.VITE_GOOGLE_CLIENT_ID as string || '',
    memoryPackageId: import.meta.env.VITE_MEMORY_PACKAGE_ID as string ||
        '0xcf6ad755a1cdff7217865c796778fabe5aa399cb0cf2eba986f4b582047229c6',
    memoryRegistryId: import.meta.env.VITE_MEMORY_REGISTRY_ID as string ||
        '0xe80f2feec1c139616a86c9f71210152e2a7ca552b20841f2e192f99f75864437',
    memoryServerUrl: import.meta.env.VITE_MEMORY_SERVER_URL as string || 'http://localhost:8000',
    mysoNetwork: (import.meta.env.VITE_MYSO_NETWORK as string || 'testnet') as 'testnet' | 'mainnet',
    mydataKeyServers: (import.meta.env.VITE_MYDATA_KEY_SERVERS as string || '')
        .split(',').map(s => s.trim()).filter(Boolean) as string[],
    sidecarUrl: import.meta.env.VITE_SIDECAR_URL as string || 'http://localhost:9000',
    docsUrl: import.meta.env.VITE_DOCS_URL as string || '',
    demoUrls: (import.meta.env.VITE_DEMO_URLS as string || '')
        .split(',').map(s => s.trim()).filter(Boolean)
        .map(entry => {
            const [label, url] = entry.split('|').map(s => s.trim())
            return url ? { label, url } : { label: label, url: label }
        }),
} as const
