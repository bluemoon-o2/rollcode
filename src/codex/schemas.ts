import type { SupervisorDecision, WorkerTurnOutput } from "../domain/types";

export const WORKER_TURN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["userMessage", "handoff"],
  properties: {
    userMessage: { type: "string" },
    handoff: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "evidence", "unresolved", "completionClaim"],
      properties: {
        summary: { type: "string" },
        evidence: {
          type: "array",
          items: { type: "string" },
        },
        unresolved: {
          type: "array",
          items: { type: "string" },
        },
        completionClaim: { type: "boolean" },
      },
    },
  },
} as const;

const SUPERVISOR_DECISION_PROPERTIES = {
  action: {
    type: "string",
    enum: ["continue", "repair", "complete", "blocked"],
  },
  rationale: { type: "string" },
  nextInstruction: { type: "string" },
  memoryAction: {
    type: "string",
    enum: ["none", "review", "consolidate"],
  },
} as const;

export const SUPERVISOR_DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  // Keep fields fully required to avoid optional-field schema instability
  // observed on some custom Responses-compatible gateways.
  required: ["action", "rationale", "nextInstruction", "memoryAction"],
  properties: SUPERVISOR_DECISION_PROPERTIES,
} as const;

export const SUPERVISOR_DECISION_SCHEMA_LEGACY = {
  type: "object",
  additionalProperties: false,
  // Compatibility schema for older supervisor payloads that omit
  // nextInstruction on complete/blocked decisions.
  required: ["action", "rationale", "memoryAction"],
  properties: SUPERVISOR_DECISION_PROPERTIES,
} as const;

export function isWorkerTurnOutput(value: unknown): value is WorkerTurnOutput {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const handoff = candidate.handoff as Record<string, unknown> | undefined;
  return (
    typeof candidate.userMessage === "string" &&
    Boolean(handoff) &&
    typeof handoff?.summary === "string" &&
    Array.isArray(handoff?.evidence) &&
    Array.isArray(handoff?.unresolved) &&
    typeof handoff?.completionClaim === "boolean"
  );
}

export function isSupervisorDecision(
  value: unknown,
): value is SupervisorDecision {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.action === "string" &&
    typeof candidate.rationale === "string" &&
    typeof candidate.memoryAction === "string"
  );
}
