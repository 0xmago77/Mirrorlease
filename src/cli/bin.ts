// Entry point. Node >= 25 warns when anything touches globalThis.localStorage, and the Arkiv SDK's
// debug logger checks it at import time; drop just that warning so CLI output stays clean.
const emit = process.emitWarning.bind(process)
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message
  if (text.includes("localStorage")) return
  return (emit as (...a: unknown[]) => void)(warning, ...rest)
}) as typeof process.emitWarning

// "lifeboat status ... | head" closes the pipe early; that is not an error worth a stack trace.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0)
  throw e
})

await import("./main")
export {}
