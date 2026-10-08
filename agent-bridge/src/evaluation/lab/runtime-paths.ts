import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export interface EvaluationRuntimePaths {
  python: string;
  tsx: string;
}

export interface SidecarInvocation {
  command: string;
  args: string[];
}

export function resolveCommandShimInvocation(
  executable: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  commandShell: string = process.env.ComSpec ?? "cmd.exe",
): SidecarInvocation {
  if (platform === "win32" && executable.toLowerCase().endsWith(".cmd")) {
    return { command: commandShell, args: ["/d", "/s", "/c", executable, ...args] };
  }
  return { command: executable, args };
}

/** Resolve repository-local runtimes without assuming a POSIX venv layout. */
export function resolveEvaluationRuntimePaths(
  projectRoot: string,
  platform: NodeJS.Platform = process.platform,
): EvaluationRuntimePaths {
  const windows = platform === "win32";
  return {
    python: windows
      ? join(projectRoot, "backend", ".venv", "Scripts", "python.exe")
      : join(projectRoot, "backend", ".venv", "bin", "python"),
    tsx: windows
      ? join(projectRoot, "agent-bridge", "node_modules", ".bin", "tsx.cmd")
      : join(projectRoot, "agent-bridge", "node_modules", ".bin", "tsx"),
  };
}

/** Build an executable invocation for the Windows .cmd shim. */
export function resolveSidecarInvocation(
  projectRoot: string,
  platform: NodeJS.Platform = process.platform,
  commandShell: string = process.env.ComSpec ?? "cmd.exe",
): SidecarInvocation {
  const { tsx } = resolveEvaluationRuntimePaths(projectRoot, platform);
  return resolveCommandShimInvocation(tsx, ["src/index.ts"], platform, commandShell);
}

/** Prefer Git Bash on Windows so Windows paths are passed without WSL rewriting. */
export function resolvePosixShell(platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return "bash";
  const gitExecPath = execFileSync("git", ["--exec-path"], { encoding: "utf-8" }).trim();
  const gitBash = resolve(gitExecPath, "..", "..", "..", "bin", "bash.exe");
  if (!existsSync(gitBash)) {
    throw new Error(`未找到 Git Bash: ${gitBash}`);
  }
  return gitBash;
}
