import { RECORD_LEADER } from "../groups";
import { writableIn } from "../resolve";
import type { ResolvedSandbox } from "../seam";

/**
 * The box's mounts, at the host's paths: the working directory and `read` read-only, `write`
 * writable, `homes/` and `quarantine/`, and the gitdirs, read-only unless writable. The most specific path decides,
 * so mounts go shortest first and a nested one lies over its parent. `guarded` names the
 * protected gitdir paths that exist, each mounted read-only over a writable gitdir. `--mount`,
 * not `-v`, which would make a missing source as root rather than refuse it.
 */
export function mountArgs(
  spec: ResolvedSandbox<unknown>,
  directory: string,
  guarded: readonly string[],
): string[] {
  const mounts = new Map<string, boolean>();
  for (const path of [spec.cwd, ...spec.read, ...spec.write]) {
    mounts.set(path, !writableIn(spec, path));
  }
  for (const gitdir of spec.gitdirs) {
    if (!mounts.has(gitdir.path)) mounts.set(gitdir.path, !gitdir.writable);
  }
  for (const path of guarded) mounts.set(path, true);
  mounts.set(`${directory}/homes`, false);
  mounts.set(`${directory}/quarantine`, false);
  return [...mounts]
    .sort(([a], [b]) => a.length - b.length || a.localeCompare(b))
    .flatMap(([path, readOnly]) => {
      if (path.includes(",")) throw new Error(`docker: cannot mount ${path}, which holds a comma`);
      return ["--mount", `type=bind,source=${path},target=${path}${readOnly ? ",readonly" : ""}`];
    });
}

/**
 * The `docker exec` that runs `argv` for an agent: in its working directory, recording its pid in
 * `pidFile` (the exec'd process leads its own group, as runc makes it a session leader), with its
 * variables set by `-e`. A secret passes by name alone, its value in the client's environment, so
 * it never shows in the host's `ps`.
 */
export function execArgs(options: {
  box: string;
  cwd: string | undefined;
  env: Readonly<Record<string, string>>;
  secrets: readonly string[];
  pidFile: string;
  argv: readonly string[];
}): string[] {
  return [
    "exec",
    "-i",
    ...(options.cwd ? ["-w", options.cwd] : []),
    ...Object.entries(options.env).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
    ...options.secrets.flatMap((name) => ["-e", name]),
    options.box,
    "sh",
    "-c",
    RECORD_LEADER,
    options.pidFile,
    ...options.argv,
  ];
}
