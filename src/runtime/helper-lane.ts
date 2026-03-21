import { CodexAppServerClient } from "../codex/client";
import { isWorkerTurnOutput, WORKER_TURN_SCHEMA } from "../codex/schemas";
import type { TurnArtifacts, WorkerTurnOutput } from "../domain/types";
import { readTextIfExists, writeText } from "../utils/fs";

export interface InternalHelperLaneRequest {
  threadId: string;
  input: string;
  mode?: "default" | "plan";
}

export type InternalHelperLaneResponse =
  | {
      ok: true;
      artifacts: TurnArtifacts & { parsed: WorkerTurnOutput };
    }
  | {
      ok: false;
      error: string;
    };

function normalizeRequest(value: unknown): InternalHelperLaneRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.threadId !== "string" ||
    !candidate.threadId.trim() ||
    typeof candidate.input !== "string"
  ) {
    return null;
  }
  return {
    threadId: candidate.threadId.trim(),
    input: candidate.input,
    mode: candidate.mode === "plan" ? "plan" : "default",
  };
}

async function writeResponse(
  responsePath: string,
  response: InternalHelperLaneResponse,
): Promise<void> {
  await writeText(responsePath, `${JSON.stringify(response, null, 2)}\n`);
}

export async function runInternalHelperLaneCommand(args: {
  requestPath: string;
  responsePath: string;
}): Promise<number> {
  const requestRaw = await readTextIfExists(args.requestPath);
  if (!requestRaw) {
    await writeResponse(args.responsePath, {
      ok: false,
      error: `request file not found: ${args.requestPath}`,
    });
    return 2;
  }

  let request: InternalHelperLaneRequest | null = null;
  try {
    request = normalizeRequest(JSON.parse(requestRaw));
  } catch {
    request = null;
  }
  if (!request) {
    await writeResponse(args.responsePath, {
      ok: false,
      error: "invalid helper lane request payload",
    });
    return 2;
  }

  const codex = new CodexAppServerClient();
  try {
    const artifacts = await codex.runStructuredTurn<WorkerTurnOutput>({
      threadId: request.threadId,
      input: request.input,
      outputSchema: WORKER_TURN_SCHEMA,
      mode: request.mode ?? "default",
    });
    if (!isWorkerTurnOutput(artifacts.parsed)) {
      await writeResponse(args.responsePath, {
        ok: false,
        error: "helper lane output did not match WorkerTurnOutput",
      });
      return 2;
    }
    await writeResponse(args.responsePath, {
      ok: true,
      artifacts,
    });
    return 0;
  } catch (error) {
    await writeResponse(args.responsePath, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return 1;
  } finally {
    await codex.dispose();
  }
}
