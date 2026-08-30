// Review P3: dispatch() was a hand-written switch listing the same tools as
// TOOL_META. Two parallel lists drift, and the drift fails SILENTLY in the
// dangerous direction — a tool the Policy Engine authorises but dispatch does
// not implement returns the generic "не понял запрос" instead of running, with
// nothing logged as an error.
//
// dispatch() is now a registry, so the two lists can be compared mechanically.
// These tests are the mechanism.

import { describe, expect, it } from "vitest";
import { TOOL_HANDLERS } from "@/lib/agent/run";
import { TOOL_META, uiToolCatalog } from "@/lib/agent/tool-meta";

describe("tool registry <-> TOOL_META consistency (review P3)", () => {
  it("every tool declared in TOOL_META has a handler", () => {
    const missing = Object.keys(TOOL_META).filter((name) => typeof TOOL_HANDLERS[name] !== "function");
    // A tool here is reachable, authorised and advertised to the LLM, but does
    // nothing when invoked.
    expect(missing).toEqual([]);
  });

  it("every handler is declared in TOOL_META", () => {
    // A handler here is executable without a write/read classification and
    // without an RBAC action class — toolToAction() would default it to
    // "read", so a write could run under read permissions.
    const undeclared = Object.keys(TOOL_HANDLERS).filter((name) => !TOOL_META[name]);
    expect(undeclared).toEqual([]);
  });

  it("the registry is not accidentally empty or truncated", () => {
    // Guards against a refactor that leaves the object literal partially
    // populated: both lists must be non-trivial and identical in size.
    expect(Object.keys(TOOL_HANDLERS).length).toBeGreaterThanOrEqual(15);
    expect(Object.keys(TOOL_HANDLERS).length).toBe(Object.keys(TOOL_META).length);
  });

  it("the /agent catalogue covers every user-facing tool", () => {
    // The panel was a third hand-written list and had drifted: it advertised
    // 12 tools out of 17, hiding set_campaign_status, list_recommendations and
    // help. It is now derived from TOOL_META — this pins that every tool a
    // user can invoke is actually advertised.
    const shown = new Set(uiToolCatalog().map((t) => t.name));
    const internal = new Set(["fallback"]); // plumbing, never advertised
    const hidden = Object.keys(TOOL_META).filter((n) => !shown.has(n) && !internal.has(n));
    expect(hidden).toEqual([]);
  });

  it("the catalogue advertises nothing the agent cannot run", () => {
    for (const t of uiToolCatalog()) {
      expect(typeof TOOL_HANDLERS[t.name], `advertised tool ${t.name} has no handler`).toBe("function");
      expect(t.ui.desc.length).toBeGreaterThan(0);
      expect(t.ui.platforms.length).toBeGreaterThan(0);
    }
  });

  it("reads are listed before writes in the catalogue", () => {
    // Writes carry an "изменяет" badge; grouping them keeps the destructive
    // half of the list visually together instead of interleaved with reads.
    const kinds = uiToolCatalog().map((t) => t.kind);
    expect(kinds).toEqual([...kinds].sort((a, b) => (a === "read" ? 0 : 1) - (b === "read" ? 0 : 1)));
  });

  it("every write tool in TOOL_META is executable", () => {
    const writes = Object.values(TOOL_META).filter((m) => m.kind === "write");
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      expect(typeof TOOL_HANDLERS[w.name], `write tool ${w.name} has no handler`).toBe("function");
    }
  });
});
