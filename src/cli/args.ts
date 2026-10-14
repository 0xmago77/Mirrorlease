// A small argv parser: positionals, --flag value, --flag=value, and boolean flags.

export type Parsed = { positionals: string[]; flags: Map<string, string | true> }

export function parseArgs(argv: string[], booleans: ReadonlySet<string>): Parsed {
  const positionals: string[] = []
  const flags = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--") {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=")
      if (eq > 0) {
        flags.set(a.slice(2, eq), a.slice(eq + 1))
      } else {
        const name = a.slice(2)
        const next = argv[i + 1]
        if (booleans.has(name) || next === undefined || next.startsWith("--")) flags.set(name, true)
        else {
          flags.set(name, next)
          i++
        }
      }
    } else positionals.push(a)
  }
  return { positionals, flags }
}

export class Args {
  constructor(readonly p: Parsed) {}
  pos(i: number, what: string): string {
    const v = this.p.positionals[i]
    if (v === undefined) throw new UsageError(`missing ${what}`)
    return v
  }
  optPos(i: number): string | undefined {
    return this.p.positionals[i]
  }
  str(name: string, envFallback?: string): string | undefined {
    const v = this.p.flags.get(name)
    if (typeof v === "string") return v
    if (v === true) throw new UsageError(`--${name} needs a value`)
    return envFallback ? process.env[envFallback] || undefined : undefined
  }
  req(name: string, envFallback?: string): string {
    const v = this.str(name, envFallback)
    if (v === undefined) throw new UsageError(`missing --${name}${envFallback ? ` (or ${envFallback})` : ""}`)
    return v
  }
  num(name: string): number | undefined {
    const v = this.str(name)
    if (v === undefined) return undefined
    const n = Number(v)
    if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number`)
    return n
  }
  bool(name: string): boolean {
    return this.p.flags.get(name) === true || this.p.flags.get(name) === "true"
  }
}

export class UsageError extends Error {}
