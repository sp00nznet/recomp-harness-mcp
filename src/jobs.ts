import { spawn, ChildProcess } from "node:child_process";

/**
 * Builds and recompilation passes routinely run for minutes to hours. The MCP
 * tools must not block on them, so every long task becomes a background Job with
 * a captured ring-buffer of output that agents can poll and tail.
 */

export type JobState = "running" | "exited" | "failed" | "stopped";

export interface JobView {
  id: string;
  label: string;
  harnessId: string;
  command: string;
  cwd: string;
  state: JobState;
  pid?: number;
  exitCode: number | null;
  startedAt: string;
  endedAt?: string;
  lines: number;
}

const MAX_LINES = 4000;

class Job {
  readonly id: string;
  readonly label: string;
  readonly harnessId: string;
  readonly command: string;
  readonly cwd: string;
  state: JobState = "running";
  exitCode: number | null = null;
  startedAt = new Date().toISOString();
  endedAt?: string;
  private buf: string[] = [];
  private child?: ChildProcess;

  constructor(opts: { id: string; label: string; harnessId: string; command: string; cwd: string }) {
    this.id = opts.id;
    this.label = opts.label;
    this.harnessId = opts.harnessId;
    this.command = opts.command;
    this.cwd = opts.cwd;
  }

  push(chunk: Buffer | string) {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      this.buf.push(line);
    }
    if (this.buf.length > MAX_LINES) {
      this.buf.splice(0, this.buf.length - MAX_LINES);
    }
  }

  attach(child: ChildProcess) {
    this.child = child;
    child.stdout?.on("data", (d) => this.push(d));
    child.stderr?.on("data", (d) => this.push(d));
    child.on("error", (err) => {
      this.push(`\n[job error] ${err.message}\n`);
      this.state = "failed";
      this.endedAt = new Date().toISOString();
    });
    child.on("exit", (code, signal) => {
      this.exitCode = code;
      if (this.state === "stopped") {
        // already marked
      } else if (signal) {
        this.state = "stopped";
      } else {
        this.state = code === 0 ? "exited" : "failed";
      }
      this.endedAt = new Date().toISOString();
      this.push(`\n[job ${this.state}] exit code ${code ?? "null"}${signal ? ` signal ${signal}` : ""}\n`);
    });
  }

  stop() {
    if (this.child && this.state === "running") {
      this.state = "stopped";
      this.child.kill();
    }
  }

  tail(n: number): string {
    const start = Math.max(0, this.buf.length - n);
    return this.buf.slice(start).join("\n");
  }

  view(): JobView {
    return {
      id: this.id,
      label: this.label,
      harnessId: this.harnessId,
      command: this.command,
      cwd: this.cwd,
      state: this.state,
      pid: this.child?.pid,
      exitCode: this.exitCode,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      lines: this.buf.length,
    };
  }
}

export class JobManager {
  private jobs = new Map<string, Job>();
  private counter = 0;

  start(opts: { label: string; harnessId: string; command: string; cwd: string; shell?: string }): JobView {
    this.counter += 1;
    const id = `job-${this.counter}`;
    const job = new Job({
      id,
      label: opts.label,
      harnessId: opts.harnessId,
      command: opts.command,
      cwd: opts.cwd,
    });

    // Run through a shell so chained commands (cmake -B build && cmake --build ...)
    // and tool resolution behave the way the README documents them. On Windows we
    // prefer PowerShell; otherwise /bin/sh.
    const isWin = process.platform === "win32";
    const shell = opts.shell ?? (isWin ? "powershell.exe" : "/bin/sh");
    const args = isWin
      ? ["-NoProfile", "-NonInteractive", "-Command", opts.command]
      : ["-c", opts.command];

    const child = spawn(shell, args, {
      cwd: opts.cwd,
      windowsHide: true,
      env: process.env,
    });
    job.attach(child);
    this.jobs.set(id, job);
    return job.view();
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(): JobView[] {
    return [...this.jobs.values()].map((j) => j.view());
  }

  stop(id: string): JobView | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    job.stop();
    return job.view();
  }
}
