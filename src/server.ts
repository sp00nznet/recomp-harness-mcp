import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { scanHarnesses, Harness } from "./scanner.js";
import { JobManager } from "./jobs.js";

export const DEFAULT_ROOT = process.env.RECOMP_ROOT || path.resolve(process.cwd(), "recomp");

interface Cache {
  harnesses: Harness[];
  builtAt: number;
}

function jsonContent(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function textContent(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function createServer(root = DEFAULT_ROOT): McpServer {
  const server = new McpServer({
    name: "recomp-harness-mcp",
    version: "0.1.0",
  });

  const jobs = new JobManager();
  let cache: Cache | null = null;

  async function getHarnesses(force = false): Promise<Harness[]> {
    if (!cache || force || Date.now() - cache.builtAt > 60_000) {
      cache = { harnesses: await scanHarnesses(root), builtAt: Date.now() };
    }
    return cache.harnesses;
  }

  async function findHarness(id: string): Promise<Harness | undefined> {
    const all = await getHarnesses();
    const lc = id.toLowerCase();
    return (
      all.find((h) => h.id.toLowerCase() === lc) ||
      all.find((h) => h.name.toLowerCase() === lc) ||
      all.find((h) => h.id.toLowerCase().endsWith("/" + lc))
    );
  }

  // ── list_harnesses ────────────────────────────────────────────────────────
  server.tool(
    "list_harnesses",
    "List the static-recompilation harnesses in the recomp collection. Each harness lifts a game ROM/binary to native C and builds an executable. Filter by platform, type, status, or a free-text query. Returns compact descriptors; use describe_harness for full detail.",
    {
      platform: z.string().optional().describe("Filter to one platform dir, e.g. 'lynx', 'n64', 'snes'."),
      type: z
        .enum(["pipeline", "cmake", "toolkit", "unknown"])
        .optional()
        .describe("pipeline = python lift pipeline; cmake = build+run; toolkit = reusable per-console core."),
      status: z
        .enum(["playable", "boots", "wip", "unknown"])
        .optional()
        .describe("Coarse status derived from each README."),
      query: z.string().optional().describe("Case-insensitive match against id/name/summary."),
      include_toolkits: z.boolean().optional().describe("Include reusable core frameworks (default true)."),
      refresh: z.boolean().optional().describe("Force a fresh filesystem scan."),
    },
    async (args) => {
      let list = await getHarnesses(args.refresh);
      if (args.platform) list = list.filter((h) => h.platform.toLowerCase() === args.platform!.toLowerCase());
      if (args.type) list = list.filter((h) => h.type === args.type);
      if (args.status) list = list.filter((h) => h.status === args.status);
      if (args.include_toolkits === false) list = list.filter((h) => !h.isToolkit);
      if (args.query) {
        const q = args.query.toLowerCase();
        list = list.filter(
          (h) =>
            h.id.toLowerCase().includes(q) ||
            h.name.toLowerCase().includes(q) ||
            h.summary.toLowerCase().includes(q),
        );
      }
      const compact = list.map((h) => ({
        id: h.id,
        platform: h.platform,
        type: h.type,
        isToolkit: h.isToolkit,
        status: h.status,
        summary: h.summary,
        built: h.builtExecutables.length > 0,
      }));
      return jsonContent({ root, count: compact.length, harnesses: compact });
    },
  );

  // ── describe_harness ──────────────────────────────────────────────────────
  server.tool(
    "describe_harness",
    "Full detail for one harness: detected entry points, CMake targets, config files, built executables, suggested commands, and the README (truncated). Use the id from list_harnesses, e.g. 'flow' or 'lynx/chipschallenge-lynx-recomp'.",
    {
      id: z.string().describe("Harness id, name, or '<platform>/<name>'."),
      readme: z.boolean().optional().describe("Include README text (default true)."),
    },
    async (args) => {
      const h = await findHarness(args.id);
      if (!h) return textContent(`No harness found for '${args.id}'. Try list_harnesses.`);
      let readmeText: string | undefined;
      if (args.readme !== false && h.hasReadme) {
        try {
          const raw = await fs.readFile(path.join(h.dir, "README.md"), "utf8");
          readmeText = raw.length > 12000 ? raw.slice(0, 12000) + "\n\n…[truncated]" : raw;
        } catch {
          /* ignore */
        }
      }
      return jsonContent({ ...h, readme: readmeText });
    },
  );

  // ── read_harness_file ─────────────────────────────────────────────────────
  server.tool(
    "read_harness_file",
    "Read a text file inside a harness directory (config.toml, CMakeLists.txt, a tools/*.py script, etc.). Path is relative to the harness dir and is sandboxed to it. Refuses files over ~256 KB and binary/ROM files.",
    {
      id: z.string().describe("Harness id."),
      file: z.string().describe("Relative path inside the harness, e.g. 'config.toml' or 'tools/recompile.py'."),
    },
    async (args) => {
      const h = await findHarness(args.id);
      if (!h) return textContent(`No harness found for '${args.id}'.`);
      const target = path.resolve(h.dir, args.file);
      const base = path.resolve(h.dir);
      if (target !== base && !target.startsWith(base + path.sep)) {
        return textContent("Refused: path escapes the harness directory.");
      }
      try {
        const stat = await fs.stat(target);
        if (!stat.isFile()) return textContent("Not a file.");
        if (stat.size > 256 * 1024) return textContent(`Refused: file is ${stat.size} bytes (>256 KB).`);
        const text = await fs.readFile(target, "utf8");
        return textContent(text);
      } catch (e) {
        return textContent(`Could not read '${args.file}': ${(e as Error).message}`);
      }
    },
  );

  // ── recompile_harness ─────────────────────────────────────────────────────
  server.tool(
    "recompile_harness",
    "Run the python lift/recompilation pipeline for a harness (the step that disassembles the binary and emits C). Starts a BACKGROUND job and returns a jobId immediately — recompilation can take minutes to hours. Poll with job_status / job_logs. Only valid for harnesses with a detected python pipeline.",
    {
      id: z.string().describe("Harness id."),
      entry: z.string().optional().describe("Which python entry to run (relative path). Defaults to the primary one."),
      args: z.string().optional().describe("Extra CLI arguments appended to the python invocation."),
      python: z.string().optional().describe("Python executable (default 'python')."),
    },
    async (args) => {
      const h = await findHarness(args.id);
      if (!h) return textContent(`No harness found for '${args.id}'.`);
      if (h.pythonEntries.length === 0) {
        return textContent(
          `'${h.id}' has no detected python pipeline. It is type '${h.type}'. Use build_harness instead.`,
        );
      }
      const entry = args.entry ?? h.pythonEntries[0];
      if (!h.pythonEntries.includes(entry)) {
        return textContent(`Unknown entry '${entry}'. Available: ${h.pythonEntries.join(", ")}`);
      }
      const py = args.python ?? "python";
      const cfg = h.configFiles.find((c) => /\.toml$/i.test(c));
      const cfgArg = cfg && !args.args?.includes("--config") ? ` --config ${cfg}` : "";
      const command = `${py} ${entry}${cfgArg}${args.args ? " " + args.args : ""}`;
      const view = jobs.start({ label: `recompile ${h.id}`, harnessId: h.id, command, cwd: h.dir });
      return jsonContent({ started: view, hint: "Poll job_status / job_logs with this jobId." });
    },
  );

  // ── build_harness ─────────────────────────────────────────────────────────
  server.tool(
    "build_harness",
    "Configure and build a harness with CMake (the step that compiles the lifted C into a native executable). Starts a BACKGROUND job and returns a jobId immediately. Poll with job_status / job_logs.",
    {
      id: z.string().describe("Harness id."),
      config: z.enum(["Release", "Debug"]).optional().describe("CMake build config (default Release)."),
      target: z.string().optional().describe("Specific CMake target to build."),
      clean: z.boolean().optional().describe("Delete the build/ dir first for a clean configure."),
      cmake_args: z.string().optional().describe("Extra args passed to the configure step, e.g. '-DFOO=bar'."),
    },
    async (args) => {
      const h = await findHarness(args.id);
      if (!h) return textContent(`No harness found for '${args.id}'.`);
      const hasCmake = await fileExists(path.join(h.dir, "CMakeLists.txt"));
      if (!hasCmake) {
        return textContent(`'${h.id}' has no CMakeLists.txt. Detected entry points: ${h.pythonEntries.join(", ") || "none"}.`);
      }
      const cfg = args.config ?? "Release";
      const extra = args.cmake_args ? " " + args.cmake_args : "";
      const targetArg = args.target ? ` --target ${args.target}` : "";
      const clean = args.clean ? `if (Test-Path build) { Remove-Item -Recurse -Force build }; ` : "";
      const command = `${clean}cmake -B build${extra}; cmake --build build --config ${cfg}${targetArg}`;
      const view = jobs.start({ label: `build ${h.id} [${cfg}]`, harnessId: h.id, command, cwd: h.dir });
      return jsonContent({ started: view, hint: "Poll job_status / job_logs with this jobId." });
    },
  );

  // ── run_harness ───────────────────────────────────────────────────────────
  server.tool(
    "run_harness",
    "Launch a harness's built executable. Starts a BACKGROUND job (games run a window/loop). Returns a jobId; use job_logs to read stdout/stderr and stop_job to terminate. If no built exe is found, build the harness first.",
    {
      id: z.string().describe("Harness id."),
      exe: z.string().optional().describe("Which built executable to run (relative path). Defaults to the first detected."),
      args: z.string().optional().describe("Arguments passed to the executable, e.g. a ROM path."),
    },
    async (args) => {
      const h = await findHarness(args.id);
      if (!h) return textContent(`No harness found for '${args.id}'.`);
      const exes = h.builtExecutables;
      let exe = args.exe ?? exes[0];
      if (!exe) {
        const guess = h.cmakeTargets[0] ? `build/Release/${h.cmakeTargets[0]}.exe` : undefined;
        if (guess && (await fileExists(path.join(h.dir, guess)))) {
          exe = guess;
        } else {
          return textContent(
            `No built executable found for '${h.id}'. Run build_harness first. Known CMake targets: ${h.cmakeTargets.join(", ") || "none"}.`,
          );
        }
      }
      const exePath = path.resolve(h.dir, exe);
      if (!(await fileExists(exePath))) {
        return textContent(`Executable '${exe}' does not exist. Build first or pass a valid 'exe'.`);
      }
      const command = `& '${exePath}'${args.args ? " " + args.args : ""}`;
      const view = jobs.start({ label: `run ${h.id}`, harnessId: h.id, command, cwd: h.dir });
      return jsonContent({ started: view, hint: "Use job_logs to read output; stop_job to terminate." });
    },
  );

  // ── job tools ─────────────────────────────────────────────────────────────
  server.tool("list_jobs", "List all background jobs (recompiles, builds, runs) started this session.", {}, async () => {
    return jsonContent({ jobs: jobs.list() });
  });

  server.tool(
    "job_status",
    "Get the status of one background job: state (running/exited/failed/stopped), exit code, timing.",
    { jobId: z.string().describe("The job id, e.g. 'job-1'.") },
    async (args) => {
      const job = jobs.get(args.jobId);
      if (!job) return textContent(`No job '${args.jobId}'.`);
      return jsonContent(job.view());
    },
  );

  server.tool(
    "job_logs",
    "Tail captured stdout/stderr for a background job.",
    {
      jobId: z.string().describe("The job id."),
      tail: z.number().int().positive().max(2000).optional().describe("How many trailing lines to return (default 120)."),
    },
    async (args) => {
      const job = jobs.get(args.jobId);
      if (!job) return textContent(`No job '${args.jobId}'.`);
      return textContent(job.tail(args.tail ?? 120));
    },
  );

  server.tool(
    "stop_job",
    "Terminate a running background job.",
    { jobId: z.string().describe("The job id.") },
    async (args) => {
      const view = jobs.stop(args.jobId);
      if (!view) return textContent(`No job '${args.jobId}'.`);
      return jsonContent(view);
    },
  );

  return server;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
