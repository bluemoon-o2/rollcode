import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = dirname(__dirname);
const require = createRequire(import.meta.url);

function fallbackDest(specifier) {
  return join(pkgRoot, "node_modules", specifier);
}

function copyToResolved(srcRel, targetSpecifier) {
  const src = join(pkgRoot, srcRel);
  if (!existsSync(src)) {
    console.warn(`[patch] missing vendor source: ${srcRel}`);
    return;
  }

  let dest;
  try {
    dest = require.resolve(targetSpecifier);
  } catch {
    dest = fallbackDest(targetSpecifier);
  }

  const destDir = dirname(dest);
  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }

  copyFileSync(src, dest);
  console.log(`[patch] ${srcRel} -> ${dest}`);
}

copyToResolved(
  "vendor/ink/build/components/App.js",
  "ink/build/components/App.js",
);
copyToResolved(
  "vendor/ink/build/hooks/use-input.js",
  "ink/build/hooks/use-input.js",
);
copyToResolved("vendor/ink/build/devtools.js", "ink/build/devtools.js");
copyToResolved("vendor/ink/build/log-update.js", "ink/build/log-update.js");
copyToResolved("vendor/ink/build/wrap-text.js", "ink/build/wrap-text.js");

copyToResolved(
  "vendor/ink-text-input/build/index.js",
  "ink-text-input/build/index.js",
);
copyToResolved(
  "vendor/ink-text-input/build/index.d.ts",
  "ink-text-input/build/index.d.ts",
);

console.log("[patch] Runtime patches applied");
