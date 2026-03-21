import type { StateStore } from "./state/store";
import { getBaseVersion, getVersion } from "./version";

const LAST_SEEN_RELEASE_NOTES_VERSION = "lastSeenReleaseNotesVersion";

export const releaseNotes: Record<string, string> = {
  "0.0.2": `RollCode 0.0.2
date: 2026-03-22
- Simplified worker/supervisor turn packets to keep execution prompts lighter.
- Shifted orchestration responsibility to runtime infra state/dispatch logic.
- Improved parallel lane policy and plan-completion gating in runtime.`,
  "0.0.1": `RollCode 0.0.1
date: 2026-03-20
- Initial release with basic features and improvements.
- Focus on stability and performance.
- More features and enhancements to come in future releases.`,
};

export function getReleaseNotes(baseVersion: string): string | null {
  return releaseNotes[baseVersion] ?? null;
}

export async function checkReleaseNotes(
  store: StateStore,
): Promise<string | null> {
  if (process.env.ROLLCODE_AGENT_ROLE === "subagent") {
    return null;
  }

  const baseVersion = getBaseVersion(getVersion());
  const notes = getReleaseNotes(baseVersion);
  if (!notes) {
    return null;
  }

  if (process.env.ROLLCODE_SHOW_RELEASE_NOTES === "1") {
    return notes;
  }

  const lastSeen = store.getSetting(LAST_SEEN_RELEASE_NOTES_VERSION);
  if (lastSeen && getBaseVersion(lastSeen) === baseVersion) {
    return null;
  }

  store.setSetting(LAST_SEEN_RELEASE_NOTES_VERSION, baseVersion);
  return notes;
}
