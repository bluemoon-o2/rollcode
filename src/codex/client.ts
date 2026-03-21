import { EventEmitter } from "node:events";
import type {
  CommandExecutionRecord,
  TurnArtifacts,
  TurnPlanStep,
} from "../domain/types";

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type JsonObject = Record<string, unknown>;
type ThreadReadResult = JsonObject & {
  turns?: unknown[];
};

type NotificationListener = (method: string, params: unknown) => void;

interface ToolRequestUserInputAnswer {
  answers: string[];
}

type CollaborationModeKind = "default" | "plan";

interface TurnCollectorState {
  finalMessage: string;
  plan: TurnPlanStep[];
  diff: string;
  commandOutput: string;
  commandExecutions: CommandExecutionRecord[];
}

function decodeBytes(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function asJsonObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as JsonObject;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function buildUserInput(text: string) {
  return [{ type: "text", text, text_elements: [] }];
}

function normalizePlan(plan: unknown[]): TurnPlanStep[] {
  return plan.map((item) => ({
    step: String(
      asJsonObject(item)?.step ??
        asJsonObject(item)?.description ??
        "Unnamed step",
    ),
    status: (() => {
      const status = asJsonObject(item)?.status;
      return status === "completed" ||
        status === "in_progress" ||
        status === "pending"
        ? status
        : "pending";
    })(),
  }));
}

function buildAutoUserInputAnswers(
  params: unknown,
): Record<string, ToolRequestUserInputAnswer> {
  const payload = asJsonObject(params);
  const rawQuestions = Array.isArray(payload?.questions) ? payload.questions : [];
  const answers: Record<string, ToolRequestUserInputAnswer> = {};
  for (const questionRaw of rawQuestions) {
    const question = asJsonObject(questionRaw);
    const id = String(question?.id ?? "").trim();
    if (!id) {
      continue;
    }
    const options = Array.isArray(question?.options) ? question.options : [];
    const firstOption = asJsonObject(options[0]);
    const firstLabel = String(firstOption?.label ?? "").trim();
    answers[id] = {
      answers: [firstLabel || "Proceed with the default option."],
    };
  }
  return answers;
}

class TurnCollector {
  readonly threadId: string;
  readonly turnId: string;
  readonly state: TurnCollectorState;
  readonly done: Promise<void>;
  private resolveDone!: () => void;
  private rejectDone!: (error: Error) => void;
  private commandExecutionIndices = new Map<string, number>();
  private commandExecutionFallbackCounter = 0;

  constructor(threadId: string, turnId: string) {
    this.threadId = threadId;
    this.turnId = turnId;
    this.state = {
      finalMessage: "",
      plan: [],
      diff: "",
      commandOutput: "",
      commandExecutions: [],
    };
    this.done = new Promise<void>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
  }

  apply(method: string, params: unknown): void {
    const payload = asJsonObject(params);
    if (!payload || payload.threadId !== this.threadId) {
      return;
    }
    if (
      payload.turnId !== undefined &&
      String(payload.turnId) !== this.turnId
    ) {
      return;
    }

    switch (method) {
      case "item/started": {
        const item = asJsonObject(payload.item);
        if (item?.type === "commandExecution") {
          this.onCommandStarted(item, payload);
        }
        return;
      }
      case "item/agentMessage/delta": {
        this.state.finalMessage += String(payload.delta ?? "");
        return;
      }
      case "item/completed": {
        const item = asJsonObject(payload.item);
        if (item?.type === "agentMessage" && typeof item.text === "string") {
          this.state.finalMessage = item.text;
        }
        if (item?.type === "commandExecution") {
          this.onCommandCompleted(item, payload);
          const command = String(item.command ?? "").trim();
          if (command) {
            this.state.commandOutput += `$ ${command}\n`;
          }
          if (typeof item.aggregatedOutput === "string") {
            this.state.commandOutput += item.aggregatedOutput;
            if (!item.aggregatedOutput.endsWith("\n")) {
              this.state.commandOutput += "\n";
            }
          }
          this.state.commandOutput += `(exit ${item.exitCode ?? "?"})\n\n`;
        }
        return;
      }
      case "item/commandExecution/outputDelta": {
        this.onCommandOutputDelta(payload);
        return;
      }
      case "turn/plan/updated": {
        this.state.plan = normalizePlan(
          Array.isArray(payload.plan) ? payload.plan : [],
        );
        return;
      }
      case "turn/diff/updated": {
        this.state.diff = String(payload.diff ?? "");
        return;
      }
      case "turn/completed": {
        const turn = asJsonObject(payload.turn);
        const turnError = asJsonObject(turn?.error);
        if (turn?.status === "failed" && turnError) {
          this.rejectDone(
            new Error(String(turnError.message ?? "Turn failed")),
          );
          return;
        }
        this.resolveDone();
        return;
      }
      default:
        return;
    }
  }

  private getCommandKey(
    item: JsonObject | null,
    payload: JsonObject | null,
    command?: string,
  ): string {
    const raw =
      payload?.itemId ??
      payload?.commandExecutionId ??
      item?.id ??
      payload?.id ??
      "";
    const key = String(raw || "").trim();
    if (key) {
      return `id:${key}`;
    }
    this.commandExecutionFallbackCounter += 1;
    const fallbackCommand = (command || "command").trim() || "command";
    return `fallback:${fallbackCommand}:${this.commandExecutionFallbackCounter}`;
  }

  private getExitCode(rawExitCode: unknown): number | null {
    if (typeof rawExitCode === "number" && Number.isFinite(rawExitCode)) {
      return rawExitCode;
    }
    return null;
  }

  private ensureCommandRecord(
    key: string,
    command: string,
  ): CommandExecutionRecord {
    const existingIndex = this.commandExecutionIndices.get(key);
    if (existingIndex !== undefined) {
      return this.state.commandExecutions[existingIndex] as CommandExecutionRecord;
    }
    const record: CommandExecutionRecord = {
      id: key,
      command: command || "command",
      output: "",
      phase: "running",
    };
    this.state.commandExecutions.push(record);
    this.commandExecutionIndices.set(key, this.state.commandExecutions.length - 1);
    return record;
  }

  private pickRecordForDelta(payload: JsonObject): CommandExecutionRecord | null {
    const payloadKeyRaw =
      payload.itemId ?? payload.commandExecutionId ?? payload.id ?? "";
    const payloadKey = String(payloadKeyRaw || "").trim();
    if (payloadKey) {
      const directKey = `id:${payloadKey}`;
      const directIndex = this.commandExecutionIndices.get(directKey);
      if (directIndex !== undefined) {
        return this.state.commandExecutions[directIndex] as CommandExecutionRecord;
      }
    }
    for (let index = this.state.commandExecutions.length - 1; index >= 0; index -= 1) {
      const entry = this.state.commandExecutions[index] as CommandExecutionRecord;
      if (entry.phase === "running") {
        return entry;
      }
    }
    return null;
  }

  private onCommandStarted(item: JsonObject, payload: JsonObject): void {
    const command = String(item.command ?? "").trim();
    const key = this.getCommandKey(item, payload, command);
    const record = this.ensureCommandRecord(key, command);
    if (command) {
      record.command = command;
    }
    record.phase = "running";
    record.success = undefined;
    record.exitCode = undefined;
  }

  private onCommandOutputDelta(payload: JsonObject): void {
    const delta = String(payload.delta ?? "");
    if (!delta) {
      return;
    }
    const record = this.pickRecordForDelta(payload);
    if (!record) {
      return;
    }
    record.output += delta;
  }

  private onCommandCompleted(item: JsonObject, payload: JsonObject): void {
    const command = String(item.command ?? "").trim();
    const key = this.getCommandKey(item, payload, command);
    const record = this.ensureCommandRecord(key, command);
    if (command) {
      record.command = command;
    }
    if (!record.output && typeof item.aggregatedOutput === "string") {
      record.output = item.aggregatedOutput;
    }
    const exitCode = this.getExitCode(item.exitCode);
    record.phase = "finished";
    record.exitCode = exitCode;
    record.success = exitCode === 0;
  }
}

export class CodexAppServerClient {
  private process: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private seq = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason?: unknown) => void;
    }
  >();
  private notifications = new EventEmitter();
  private initialized = false;
  private initializePromise: Promise<void> | null = null;
  private stderrLines: string[] = [];

  async start(): Promise<void> {
    if (this.process) {
      return;
    }

    this.process = Bun.spawn(["codex", "app-server", "--listen", "stdio://"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    void this.readStdout();
    void this.readStderr();
    void this.watchExit();
  }

  async dispose(): Promise<void> {
    const process = this.process;
    if (!process) {
      return;
    }
    const pid = process.pid;
    const error = new Error("codex app-server disposed");
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();

    this.process = null;
    this.initialized = false;
    this.initializePromise = null;

    await this.terminateProcessTree(pid);
  }

  onNotification(listener: NotificationListener): () => void {
    this.notifications.on("notification", listener);
    return () => this.notifications.off("notification", listener);
  }

  getDiagnostics(): string[] {
    return [...this.stderrLines];
  }

  async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (!this.initializePromise) {
      this.initializePromise = (async () => {
        await this.start();
        await this.request("initialize", {
          clientInfo: {
            name: "rollcode",
            version:
              typeof ROLLCODE_VERSION !== "undefined"
                ? ROLLCODE_VERSION
                : "dev",
          },
          capabilities: {
            experimentalApi: true,
          },
        });
        this.initialized = true;
      })();
    }
    await this.initializePromise;
  }

  async startThread(params: {
    cwd: string;
    baseInstructions: string;
    developerInstructions: string;
  }): Promise<string> {
    await this.ensureInitialized();
    const result = await this.request("thread/start", {
      cwd: params.cwd,
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      baseInstructions: params.baseInstructions,
      developerInstructions: params.developerInstructions,
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });
    const resultRecord = asJsonObject(result);
    const thread = asJsonObject(resultRecord?.thread);
    const threadId = thread?.id;
    if (threadId === undefined || threadId === null) {
      throw new Error("thread/start response missing thread id");
    }
    return String(threadId);
  }

  async resumeThread(params: {
    threadId: string;
    cwd: string;
    baseInstructions: string;
    developerInstructions: string;
  }): Promise<string> {
    await this.ensureInitialized();
    const result = await this.request("thread/resume", {
      threadId: params.threadId,
      cwd: params.cwd,
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      baseInstructions: params.baseInstructions,
      developerInstructions: params.developerInstructions,
      persistExtendedHistory: true,
    });
    const resultRecord = asJsonObject(result);
    const thread = asJsonObject(resultRecord?.thread);
    const threadId = thread?.id;
    if (threadId === undefined || threadId === null) {
      throw new Error("thread/resume response missing thread id");
    }
    return String(threadId);
  }

  async readThread(threadId: string): Promise<ThreadReadResult> {
    await this.ensureInitialized();
    const result = await this.request("thread/read", {
      threadId,
      includeTurns: true,
    });
    const resultRecord = (asJsonObject(result) ?? {}) as ThreadReadResult;
    const nestedThread = asJsonObject(resultRecord.thread);
    return nestedThread ? (nestedThread as ThreadReadResult) : resultRecord;
  }

  async runStructuredTurn<T>(params: {
    threadId: string;
    input: string;
    outputSchema: unknown;
    mode?: CollaborationModeKind;
    onNotification?: NotificationListener;
  }): Promise<TurnArtifacts & { parsed: T }> {
    await this.ensureInitialized();
    const response = await this.request("turn/start", {
      threadId: params.threadId,
      input: buildUserInput(params.input),
      outputSchema: params.outputSchema,
      mode: params.mode,
    });
    const responseRecord = asJsonObject(response);
    const startedTurn = asJsonObject(responseRecord?.turn);
    const turnIdValue = startedTurn?.id;
    if (turnIdValue === undefined || turnIdValue === null) {
      throw new Error("turn/start response missing turn id");
    }
    const turnId = String(turnIdValue);
    const collector = new TurnCollector(params.threadId, turnId);

    const unsubscribe = this.onNotification((method, notificationParams) => {
      params.onNotification?.(method, notificationParams);
      collector.apply(method, notificationParams);
    });

    try {
      await collector.done;
    } finally {
      unsubscribe();
    }

    const thread = await this.readThread(params.threadId);
    const completedTurn = (thread.turns ?? []).find(
      (candidate) => String(asJsonObject(candidate)?.id ?? "") === turnId,
    );
    const completedTurnRecord = asJsonObject(completedTurn);
    const items = Array.isArray(completedTurnRecord?.items)
      ? ((completedTurnRecord.items ?? []) as unknown[])
      : [];
    const fallbackMessage = this.extractFinalMessage(items);
    const finalMessage = collector.state.finalMessage || fallbackMessage;
    if (!finalMessage) {
      throw new Error(`Turn ${turnId} completed without a final message`);
    }
    return {
      turnId,
      finalMessage,
      parsed: JSON.parse(finalMessage) as T,
      plan: collector.state.plan,
      diff: collector.state.diff,
      commandOutput: collector.state.commandOutput,
      commandExecutions: collector.state.commandExecutions.map((entry) => ({
        ...entry,
      })),
      items,
    };
  }

  async steerTurn(
    threadId: string,
    turnId: string,
    input: string,
  ): Promise<void> {
    await this.ensureInitialized();
    await this.request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: buildUserInput(input),
    });
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.ensureInitialized();
    await this.request("turn/interrupt", { threadId, turnId });
  }

  async reloadSkills(cwd: string): Promise<unknown> {
    await this.ensureInitialized();
    return await this.request("skills/list", {
      cwds: [cwd],
      forceReload: true,
    });
  }

  async setSkillEnabled(path: string, enabled: boolean): Promise<void> {
    await this.ensureInitialized();
    await this.request("skills/config/write", { path, enabled });
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    await this.start();
    const requestId = ++this.seq;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method,
      params,
    });

    const process = this.process;
    if (!process || !process.stdin) {
      throw new Error("codex app-server is not running");
    }

    const pending = new Promise<unknown>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
    });

    process.stdin.write(`${payload}\n`);
    return await pending;
  }

  private async readStdout(): Promise<void> {
    const process = this.process;
    if (!process?.stdout) {
      return;
    }
    const reader = process.stdout.getReader();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decodeBytes(value);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        this.handleStdoutLine(trimmed);
      }
    }
  }

  private async readStderr(): Promise<void> {
    const process = this.process;
    if (!process?.stderr) {
      return;
    }
    const reader = process.stderr.getReader();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decodeBytes(value);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          this.stderrLines.push(trimmed);
        }
      }
    }
  }

  private async watchExit(): Promise<void> {
    const process = this.process;
    if (!process) {
      return;
    }
    const exitCode = await process.exited;
    const error = new Error(`codex app-server exited with code ${exitCode}`);
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    this.process = null;
    this.initialized = false;
    this.initializePromise = null;
  }

  private async terminateProcessTree(rootPid: number): Promise<void> {
    const tree = this.collectProcessTree(rootPid);
    if (tree.length === 0) {
      return;
    }

    this.killProcessList(tree, "SIGTERM");
    await Bun.sleep(120);

    const stillAlive = tree.filter((pid) => isPidAlive(pid));
    if (stillAlive.length > 0) {
      this.killProcessList(stillAlive, "SIGKILL");
    }
  }

  private collectProcessTree(rootPid: number): number[] {
    const seen = new Set<number>();
    const queue = [rootPid];
    while (queue.length > 0) {
      const pid = queue.shift() as number;
      if (seen.has(pid) || !Number.isFinite(pid) || pid <= 1) {
        continue;
      }
      seen.add(pid);
      const children = this.listChildPids(pid);
      for (const child of children) {
        if (!seen.has(child)) {
          queue.push(child);
        }
      }
    }
    return [...seen];
  }

  private listChildPids(parentPid: number): number[] {
    const result = Bun.spawnSync(
      ["ps", "-o", "pid=", "--ppid", String(parentPid)],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (result.exitCode !== 0 || !result.stdout) {
      return [];
    }
    return decodeBytes(result.stdout)
      .split("\n")
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((value) => Number.isFinite(value) && value > 1);
  }

  private killProcessList(pids: number[], signal: NodeJS.Signals): void {
    const ordered = [...pids].sort((left, right) => right - left);
    for (const pid of ordered) {
      try {
        process.kill(pid, signal);
      } catch {
        // Best effort cleanup.
      }
    }
  }

  private handleStdoutLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.stderrLines.push(line);
      return;
    }

    if (
      message.id !== undefined &&
      ("result" in message || "error" in message)
    ) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) {
        return;
      }
      this.pending.delete(Number(message.id));
      if (message.error) {
        pending.reject(new Error(message.error.message));
        return;
      }
      pending.resolve(message.result);
      return;
    }

    if (message.method && message.id !== undefined) {
      void this.handleServerRequest(message.id, message.method, message.params);
      return;
    }

    if (message.method) {
      this.notifications.emit("notification", message.method, message.params);
    }
  }

  private async handleServerRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): Promise<void> {
    let result: unknown;
    switch (method) {
      case "item/commandExecution/requestApproval":
        result = { decision: "acceptForSession" };
        break;
      case "item/fileChange/requestApproval":
        result = { decision: "acceptForSession" };
        break;
      case "item/tool/requestUserInput":
        result = {
          answers: buildAutoUserInputAnswers(params),
        };
        break;
      case "execCommandApproval":
      case "applyPatchApproval":
        result = { decision: "approved_for_session" };
        break;
      default:
        result = { decision: "cancel" };
        break;
    }

    const process = this.process;
    if (!process?.stdin) {
      return;
    }
    process.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id,
        result,
      })}\n`,
    );
    this.notifications.emit("notification", "serverRequest/handled", {
      method,
      params,
      result,
    });
  }

  private extractFinalMessage(items: unknown[]): string {
    const reversed = [...items].reverse();
    const agentMessage = reversed.find((item) => {
      const candidate = item as { type?: string };
      return candidate.type === "agentMessage";
    }) as { text?: string } | undefined;
    return agentMessage?.text ?? "";
  }
}
