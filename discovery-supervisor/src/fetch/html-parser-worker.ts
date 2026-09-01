import { parentPort } from "node:worker_threads";
import { parseStaticHtml } from "./html-page";

const port = parentPort;
if (port === null) throw new Error("HTML parser worker requires a parent port");

port.once("message", (bytes: Uint8Array) => {
  try {
    port.postMessage({ ok: true, page: parseStaticHtml(Buffer.from(bytes)) });
  } catch (error) {
    port.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
