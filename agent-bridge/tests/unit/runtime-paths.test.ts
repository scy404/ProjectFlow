import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  resolveEvaluationRuntimePaths,
  resolveSidecarInvocation,
} from "../../src/evaluation/lab/runtime-paths.js";

describe("evaluation runtime paths", () => {
  it("uses Scripts/python.exe and tsx.cmd on Windows", () => {
    const paths = resolveEvaluationRuntimePaths("C:\\repo", "win32");
    expect(paths.python).toBe(join("C:\\repo", "backend", ".venv", "Scripts", "python.exe"));
    expect(paths.tsx).toBe(join("C:\\repo", "agent-bridge", "node_modules", ".bin", "tsx.cmd"));
  });

  it("uses POSIX virtualenv and npm shim paths on Linux and macOS", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const paths = resolveEvaluationRuntimePaths("/repo", platform);
      expect(paths.python).toBe(join("/repo", "backend", ".venv", "bin", "python"));
      expect(paths.tsx).toBe(join("/repo", "agent-bridge", "node_modules", ".bin", "tsx"));
    }
  });

  it("dispatches the Windows tsx.cmd shim through cmd.exe", () => {
    const invocation = resolveSidecarInvocation("C:\\repo", "win32", "cmd.exe");
    expect(invocation.command).toBe("cmd.exe");
    expect(invocation.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(invocation.args[3]).toContain("tsx.cmd");
  });
});
