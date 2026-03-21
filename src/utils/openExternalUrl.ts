export async function openExternalUrl(url: string): Promise<void> {
  try {
    const { default: open } = await import("open");
    const subprocess = await open(url, { wait: false });
    subprocess.on("error", () => {
      // Ignore browser launch errors. The user can still open the URL manually.
    });
  } catch {
    // Ignore browser launch failures. The user can still open the URL manually.
  }
}
