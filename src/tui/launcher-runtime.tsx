import { render } from "ink";
import { Launcher, type LauncherResult } from "./Launcher";
import { clearTerminalScreen } from "./terminal";

interface LauncherOptions {
  cwd: string;
  releaseNotes?: string | null;
}

export async function runRollcodeLauncher(
  options: LauncherOptions,
): Promise<LauncherResult> {
  let result: LauncherResult = { type: "exit" };

  clearTerminalScreen();
  const app = render(
    <Launcher
      cwd={options.cwd}
      releaseNotes={options.releaseNotes ?? null}
      onComplete={(next) => {
        result = next;
      }}
    />,
    { exitOnCtrlC: true },
  );

  await app.waitUntilExit();
  return result;
}
