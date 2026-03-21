import packageJson from "../package.json";

export function getVersion(): string {
  return packageJson.version;
}

export function getBaseVersion(version: string): string {
  return version.split("-")[0] ?? version;
}
