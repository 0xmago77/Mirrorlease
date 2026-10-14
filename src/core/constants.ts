// Network and schema constants shared by the CLI, the web page and the scripts.

export const CHAIN_ID = 7738577
export const RPC_HTTP = "https://rpc.tiramisu.db-chain.testnet.arkiv.network"
export const RPC_WS = "wss://rpc.tiramisu.db-chain.testnet.arkiv.network"
export const EXPLORER = "https://tiramisu.explorer.arkiv.network"

/** Every Lifeboat entity carries `lb = "1"` so our queries never match someone else's data. */
export const NAMESPACE_ATTR = "lb"
export const NAMESPACE_VALUE = "1"

export const KIND = {
  app: "app",
  release: "release",
  revocation: "revocation",
  mirror: "mirror",
} as const
export type Kind = (typeof KIND)[keyof typeof KIND]

export type Channel = "stable" | "beta"
export const CHANNELS: readonly Channel[] = ["stable", "beta"]

const HOUR = 60 * 60
const DAY = 24 * HOUR

/** Entity Expiration per entity type, in seconds. */
export const EXPIRATION = {
  app: 180 * DAY,
  /** Support window per channel. When it runs out the release is end-of-life. */
  release: { stable: 60 * DAY, beta: 7 * DAY } as Record<Channel, number>,
  /** Must outlive any release it could refer to. */
  revocation: 365 * DAY,
  /** A mirror is a short lease that only stays alive while someone keeps checking it. */
  mirrorLease: 6 * HOUR,
}

/** How far apart the history probes are when looking for an expired release (seconds). */
export const HISTORY_STEP = 6 * HOUR
/** Upper bound on history probes for one lookup, so an unknown file never costs hundreds of calls. */
export const HISTORY_MAX_PROBES = 240

export const PAGE_SIZE = 200

export function explorerEntityUrl(key: string): string {
  return `${EXPLORER}/entity/${key}`
}

export function explorerTxUrl(hash: string): string {
  return `${EXPLORER}/tx/${hash}`
}

export function explorerAddressUrl(address: string): string {
  return `${EXPLORER}/address/${address}`
}
