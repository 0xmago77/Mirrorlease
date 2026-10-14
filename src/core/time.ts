// Arkiv stores expiry as a block height. These helpers place block heights on the wall clock
// using arkiv_getBlockTiming, so the UI can say "expires in 5h" instead of "block 612345".

export type Clock = {
  currentBlock: bigint
  /** Unix seconds of currentBlock. */
  currentBlockTime: number
  /** Seconds per block. */
  blockDuration: number
}

export function blockToMs(block: bigint, clock: Clock): number {
  const deltaBlocks = Number(block - clock.currentBlock)
  return (clock.currentBlockTime + deltaBlocks * clock.blockDuration) * 1000
}

export function msToBlock(ms: number, clock: Clock): bigint {
  const deltaSeconds = ms / 1000 - clock.currentBlockTime
  return clock.currentBlock + BigInt(Math.round(deltaSeconds / clock.blockDuration))
}

export function nowMs(clock: Clock): number {
  return clock.currentBlockTime * 1000
}

/** "5h 12m", "3d 4h", "40m", "20s". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(Math.abs(ms) / 1000))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  if (m > 0) return `${m}m`
  return `${s}s`
}

export function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC"
}
