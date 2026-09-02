import https from "node:https";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import ipaddr from "ipaddr.js";

const INPUT_KEYS = ["url", "address", "maxBytes", "deadlineAt"];
const ADDRESS_KEYS = ["address", "family"];
const MAX_INPUT_BYTES = 16_384;
const MAX_RESPONSE_BYTES = 10_485_760;

class HelperPolicyError extends Error {
  constructor(message, code = "https_failed") {
    super(message);
    this.name = "HelperPolicyError";
    this.code = code;
  }
}

function plainRecord(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HelperPolicyError(`${name} is invalid`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new HelperPolicyError(`${name} is invalid`);
  }
  return value;
}

function exactKeys(value, keys, name) {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new HelperPolicyError(`${name} is invalid`);
  }
}

function normalizedAddress(value) {
  try {
    return ipaddr.process(value).toNormalizedString();
  } catch {
    throw new HelperPolicyError("validated address is invalid");
  }
}

function peerMatches(expected, actual) {
  if (typeof actual !== "string" || actual === "") return false;
  try {
    return normalizedAddress(expected) === normalizedAddress(actual);
  } catch {
    return false;
  }
}

function parseInput(value, now) {
  const input = plainRecord(value, "helper input");
  exactKeys(input, INPUT_KEYS, "helper input");
  const address = plainRecord(input.address, "helper address");
  exactKeys(address, ADDRESS_KEYS, "helper address");
  if (typeof address.address !== "string" ||
      (address.family !== 4 && address.family !== 6) ||
      isIP(address.address) !== address.family ||
      normalizedAddress(address.address) !== address.address ||
      ipaddr.parse(address.address).range() !== "unicast") {
    throw new HelperPolicyError("validated address is invalid");
  }
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 ||
      input.maxBytes > MAX_RESPONSE_BYTES || !Number.isSafeInteger(input.deadlineAt) ||
      input.deadlineAt <= now() || input.deadlineAt - now() > 600_000) {
    throw new HelperPolicyError("helper limits are invalid");
  }
  let url;
  try {
    url = new URL(input.url);
  } catch {
    throw new HelperPolicyError("helper URL is invalid");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" ||
      (url.port !== "" && url.port !== "443") || url.hash !== "") {
    throw new HelperPolicyError("helper URL is invalid");
  }
  return Object.freeze({
    url,
    address: Object.freeze({ address: address.address, family: address.family }),
    maxBytes: input.maxBytes,
    deadlineAt: input.deadlineAt,
  });
}

function responseHeader(headers, name) {
  const value = headers[name.toLowerCase()];
  if (typeof value === "string" || value === undefined) return value;
  return value.join(", ");
}

function publicHeaders(value) {
  const headers = plainRecord(value, "response headers");
  const entries = Object.entries(headers);
  if (entries.length > 200) throw new HelperPolicyError("response headers are invalid");
  const result = {};
  for (const [key, raw] of entries) {
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]{1,100}$/.test(key)) {
      throw new HelperPolicyError("response headers are invalid");
    }
    if (typeof raw === "string") {
      if (raw.length > 16_384 || /[\r\n\0]/.test(raw)) {
        throw new HelperPolicyError("response headers are invalid");
      }
      result[key] = raw;
      continue;
    }
    if (!Array.isArray(raw) || raw.length > 32 || raw.some((item) =>
      typeof item !== "string" || item.length > 16_384 || /[\r\n\0]/.test(item)
    )) {
      throw new HelperPolicyError("response headers are invalid");
    }
    result[key] = raw;
  }
  return Object.freeze(result);
}

function requestOptions(input) {
  const lookup = ((_hostname, options, callback) => {
    if (typeof options === "object" && options !== null && options.all === true) {
      callback(null, [{ address: input.address.address, family: input.address.family }]);
      return;
    }
    callback(null, input.address.address, input.address.family);
  });
  return {
    protocol: "https:",
    hostname: input.url.hostname,
    port: 443,
    path: `${input.url.pathname}${input.url.search}`,
    method: "GET",
    servername: input.url.hostname,
    lookup,
    agent: false,
    rejectUnauthorized: true,
    headers: {
      Accept: "text/html",
      "Accept-Encoding": "identity",
      "Cache-Control": "no-cache",
      Connection: "close",
      Host: input.url.hostname,
      "User-Agent": "Ligou-Discovery-Gateway/1.0",
    },
  };
}

export function performPinnedHttpsRequest(value, dependencies = {}) {
  const now = dependencies.now ?? Date.now;
  const requestImpl = dependencies.request ?? https.request;
  const setTimer = dependencies.setTimeout ?? setTimeout;
  const clearTimer = dependencies.clearTimeout ?? clearTimeout;
  const onHeaders = dependencies.onHeaders;
  const onMeter = dependencies.onMeter;
  const onData = dependencies.onData;
  const onDrain = dependencies.onDrain;
  const input = parseInput(value, now);

  return new Promise((resolve, reject) => {
    const remaining = input.deadlineAt - now();
    if (remaining <= 0) {
      reject(new HelperPolicyError("attempt deadline exceeded", "deadline"));
      return;
    }
    let settled = false;
    let deadlineTimer;
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer !== undefined) clearTimer(deadlineTimer);
      reject(error instanceof Error ? error : new HelperPolicyError("HTTPS request failed"));
    };
    const request = requestImpl(requestOptions(input), (response) => {
      const remoteAddress = response.socket?.remoteAddress;
      if (!peerMatches(input.address.address, remoteAddress)) {
        response.destroy();
        finishReject(new HelperPolicyError("peer address mismatch", "peer_address_mismatch"));
        return;
      }
      let headers;
      try {
        headers = publicHeaders(response.headers);
      } catch (error) {
        response.destroy();
        finishReject(error);
        return;
      }
      const declaredLengthText = responseHeader(headers, "content-length");
      const transferEncoding = responseHeader(headers, "transfer-encoding");
      if (declaredLengthText !== undefined && transferEncoding !== undefined) {
        response.destroy();
        finishReject(new HelperPolicyError("response framing is invalid"));
        return;
      }
      let declaredLength;
      if (declaredLengthText !== undefined) {
        if (!/^(?:0|[1-9][0-9]*)$/.test(declaredLengthText) ||
            Number(declaredLengthText) > input.maxBytes) {
          response.destroy();
          finishReject(new HelperPolicyError("response byte limit exceeded", "response_byte_limit"));
          return;
        }
        declaredLength = Number(declaredLengthText);
      }
      const pauseForDrain = (ready) => {
        if (ready !== false) return;
        if (typeof onDrain !== "function") {
          throw new HelperPolicyError("stream backpressure is unavailable");
        }
        response.pause();
        onDrain(() => { if (!settled) response.resume(); });
      };
      try {
        pauseForDrain(onHeaders?.({
          statusCode: response.statusCode ?? 0,
          headers,
          remoteAddress,
        }));
      } catch (error) {
        response.destroy();
        finishReject(error);
        return;
      }
      const chunks = onData === undefined ? [] : undefined;
      let byteLength = 0;
      response.on("data", (chunk) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteLength += buffer.byteLength;
        let meterReady;
        try {
          meterReady = onMeter?.(buffer.byteLength);
        } catch (error) {
          response.destroy();
          finishReject(error);
          return;
        }
        if (byteLength > input.maxBytes) {
          response.destroy();
          finishReject(new HelperPolicyError("response byte limit exceeded", "response_byte_limit"));
          return;
        }
        let dataReady;
        try {
          dataReady = onData?.(buffer);
          pauseForDrain(meterReady !== false && dataReady !== false);
        } catch (error) {
          response.destroy();
          finishReject(error);
          return;
        }
        chunks?.push(buffer);
      });
      response.on("end", () => {
        if (settled) return;
        if (declaredLength !== undefined && declaredLength !== byteLength) {
          finishReject(new HelperPolicyError("content length mismatch"));
          return;
        }
        settled = true;
        if (deadlineTimer !== undefined) clearTimer(deadlineTimer);
        const body = chunks === undefined ? Buffer.alloc(0) : Buffer.concat(chunks, byteLength);
        resolve(Object.freeze({
          statusCode: response.statusCode ?? 0,
          headers,
          bodyBase64: body.toString("base64"),
          remoteAddress,
          bodyBytesConsumed: byteLength,
        }));
      });
      response.on("error", finishReject);
    });
    request.setTimeout(Math.min(remaining, 30_000), () => {
      request.destroy(new HelperPolicyError("HTTPS request timed out", "deadline"));
    });
    deadlineTimer = setTimer(() => {
      request.destroy(new HelperPolicyError("attempt deadline exceeded", "deadline"));
    }, remaining);
    request.on("error", finishReject);
    request.end();
  });
}

async function readInput() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_INPUT_BYTES) throw new HelperPolicyError("helper input is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
}

async function main() {
  const writeEvent = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
  try {
    const response = await performPinnedHttpsRequest(await readInput(), {
      onHeaders: (headers) => writeEvent({ type: "headers", ...headers }),
      onMeter: (byteLength) => writeEvent({ type: "meter", byteLength }),
      onData: (body) => writeEvent({ type: "data", bodyBase64: body.toString("base64") }),
      onDrain: (resume) => process.stdout.once("drain", resume),
    });
    writeEvent({ type: "end", bodyBytesConsumed: response.bodyBytesConsumed });
  } catch (error) {
    const code = error instanceof HelperPolicyError ? error.code : "https_failed";
    writeEvent({ type: "error", error: code });
  }
}

const invokedPath = process.argv[1];
if (typeof invokedPath === "string" && import.meta.url === pathToFileURL(invokedPath).href) {
  void main().catch(() => { process.exitCode = 1; });
}
