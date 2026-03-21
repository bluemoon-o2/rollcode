import { render } from "ink";
import type { SessionController } from "../runtime/service";
import { App } from "./App";
import { ResumePicker, type ResumePickerOption } from "./ResumePicker";
import { clearTerminalScreen } from "./terminal";

export type SessionExitReason = "exit" | "new";

export async function runRollcodeSessionUi(
  controller: SessionController,
): Promise<SessionExitReason> {
  let reason: SessionExitReason = "exit";
  clearTerminalScreen();
  const app = render(
    <App
      controller={controller}
      onExitRequest={(nextReason) => {
        reason = nextReason;
      }}
    />,
    { exitOnCtrlC: true },
  );
  await app.waitUntilExit();
  return reason;
}

export async function runResumePickerUi(
  options: {
    preferredOptions: ResumePickerOption[];
    allOptions: ResumePickerOption[];
  },
): Promise<string | null> {
  let selectedRunId: string | null = null;
  clearTerminalScreen();
  const app = render(
    <ResumePicker
      preferredOptions={options.preferredOptions}
      allOptions={options.allOptions}
      onSelect={(runId) => {
        selectedRunId = runId;
      }}
      onCancel={() => {
        selectedRunId = null;
      }}
    />,
    { exitOnCtrlC: true },
  );
  await app.waitUntilExit();
  return selectedRunId;
}
