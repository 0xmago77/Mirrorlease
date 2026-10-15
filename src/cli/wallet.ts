// Key loading and the wallet client. Keys come only from MIRRORLEASE_KEY_FILE (a path) or
// MIRRORLEASE_PRIVATE_KEY; they are never printed, logged or written anywhere.

import { appendFileSync, readFileSync } from "node:fs"
import { createWalletClient, type WalletArkivClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { formatEther, type Hash } from "viem"
import { arkivHttp } from "../core/rpc"
import { privateKeyToAccount } from "viem/accounts"
import type { Client } from "../core/queries"
import type { Hex } from "../core/schema"

export function loadPrivateKey(): Hex {
  const file = process.env.MIRRORLEASE_KEY_FILE
  let raw = process.env.MIRRORLEASE_PRIVATE_KEY
  if (!raw && file) raw = readFileSync(file, "utf8")
  if (!raw) {
    throw new Error("this command signs a transaction: set MIRRORLEASE_KEY_FILE=/path/to/key or MIRRORLEASE_PRIVATE_KEY")
  }
  const k = raw.trim()
  const hex = (k.startsWith("0x") ? k : `0x${k}`) as Hex
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error("the key is not a 32-byte hex private key")
  return hex
}

export type Signer = { wallet: WalletArkivClient; address: Hex }

export function makeSigner(rpcUrl: string): Signer {
  const account = privateKeyToAccount(loadPrivateKey())
  const wallet = createWalletClient({ chain: tiramisu, transport: arkivHttp(rpcUrl), account }) as unknown as WalletArkivClient
  return { wallet, address: account.address.toLowerCase() as Hex }
}

export type GasRecord = { op: string; txHash: Hash; gasUsed: bigint; costWei: bigint }

/**
 * Reads the receipt for gas used and price paid. If MIRRORLEASE_GAS_LOG is set, appends a markdown
 * table row there, which is how the numbers in the friction report were collected.
 */
export async function recordGas(client: Client, op: string, txHash: Hash): Promise<GasRecord> {
  const receipt = await client.getTransactionReceipt({ hash: txHash })
  const costWei = receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n)
  const rec = { op, txHash, gasUsed: receipt.gasUsed, costWei }
  const log = process.env.MIRRORLEASE_GAS_LOG
  if (log) {
    appendFileSync(log, `| ${new Date().toISOString()} | ${op} | ${receipt.gasUsed} | ${formatEther(costWei)} | ${txHash} |\n`)
  }
  return rec
}
