import { promises as fs } from "node:fs";
import * as path from "node:path";

/**
 * The recomp collection is a tree of static-recompilation projects:
 *
 *   <root>/<platform>/                  e.g. lynx, n64, snes, gb, ps3 ...
 *   <root>/<platform>/<game>/           e.g. lynx/chipschallenge-lynx-recomp
 *   <root>/<harness>/                   some platforms ARE a single harness (e.g. flow)
 *
 * A "harness" is any directory that can be driven to lift a binary and/or build
 * a native executable. We detect them structurally (CMakeLists, python pipeline,
 * config.toml) rather than hard-coding each project, so the catalog stays correct
 * as the collection grows.
 */

export type HarnessType = "pipeline" | "cmake" | "toolkit" | "unknown";

export interface Harness {
  /** Stable id: "<platform>" for top-level harnesses, "<platform>/<name>" otherwise. */
  id: string;
  platform: string;
  name: string;
  dir: string;
  type: HarnessType;
  /** True for reusable per-console recompiler cores (e.g. lynxrecomp, ps3recomp). */
  isToolkit: boolean;
  hasReadme: boolean;
  /** Coarse status derived from the README, best effort. */
  status: string;
  /** First meaningful line(s) of the README. */
  summary: string;
  /** Detected CMake executable targets. */
  cmakeTargets: string[];
  cmakeProject?: string;
  /** Python entry-point scripts, relative to dir. */
  pythonEntries: string[];
  /** Config files (toml/ini/harness.json), relative to dir. */
  configFiles: string[];
  /** Already-built executables, relative to dir. */
  builtExecutables: string[];
  /** Concrete suggested commands for an agent. */
  commands: HarnessCommands;
}

export interface HarnessCommands {
  recompile?: string;
  build?: string;
  run?: string;
}

const SKIP_DIRS = new Set([
  "build",
  ".git",
  "node_modules",
  "extracted",
  "src",
  "include",
  "ext",
  "docs",
  "third_party",
  "vendor",
  ".vs",
  "cmake-build-debug",
]);

// Component subdirs of a harness — only suppressed when the parent is a harness.
const COMPONENT_DIRS = new Set(["tools", "recompiler", "runtime", "source", "config", "harness"]);

const PIPELINE_HINTS = [
  "tools/recompile.py",
  "tools/run_pipeline.py",
  "run_pipeline.py",
  "recompile.py",
  "recompiler/lift.py",
  "recompiler/extract.py",
  "run_lift.py",
];

const ROM_EXTS = new Set([
  ".z64", ".n64", ".v64", ".iso", ".bin", ".cue", ".zip", ".7z", ".rar",
  ".gba", ".gbc", ".gb", ".smc", ".sfc", ".md", ".gen", ".pkg", ".jar",
  ".app", ".lnx", ".dsk", ".woz", ".nds", ".cso", ".self",
]);

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readText(p: string, maxBytes = 1 << 16): Promise<string | null> {
  try {
    const stat = await fs.stat(p);
    if (!stat.isFile()) return null;
    const fh = await fs.open(p, "r");
    try {
      const len = Math.min(stat.size, maxBytes);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, 0);
      return buf.toString("utf8");
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

function deriveStatus(readme: string): string {
  const text = readme.toLowerCase();
  // Order matters: most-complete signal wins.
  if (/full\s+(playthrough|gameplay)|fully playable|\bplayable\b/.test(text)) return "playable";
  if (/\bboots?\b|title screen|game loop|renders|running\b/.test(text)) return "boots";
  if (/in progress|in development|early|wip|prototype|proof/.test(text)) return "wip";
  return "unknown";
}

function summarize(readme: string): string {
  const lines = readme.split(/\r?\n/);
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (out.length) break;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) continue; // skip headings
    out.push(line.replace(/^>\s?/, ""));
    if (out.join(" ").length > 240) break;
  }
  return out.join(" ").slice(0, 400);
}

function parseCmake(cmake: string): { project?: string; targets: string[] } {
  let project: string | undefined;
  const pm = cmake.match(/project\s*\(\s*([A-Za-z0-9_]+)/i);
  if (pm) project = pm[1];
  const targets: string[] = [];
  const re = /add_executable\s*\(\s*([A-Za-z0-9_./-]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmake)) !== null) {
    // skip generated/option-style first args
    if (!m[1].startsWith("$")) targets.push(m[1]);
  }
  return { project, targets };
}

async function listDir(dir: string): Promise<{ files: string[]; dirs: string[] }> {
  const files: string[] = [];
  const dirs: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { files, dirs };
  }
  for (const e of entries) {
    if (e.isDirectory()) dirs.push(e.name);
    else if (e.isFile()) files.push(e.name);
  }
  return { files, dirs };
}

async function findBuiltExes(dir: string): Promise<string[]> {
  const candidates = ["build/Release", "build/Debug", "build", "bin", "out/build/Release"];
  const found: string[] = [];
  for (const sub of candidates) {
    const full = path.join(dir, sub);
    const { files } = await listDir(full);
    for (const f of files) {
      if (f.toLowerCase().endsWith(".exe")) found.push(path.posix.join(sub, f));
    }
    if (found.length >= 12) break;
  }
  return found;
}

/** Inspect one candidate directory and decide whether it is a harness. */
async function inspect(
  root: string,
  platform: string,
  dir: string,
  name: string,
): Promise<Harness | null> {
  const { files, dirs } = await listDir(dir);
  const fileSet = new Set(files.map((f) => f.toLowerCase()));

  const hasCmake = fileSet.has("cmakelists.txt");
  const hasMakefile = fileSet.has("makefile");

  // Detect python pipeline entry points.
  const pythonEntries: string[] = [];
  for (const hint of PIPELINE_HINTS) {
    if (await exists(path.join(dir, hint))) pythonEntries.push(hint);
  }
  // Also scan tools/ and recompiler/ for *.py entry-looking scripts.
  for (const sub of ["tools", "recompiler"]) {
    if (dirs.includes(sub)) {
      const { files: sf } = await listDir(path.join(dir, sub));
      for (const f of sf) {
        if (/\.(py)$/.test(f) && /(recompile|pipeline|lift|extract|build|run)/i.test(f)) {
          const rel = `${sub}/${f}`;
          if (!pythonEntries.includes(rel)) pythonEntries.push(rel);
        }
      }
    }
  }

  const configFiles: string[] = [];
  for (const f of files) {
    if (/\.toml$/i.test(f) || /config.*\.ini$/i.test(f) || f.toLowerCase() === "harness.json") {
      configFiles.push(f);
    }
  }

  const hasReadme = fileSet.has("readme.md");
  const isHarness =
    hasCmake || hasMakefile || pythonEntries.length > 0 || (hasReadme && configFiles.length > 0);
  if (!isHarness) return null;

  // Parse README.
  let summary = "";
  let status = "unknown";
  if (hasReadme) {
    const readme = await readText(path.join(dir, "README.md"));
    if (readme) {
      summary = summarize(readme);
      status = deriveStatus(readme);
    }
  }

  // Parse CMake.
  let cmakeTargets: string[] = [];
  let cmakeProject: string | undefined;
  if (hasCmake) {
    const cmake = await readText(path.join(dir, "CMakeLists.txt"));
    if (cmake) {
      const parsed = parseCmake(cmake);
      cmakeProject = parsed.project;
      cmakeTargets = parsed.targets;
    }
  }

  const builtExecutables = await findBuiltExes(dir);

  // A toolkit is a REUSABLE per-console core (lynxrecomp, ps3recomp, N64Recomp,
  // gbarecomp, MidwayRecomp, N64ModernRuntime). These are single-token names
  // ending in "recomp"/"runtime" — game harnesses like "chipschallenge-lynx-recomp"
  // or "oregontrail-apple2-recomp" carry a hyphenated game prefix and are NOT toolkits.
  const isToolkit = /^[A-Za-z0-9]+(recomp|modernruntime|runtime)$/i.test(name);

  let type: HarnessType = "unknown";
  if (pythonEntries.length > 0) type = "pipeline";
  else if (isToolkit) type = "toolkit";
  else if (hasCmake) type = "cmake";

  const id = platform === name ? platform : `${platform}/${name}`;

  // Build suggested commands.
  const commands: HarnessCommands = {};
  if (pythonEntries.length > 0) {
    const entry = pythonEntries[0];
    const cfg = configFiles.find((c) => /\.toml$/i.test(c));
    commands.recompile = `python ${entry}${cfg ? ` --config ${cfg}` : ""}`;
  }
  if (hasCmake) {
    commands.build = `cmake -B build && cmake --build build --config Release`;
  }
  if (builtExecutables.length > 0) {
    commands.run = builtExecutables[0];
  } else if (cmakeTargets.length > 0) {
    commands.run = `build/Release/${cmakeTargets[0]}.exe`;
  }

  return {
    id,
    platform,
    name,
    dir,
    type,
    isToolkit,
    hasReadme,
    status,
    summary,
    cmakeTargets,
    cmakeProject,
    pythonEntries,
    configFiles,
    builtExecutables,
    commands,
  };
}

/** Scan the whole collection and return every detected harness. */
export async function scanHarnesses(root: string): Promise<Harness[]> {
  const out: Harness[] = [];
  const { dirs: platforms } = await listDir(root);

  for (const platform of platforms) {
    if (platform.startsWith(".")) continue;
    const platDir = path.join(root, platform);

    // The platform dir itself may be a harness (e.g. flow).
    const top = await inspect(root, platform, platDir, platform);
    if (top) out.push(top);

    // Immediate children may each be harnesses (e.g. lynx/chipschallenge-...).
    const { dirs: children } = await listDir(platDir);
    for (const child of children) {
      const lc = child.toLowerCase();
      if (SKIP_DIRS.has(lc) || child.startsWith(".")) continue;
      // If the platform dir is itself a harness, its own component subdirs
      // (tools/, recompiler/, source/, runtime/) are parts of it, not new harnesses.
      if (top && COMPONENT_DIRS.has(lc)) continue;
      const childDir = path.join(platDir, child);
      const h = await inspect(root, platform, childDir, child);
      if (h) out.push(h);
    }
  }

  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

export function isRomFile(name: string): boolean {
  return ROM_EXTS.has(path.extname(name).toLowerCase());
}
