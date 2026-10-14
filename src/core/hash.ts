// sha256 via WebCrypto, which both Node (>= 20) and browsers provide as globalThis.crypto.subtle.

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data)
  const digest = await globalThis.crypto.subtle.digest("SHA-256", buf as Uint8Array<ArrayBuffer>)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
}

export function shortHash(sha: string, n = 12): string {
  return sha.length > n ? `${sha.slice(0, n)}…` : sha
}
