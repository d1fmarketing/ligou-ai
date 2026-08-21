import childProcess from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";

const allowedArtifact = process.env.LIGOU_BOOTSTRAP_ALLOWED_ARTIFACT ?? "";
const allowedTarCommand = process.env.LIGOU_BOOTSTRAP_TAR_COMMAND ?? "";
if (!allowedArtifact.startsWith("/") || allowedTarCommand !== "tar") {
  throw new Error("bootstrap_guard_configuration_invalid");
}

const denyNetwork = () => { throw new Error("bootstrap_network_forbidden"); };
globalThis.fetch = denyNetwork;
globalThis.WebSocket = class { constructor() { denyNetwork(); } };

net.connect = denyNetwork;
net.createConnection = denyNetwork;
net.Socket.prototype.connect = denyNetwork;
tls.connect = denyNetwork;
http.request = denyNetwork;
http.get = denyNetwork;
https.request = denyNetwork;
https.get = denyNetwork;
http2.connect = denyNetwork;
dgram.createSocket = denyNetwork;
dns.lookup = denyNetwork;
dns.resolve = denyNetwork;
dns.resolve4 = denyNetwork;
dns.resolve6 = denyNetwork;

const originalSpawnSync = childProcess.spawnSync;
const safeArchiveEntry = (candidate) => (
  typeof candidate === "string"
  && /^[A-Za-z0-9._/-]+$/.test(candidate)
  && !candidate.startsWith("/")
  && !candidate.split("/").includes("..")
);
const allowedTarInvocation = (command, args, options) => {
  if (command !== allowedTarCommand || !Array.isArray(args) || options?.shell) return false;
  if (args.length === 2 && args[0] === "-tzf" && args[1] === allowedArtifact) return true;
  return args.length === 3 && args[0] === "-xOf" && args[1] === allowedArtifact && safeArchiveEntry(args[2]);
};
childProcess.spawnSync = (command, args, options) => {
  if (!allowedTarInvocation(command, args, options)) throw new Error("bootstrap_child_process_forbidden");
  return originalSpawnSync(command, args, options);
};
for (const method of ["exec", "execFile", "execFileSync", "execSync", "fork", "spawn"]) {
  childProcess[method] = () => { throw new Error("bootstrap_child_process_forbidden"); };
}

syncBuiltinESMExports();
