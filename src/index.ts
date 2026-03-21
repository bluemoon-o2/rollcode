#!/usr/bin/env bun
import { parseArgs, renderHelp } from "./cli";
import {
  getCodexSkillsMirrorDir,
  getRollcodeHome,
  getStatePath,
} from "./config";
import { MemoryManager } from "./memory/manager";
import { checkReleaseNotes } from "./release-notes";
import { formatDoctorReport, runRuntimeDoctor } from "./runtime/doctor";
import { runInternalHelperLaneCommand } from "./runtime/helper-lane";
import { RollcodeService } from "./runtime/service";
import { runRollcodeLauncher } from "./tui/launcher-runtime";
import {
  runResumePickerUi,
  runRollcodeSessionUi,
  type SessionExitReason,
} from "./tui/session-runtime";
import { getVersion } from "./version";

function printInfo(cwd = process.cwd()): void {
  console.log(`RollCode ${getVersion()}`);
  console.log("");
  console.log("mode: rollcode-runtime");
  console.log(`cwd: ${cwd}`);
  console.log(`home: ${getRollcodeHome()}`);
  console.log(`state: ${getStatePath()}`);
  console.log(`codex-skills-mirror: ${getCodexSkillsMirrorDir()}`);
}

function resolveRunByRef(service: RollcodeService, cwd: string, ref: string) {
  const normalized = ref.trim();
  if (!normalized) {
    return null;
  }
  const currentAgent = service.store.getAgentByCwd(cwd);
  const preferredRuns = currentAgent
    ? service.store.listRuns(currentAgent.id, 400)
    : [];
  const allRuns = service.store.listRuns(undefined, 400);
  const match = (runs: ReturnType<typeof service.store.listRuns>) =>
    runs.find((run) => run.id === normalized) ??
    runs.find((run) => run.id.startsWith(normalized));
  return match(preferredRuns) ?? match(allRuns) ?? null;
}

function buildResumeOptions(service: RollcodeService, cwd: string) {
  const agents = service.listAgents();
  const agentNameById = new Map(agents.map((agent) => [agent.id, agent.name]));
  const currentAgent = service.store.getAgentByCwd(cwd);
  const preferredRuns = currentAgent
    ? service.store.listRuns(currentAgent.id, 120)
    : [];
  const allRuns = service.store.listRuns(undefined, 120);
  const toOption = (run: (typeof allRuns)[number]) => ({
    run,
    agentName: agentNameById.get(run.agentId) ?? run.agentId,
  });
  return {
    preferredOptions: preferredRuns.map(toOption),
    allOptions: allRuns.map(toOption),
  };
}

async function openRunSession(
  service: RollcodeService,
  runId: string,
): Promise<SessionExitReason> {
  const controller = await service.openSessionForRun(runId);
  return runRollcodeSessionUi(controller);
}

async function openSessionFromResume(
  service: RollcodeService,
  cwd: string,
  runRef?: string,
): Promise<SessionExitReason | null> {
  if (runRef) {
    const resolved = resolveRunByRef(service, cwd, runRef);
    if (resolved) {
      return openRunSession(service, resolved.id);
    }
    console.error(`[rollcode] no run matches '${runRef}'. Opening picker...`);
  }

  const options = buildResumeOptions(service, cwd);
  if (options.allOptions.length === 0) {
    console.error("[rollcode] no saved runs found.");
    return null;
  }

  if (!process.stdin.isTTY) {
    const fallback = options.preferredOptions[0] ?? options.allOptions[0];
    return openRunSession(service, fallback.run.id);
  }

  const selectedRunId = await runResumePickerUi(options);
  if (!selectedRunId) {
    return null;
  }
  return openRunSession(service, selectedRunId);
}

async function printAgentsSummary(
  service: RollcodeService,
  cwd: string,
): Promise<void> {
  const agents = service.listAgents();
  if (agents.length === 0) {
    console.log("No agents yet.");
    return;
  }
  const currentAgent = service.store.getAgentByCwd(cwd);
  const currentAgentId = currentAgent?.id;
  console.log(`Agents (${agents.length}):`);
  for (const agent of agents.slice(0, 20)) {
    const latestRun = service.store.getLatestRun(agent.id);
    const runSummary = latestRun
      ? `run=${latestRun.id} status=${latestRun.status} turns=${latestRun.workerTurnCount}`
      : "run=none";
    console.log(
      `- ${agent.id}  name=${agent.name}  cwd=${agent.cwd}${
        agent.id === currentAgentId ? "  [current]" : ""
      }  ${runSummary}`,
    );
  }
}

async function runMemoryCommand(
  service: RollcodeService,
  args: { action: "status" | "diff" | "log"; agentId?: string },
  cwd: string,
): Promise<void> {
  const agent =
    (args.agentId ? service.store.getAgentById(args.agentId) : null) ??
    service.store.getAgentByCwd(cwd);
  if (!agent) {
    console.error("[rollcode] no agent found. Start a run first.");
    process.exitCode = 2;
    return;
  }

  const memory = new MemoryManager(agent.id);
  await memory.ensureInitialized(agent.cwd);

  if (args.action === "status") {
    console.log(await memory.status());
    return;
  }
  if (args.action === "diff") {
    console.log(memory.diff() || "(no diff)");
    return;
  }
  console.log(memory.log() || "(no commits)");
}

async function launchFromStartupPage(service: RollcodeService): Promise<void> {
  const releaseNotes = await checkReleaseNotes(service.store);
  while (true) {
    const result = await runRollcodeLauncher({
      cwd: process.cwd(),
      releaseNotes,
    });
    if (result.type === "exit") {
      return;
    }
    if (result.type === "run") {
      const controller = await service.startInteractiveRun(
        result.goal,
        process.cwd(),
      );
      const sessionExitReason = await runRollcodeSessionUi(controller);
      if (sessionExitReason === "new") {
        continue;
      }
      return;
    }
    if (result.type === "resume") {
      const sessionExitReason = await openSessionFromResume(
        service,
        process.cwd(),
      );
      if (!sessionExitReason) {
        continue;
      }
      if (sessionExitReason === "new") {
        continue;
      }
      if (sessionExitReason === "exit") {
        return;
      }
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();

  switch (args.command) {
    case "help":
      console.log(renderHelp());
      return;
    case "version":
      console.log(`${getVersion()} (RollCode)`);
      return;
    case "info":
      printInfo(cwd);
      return;
    case "internal-helper-lane": {
      const code = await runInternalHelperLaneCommand({
        requestPath: args.requestPath,
        responsePath: args.responsePath,
      });
      if (code !== 0) {
        process.exitCode = code;
      }
      return;
    }
  }

  const service = new RollcodeService();
  try {
    switch (args.command) {
      case "default":
        await launchFromStartupPage(service);
        return;
      case "run":
        if (args.detach) {
          const run = await service.createRun(
            args.goal,
            cwd,
            true,
            args.agentId,
          );
          console.log(
            `[rollcode] detached mode starts background loop in current process for now. runId=${run.id}`,
          );
          await service.runDetachedLoop(run.id);
          return;
        }
        {
          const sessionExitReason = await runRollcodeSessionUi(
            await service.startInteractiveRun(args.goal, cwd, args.agentId),
          );
          if (sessionExitReason === "new") {
            await launchFromStartupPage(service);
          }
        }
        return;
      case "resume":
        {
          const sessionExitReason = await openSessionFromResume(
            service,
            cwd,
            args.runId,
          );
          if (sessionExitReason === "new") {
            await launchFromStartupPage(service);
          }
        }
        return;
      case "attach": {
        const resolved = resolveRunByRef(service, cwd, args.runId);
        if (!resolved) {
          console.error(`[rollcode] run not found: ${args.runId}`);
          process.exitCode = 2;
          return;
        }
        const sessionExitReason = await openRunSession(service, resolved.id);
        if (sessionExitReason === "new") {
          await launchFromStartupPage(service);
        }
        return;
      }
      case "agents":
        await printAgentsSummary(service, cwd);
        return;
      case "memory":
        await runMemoryCommand(service, args, cwd);
        return;
      case "doctor": {
        const report = await runRuntimeDoctor({
          store: service.store,
          fix: args.fix,
        });
        console.log(formatDoctorReport(report));
        if (report.issues.length > 0 && !args.fix) {
          process.exitCode = report.issues.some(
            (issue) => issue.severity === "error",
          )
            ? 1
            : 2;
        }
        return;
      }
      case "internal-run":
        await service.runDetachedLoop(args.runId);
        return;
    }
  } finally {
    await service.dispose();
  }
}

await main();
