# 🕹️ recomp-harness-mcp

> An MCP server that hands an AI agent the keys to a workshop full of **static recompilation harnesses** — and lets it discover, build, recompile, and run them on its own.

No emulator. No interpreter. No ROM being decoded at runtime. Just decades-old game binaries, disassembled instruction-by-instruction, lifted into C, and compiled back down into native executables that run *as if they were always meant to run on your machine.*

This repo is the **control plane** for a large private collection of those projects. The harnesses themselves live on disk (default `D:\recomp`); this server is the thin, safe, structured interface that lets an agent reason about all of them at once.

---

## 🧠 First, what is a "harness"?

**Static recompilation** is the dark art of taking a compiled program for one machine — a PowerPC PS3 binary, a 6502 Atari Lynx cartridge, a MIPS N64 cartridge, an ARM Game Boy Advance ROM — and *translating its machine code ahead of time* into C, function by function. You link that generated C against a hand-written **runtime** that reimplements the original hardware (the GPU, the audio chip, the OS calls) on your host, and you get a real native `.exe`.

It's the technique behind projects like the native PC ports of *Zelda 64* and *Mario 64*. The collection this server indexes applies it across **21 platforms** — from a 1977 Apple II floppy to the Xbox 360.

A **harness** is one self-contained project that does this for one target:

```
   game binary  ──►  disassemble  ──►  lift each function to C  ──►  link runtime  ──►  native .exe
   (ROM/ELF)         (per-ISA)         (the "recompile" step)        (HLE hardware)     (it just runs)
```

Concretely, a harness on disk is a directory containing some mix of:

- a **Python lift pipeline** (`tools/recompile.py`, `recompiler/lift.py`, …) that disassembles the binary and emits C,
- a **`config.toml`** describing the input binary, memory map, graphics/audio backends, and which OS modules to stub,
- a **`CMakeLists.txt`** that compiles the lifted C into an executable,
- a per-console **runtime/toolkit** (e.g. `lynxrecomp`, `ps3recomp`, `gbarecomp`) it links against, and
- a **README** documenting how far it boots.

The catch: there are **~90 of these**, each slightly different, scattered across console-specific folders. Some lift in seconds; some take **hours**. That's exactly the kind of sprawling, heterogeneous toolbox an agent is good at driving — *if* you give it a clean way to see and operate it. That's this server.

---

## ✨ What this MCP server gives an agent

```
                     ┌─────────────────────────────────────────────┐
   AI agent  ◄────►  │            recomp-harness-mcp               │
   (Claude)   MCP    │                                             │
                     │  scanner ──► auto-detects ~90 harnesses     │
                     │  jobs    ──► runs builds/recompiles in bg   │
                     └──────────────────────┬──────────────────────┘
                                            │  spawns
                              ┌─────────────┴─────────────┐
                              ▼                            ▼
                       python lift pipeline          cmake build / run .exe
                       (D:\recomp\flow\…)             (D:\recomp\lynx\…)
```

The server **auto-discovers** harnesses by walking the collection and detecting their entry points structurally — so the catalog stays correct as you add new projects, with zero hard-coded lists. It then exposes a small, sharp set of tools:

| Tool | What it does |
|---|---|
| `list_harnesses` | Browse the catalog. Filter by `platform`, `type`, `status`, or free-text `query`. |
| `describe_harness` | Everything about one harness: entry points, CMake targets, config files, built executables, suggested commands, and its README. |
| `read_harness_file` | Read any text file inside a harness (a `config.toml`, a lift script) — sandboxed to the harness dir. |
| `recompile_harness` | Run the **Python lift pipeline** (binary → C). Long-running → returns a `jobId`. |
| `build_harness` | **CMake configure + build** (C → native `.exe`). Long-running → returns a `jobId`. |
| `run_harness` | Launch the built executable. |
| `list_jobs` / `job_status` / `job_logs` / `stop_job` | Manage the background jobs — poll state, tail stdout/stderr, kill. |

Because recompiles and builds can run for **minutes to hours**, every long task becomes a **background job** with a captured ring-buffer of output. The agent fires it off, gets a `jobId`, and polls — it never blocks.

### A typical agent session

```
agent → list_harnesses { platform: "lynx" }
     ← chipschallenge-lynx-recomp, crystalmines2-lynx-recomp, lynxrecomp (toolkit)

agent → describe_harness { id: "lynx/chipschallenge-lynx-recomp" }
     ← status "boots", build: `cmake -B build && cmake --build build --config Release`,
       cmake target: chipschallenge_lynx_recomp, no built exe yet

agent → build_harness { id: "lynx/chipschallenge-lynx-recomp" }
     ← { started: { id: "job-1", state: "running" } }

agent → job_status { jobId: "job-1" }      (a few minutes later)
     ← { state: "exited", exitCode: 0 }

agent → run_harness { id: "lynx/chipschallenge-lynx-recomp" }
     ← { started: { id: "job-2", state: "running" } }   # Chip's Challenge, as a native .exe
```

---

## 📚 What's in the collection

The catalog auto-detects roughly **90 harnesses across 21 platforms**. A taste of what's in there:

| Platform | ISA | Highlights |
|---|---|---|
| **flow** (PS3) | PowerPC 64 | thatgamecompany's *flOw* — 102K functions lifted, D3D12 rendering |
| **360** (Xbox 360) | PowerPC (Xenon) | Guitar Hero II, Crazy Taxi, Turok, an XBLA toolkit |
| **n64** | MIPS R4300i | podracer, pokemonsnap, extremeg + N64Recomp core |
| **gb** | SM83 | Pokémon Gold / Silver / Crystal — native, RTC-persisting |
| **gba** | ARM7TDMI | Advance Wars, Link to the Past + `gbarecomp` core |
| **gc** | PowerPC 750 | Wind Waker, Luigi's Mansion, Ikaruga, Super Monkey Ball |
| **snes** | 65C816 | Mario Kart (Mode 7), Mario is Missing, Mario Paint |
| **lynx** | WDC 65SC02 | Chip's Challenge, Crystal Mines II (RSA boot decrypt!) |
| **apple2** | NMOS 6502 | The Oregon Trail, Choplifter — read straight off DOS 3.3 disks |
| **ngage** | ARMv4 | Sonic N, Snakes — lifted from Symbian E32Image |
| **cps1 / arcade / neogeo** | 68K / MIPS | Street Fighter II, Mario Kart Arcade GP, Metal Slug |
| **xbox** | x86 | Wreckless, Blood Wake, the Xbox Dashboard |
| **vb / gen / psx / pc / …** | various | Virtual Boy, Genesis, PSX, DOS/Windows ports |

Each harness carries a **status** the server infers from its README — `playable`, `boots`, `wip`, or `unknown` — so an agent can beeline to the ones that actually run.

> ℹ️ The harness directories are **not** part of this repository — they're large and contain game binaries. This repo is purely the MCP server that operates them. Point it at your collection with `RECOMP_ROOT`.

---

## 🚀 Setup

**Requirements:** Node 18+ (built on Node 24), plus whatever the harnesses need to actually build/run — Python 3, CMake, and a C/C++ toolchain (MSVC on Windows).

```bash
git clone https://github.com/sp00nznet/recomp-harness-mcp.git
cd recomp-harness-mcp
npm install
npm run build
```

Sanity-check the scanner against your collection without even touching MCP:

```bash
node dist/cli-scan.js "D:\recomp"
# → root: D:\recomp
#   harnesses: 90
#   • flow  [pipeline, playable, built]
#   • lynx/chipschallenge-lynx-recomp  [cmake, boots]
#   ...
```

### Wire it into an MCP client

**Claude Code:**

```bash
claude mcp add recomp-harness -e RECOMP_ROOT=D:\recomp -- node E:\harnessmcp\dist\index.js
```

**Claude Desktop** (`%APPDATA%\Claude\claude_desktop_config.json`) — see [`examples/claude-desktop-config.json`](examples/claude-desktop-config.json):

```json
{
  "mcpServers": {
    "recomp-harness": {
      "command": "node",
      "args": ["E:\\harnessmcp\\dist\\index.js"],
      "env": { "RECOMP_ROOT": "D:\\recomp" }
    }
  }
}
```

`RECOMP_ROOT` defaults to `D:\recomp` if unset.

---

## 🔍 How discovery works

There's no manifest to maintain. The scanner ([`src/scanner.ts`](src/scanner.ts)) walks the collection two levels deep and classifies each directory **structurally**:

- A directory is a **harness** if it has a `CMakeLists.txt`, a `Makefile`, a Python lift pipeline, or a `config.toml` next to a `README.md`.
- **`type`** is inferred: `pipeline` (has a Python lift step) ▸ `toolkit` (a reusable single-token `*recomp` / `*runtime` core) ▸ `cmake` (build + run).
- **`status`** is derived from README keywords (`playable` ▸ `boots` ▸ `wip`).
- **Entry points** — CMake `add_executable` targets, `tools/*.py` scripts, `*.toml`/`*.ini` configs, and any already-built `build/Release/*.exe` — are detected and surfaced as ready-to-run **commands**.

When a platform folder is itself a harness (like `flow`), its own `tools/` and `source/` subdirs are treated as parts of it, not as separate harnesses. Results are cached for 60s; pass `refresh: true` to `list_harnesses` to force a rescan.

## 🏗️ Architecture

```
src/
  scanner.ts   ── walks RECOMP_ROOT, detects + classifies harnesses (pure, no side effects)
  jobs.ts      ── JobManager: spawns builds/recompiles in the background,
                  captures a 4000-line ring buffer per job, exposes status/tail/stop
  server.ts    ── McpServer: defines the 10 tools, validates args with zod,
                  caches the scan, sandboxes file reads to the harness dir
  index.ts     ── stdio entry point
  cli-scan.ts  ── `npm run scan` — print the catalog for a quick sanity check
  smoke.ts     ── in-memory end-to-end test of every tool
```

Builds and runs are executed through the platform shell (PowerShell on Windows, `/bin/sh` elsewhere) so the chained commands in each project's README behave exactly as documented.

## 🛟 Safety notes

- **`read_harness_file` is sandboxed** — it refuses paths that escape the harness directory, files over 256 KB, and won't stream you a ROM.
- **Builds and runs execute real commands** on your machine, by design — that's the whole point. Run this server only against a collection you trust, and remember that `run_harness` launches native executables. The agent can always `stop_job`.
- Output is captured to an in-memory ring buffer (last ~4000 lines per job); nothing is written to disk by the server itself.

## 🧪 Development

```bash
npm run build     # tsc → dist/
npm run scan      # build + print the detected catalog
node dist/smoke.js  # in-memory end-to-end test of all 10 tools
```

---

*Built for driving a workshop of impossible ports with an agent at the wheel. Bring your own ROMs.* 🎮
