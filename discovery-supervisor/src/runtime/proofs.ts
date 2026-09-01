import { connect } from "node:net";
import {
  volumeKeeperContainerName,
  type CommandRunner,
} from "../openclaw/cell-runtime";

export function proveLoopbackListenerClosed(
  port: number,
  timeoutMilliseconds = 500,
): Promise<boolean> {
  if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535 ||
      !Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1 ||
      timeoutMilliseconds > 5_000) {
    throw new Error("loopback listener proof input is invalid");
  }
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (closed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(closed);
    };
    const timer = setTimeout(() => finish(false), timeoutMilliseconds);
    socket.once("connect", () => finish(false));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ECONNREFUSED");
    });
  });
}

function containerName(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value) || value.includes("..")) {
    throw new Error("runtime container identity is invalid");
  }
  return value;
}

export async function proveDockerIdentityProcessesAbsent(
  runner: CommandRunner,
  identity: {
    readonly cell_container_name: string;
    readonly bridge_container_name: string;
  },
): Promise<boolean> {
  for (const name of [
    containerName(identity.cell_container_name),
    containerName(identity.bridge_container_name),
    containerName(volumeKeeperContainerName(identity.cell_container_name)),
  ]) {
    let result;
    try {
      result = await runner.run(Object.freeze({
        label: "prove-runtime-identity-process-absent",
        argv: Object.freeze([
          "docker",
          "ps",
          "--all",
          "--filter",
          `name=^/${name}$`,
          "--format",
          "{{.ID}}",
        ]),
        env: Object.freeze({}),
      }));
    } catch {
      return false;
    }
    if (result.exitCode !== 0 || result.stderr.trim() !== "" || result.stdout.trim() !== "") {
      return false;
    }
  }
  return true;
}
