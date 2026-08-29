// Invariant test for the single source of truth (src/lib/agent/tool-meta.ts).
//
// Regression guard for review M1: previously WRITE_TOOLS (router.ts) and
// toolToAction (policy.ts) were two independent maps. A new write tool added to
// LLM_TOOLS but forgotten in one of them would silently run as a "read"
// (no RBAC gate, no approval). This makes that impossible by construction.

import { describe, expect, it } from "vitest";
import { TOOL_META, WRITE_TOOLS, toolToAction, isWriteTool } from "@/lib/agent/tool-meta";
import { KNOWN_TOOLS } from "@/lib/agent/tools-schema";
import { scopeForAction } from "@/lib/agent/scopes";
import type { Action } from "@/lib/agent/rbac";

// The execute_* actions (mirrors rbac.ts EXECUTE_ACTIONS): a write tool must
// never be classified as a "read"-style action.
const EXECUTE_ACTIONS: Action[] = [
  "execute_campaign_status",
  "execute_bids",
  "execute_budget",
  "execute_promotion",
  "execute_negative",
];

describe("TOOL_META invariants", () => {
  it("every tool the LLM can call (KNOWN_TOOLS) has exactly one TOOL_META entry", () => {
    for (const name of KNOWN_TOOLS) {
      expect(TOOL_META[name], `missing TOOL_META for ${name}`).toBeTruthy();
      expect(TOOL_META[name].name).toBe(name);
    }
  });

  it("WRITE_TOOLS is exactly the set of tools marked kind=write", () => {
    const writes = Object.values(TOOL_META).filter((m) => m.kind === "write").map((m) => m.name);
    expect([...WRITE_TOOLS].sort()).toEqual(writes.sort());
  });

  it("a write tool is never classified as a read action (R1)", () => {
    for (const meta of Object.values(TOOL_META)) {
      if (meta.kind === "write") {
        expect(meta.action, `write tool ${meta.name} must not map to read`).not.toBe("read");
        expect(isWriteTool(meta.name)).toBe(true);
        // A write must map to one of the execute_* actions (never recommend/read).
        expect(EXECUTE_ACTIONS).toContain(meta.action);
      } else {
        expect(isWriteTool(meta.name), `read tool ${meta.name} must not be write`).toBe(false);
      }
    }
  });

  it("toolToAction is consistent with the meta table", () => {
    for (const meta of Object.values(TOOL_META)) {
      expect(toolToAction(meta.name)).toBe(meta.action);
    }
  });

  it("every write action maps to a non-read capability scope", () => {
    for (const meta of Object.values(TOOL_META)) {
      if (meta.kind !== "write") continue;
      const scope = scopeForAction(meta.action);
      expect(scope, `write tool ${meta.name} → scope ${scope}`).not.toBe("read");
    }
  });
});
