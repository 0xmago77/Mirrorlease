// Terminal output: colour only when stdout is a TTY, and a --json mode that prints one object.

const tty = process.stdout.isTTY && !process.env.NO_COLOR
const wrap = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s)

export const c = {
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  cyan: wrap("36"),
}

export function chip(label: string, tone: "good" | "bad" | "warn" | "info"): string {
  const t = { good: c.green, bad: c.red, warn: c.yellow, info: c.cyan }[tone]
  return t(`[${label}]`)
}

/** JSON.stringify that writes bigints as strings and drops Uint8Arrays. */
export function toJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_k, v) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? `<${v.byteLength} bytes>` : v),
    2,
  )
}

export function line(s = ""): void {
  process.stdout.write(`${s}\n`)
}

export function err(s: string): void {
  process.stderr.write(`${s}\n`)
}
