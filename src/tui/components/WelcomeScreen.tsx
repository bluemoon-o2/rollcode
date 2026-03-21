import { homedir } from "node:os";
import { Box } from "ink";
import { getVersion } from "../../version";
import { AnimatedLogo } from "./AnimatedLogo";
import { Text } from "./Text";
import { colors } from "./colors";

export type LauncherLoadingState = "loading_history" | "ready";

function toTildePath(absolutePath: string): string {
  const home = homedir();
  if (absolutePath.startsWith(home)) {
    return `~${absolutePath.slice(home.length)}`;
  }
  return absolutePath;
}

function getLoadingMessage(loadingState: LauncherLoadingState): string {
  switch (loadingState) {
    case "loading_history":
      return "Loading run history...";
    case "ready":
      return "Ready";
    default:
      return "Loading...";
  }
}

export function WelcomeScreen(props: {
  cwd: string;
  loadingState: LauncherLoadingState;
}) {
  const version = getVersion();
  const tildePath = toTildePath(props.cwd);
  const detail =
    props.loadingState === "ready"
      ? tildePath
      : getLoadingMessage(props.loadingState);

  return (
    <Box flexDirection="row" marginTop={1}>
      <Box flexDirection="column" paddingLeft={1} paddingRight={2}>
        <AnimatedLogo
          color={colors.welcome.accent}
          animate={props.loadingState !== "ready"}
        />
      </Box>
      <Box flexDirection="column">
        <Box>
          <Text bold>RollCode</Text>
          <Text color={colors.welcome.muted}> v{version}</Text>
        </Box>
        <Text color={colors.welcome.muted}>
          codex app-server · auto coding assistant
        </Text>
        <Text color={colors.welcome.muted}>{detail}</Text>
      </Box>
    </Box>
  );
}
