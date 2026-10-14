import { describe, expect, it } from "vitest"
import { buildTrust, roleOf, signersFor } from "../src/core/trust"
import { app, EVIL, MAINT, PUB } from "./fixtures"

describe("trust pinning", () => {
  it("trusts only the pinned creator when there is no handoff", () => {
    const t = buildTrust(PUB, [app(PUB)])
    expect(roleOf(t, PUB, "demo")).toBe("publisher")
    expect(roleOf(t, MAINT, "demo")).toBeNull()
    expect(signersFor(t, "demo")).toEqual([PUB])
  })

  it("is case-insensitive about the pinned address", () => {
    const t = buildTrust(PUB.toUpperCase().replace("0X", "0x"), [app(PUB)])
    expect(roleOf(t, PUB, "demo")).toBe("publisher")
  })

  it("accepts the current owner of an app entity the publisher created (handoff)", () => {
    const t = buildTrust(PUB, [app(PUB, MAINT)])
    expect(roleOf(t, MAINT, "demo")).toBe("maintainer")
    expect(roleOf(t, PUB, "demo")).toBe("publisher")
    expect(signersFor(t, "demo")).toEqual([PUB, MAINT])
  })

  it("scopes a maintainer to the app that was handed over", () => {
    const t = buildTrust(PUB, [app(PUB, MAINT, "demo")])
    expect(roleOf(t, MAINT, "other-app")).toBeNull()
  })

  it("ignores app entities created by anyone else, even if they name the pinned owner", () => {
    // EVIL creates an app entity with the same id and hands it to itself: not trusted.
    const t = buildTrust(PUB, [app(EVIL, EVIL), app(EVIL, PUB)])
    expect(t.apps.size).toBe(0)
    expect(roleOf(t, EVIL, "demo")).toBeNull()
  })

  it("an app entity handed to someone else does not stop the founder from publishing", () => {
    const t = buildTrust(PUB, [app(PUB, MAINT)])
    expect(roleOf(t, PUB, "demo")).toBe("publisher")
  })
})
