import { randomUUID } from "node:crypto";
import {
  appendFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

const writeQueues = new Map<string, Promise<void>>();

function enqueuePathWrite(
  path: string,
  task: () => Promise<void>,
): Promise<void> {
  const previous = writeQueues.get(path) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  writeQueues.set(path, next);
  return next.finally(() => {
    if (writeQueues.get(path) === next) {
      writeQueues.delete(path);
    }
  });
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function writeText(path: string, content: string): Promise<void> {
  await enqueuePathWrite(path, async () => {
    await ensureDir(dirname(path));
    const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, content, "utf8");
      await rename(tempPath, path);
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  });
}

export async function appendText(path: string, content: string): Promise<void> {
  await enqueuePathWrite(path, async () => {
    await ensureDir(dirname(path));
    await appendFile(path, content, "utf8");
  });
}

export async function appendJsonl(
  path: string,
  payload: unknown,
): Promise<void> {
  await appendText(path, `${JSON.stringify(payload)}\n`);
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function clearDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
  await ensureDir(path);
}

export async function copyDir(source: string, target: string): Promise<void> {
  await ensureDir(dirname(target));
  await cp(source, target, {
    recursive: true,
    force: true,
  });
}

interface ListFilesRecursiveOptions {
  ignoreDirectories?: string[];
  ignoreHiddenDirectories?: boolean;
}

export async function listFilesRecursive(
  root: string,
  options: ListFilesRecursiveOptions = {},
): Promise<string[]> {
  const ignored = new Set(options.ignoreDirectories ?? []);
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(root, entry.name);
      if (entry.isDirectory()) {
        if (ignored.has(entry.name)) {
          return [];
        }
        if (options.ignoreHiddenDirectories && entry.name.startsWith(".")) {
          return [];
        }
        return await listFilesRecursive(fullPath, options);
      }
      return [fullPath];
    }),
  );
  return files.flat();
}
