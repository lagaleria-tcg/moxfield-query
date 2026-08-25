import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { fetchMoxfieldDeckViaBrowser, closeBrowser } from "./fetch-deck.js";

const PORT = Number(process.env.PORT ?? 8791);
const HOST = process.env.HOST ?? "0.0.0.0";
const SHARED_SECRET = process.env.MOXFIELD_FETCHER_SECRET ?? "";

const PUBLIC_ID_RE = /^[a-zA-Z0-9_-]+$/;
const DECK_PATH_RE = /^\/v1\/decks\/([^/]+)$/;

function sendJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function authorize(req: IncomingMessage): boolean {
  if (!SHARED_SECRET) {
    return true;
  }
  const header = req.headers.authorization ?? "";
  const apiKey = req.headers["x-api-key"];
  const key = Array.isArray(apiKey) ? apiKey[0] : apiKey;
  return header === `Bearer ${SHARED_SECRET}` || key === SHARED_SECRET;
}

function parsePublicId(url: URL): string {
  const fromQuery = url.searchParams.get("publicId")?.trim() ?? "";
  if (fromQuery) {
    return fromQuery;
  }

  const match = url.pathname.match(DECK_PATH_RE);
  if (!match?.[1] || match[1] === "fetch") {
    return "";
  }
  try {
    return decodeURIComponent(match[1]).trim();
  } catch {
    return "";
  }
}

function isDeckGet(method: string, pathname: string): boolean {
  if (method !== "GET") {
    return false;
  }
  return (
    pathname === "/v1/decks" ||
    pathname === "/v1/decks/fetch" ||
    DECK_PATH_RE.test(pathname)
  );
}

let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function handleFetchDeck(
  req: IncomingMessage,
  res: ServerResponse,
  publicId: string,
): Promise<void> {
  if (!authorize(req)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  if (!publicId || !PUBLIC_ID_RE.test(publicId)) {
    sendJson(res, 400, { error: "publicId required (Moxfield deck id)" });
    return;
  }

  const started = Date.now();
  try {
    const { deck, via } = await enqueue(() =>
      fetchMoxfieldDeckViaBrowser(publicId),
    );
    console.log("fetched", {
      publicId,
      via,
      ms: Date.now() - started,
    });
    sendJson(res, 200, { deck, via, publicId });
  } catch (e) {
    console.error("moxfield-fetcher failed", {
      publicId,
      ms: Date.now() - started,
      message: e instanceof Error ? e.message : String(e),
    });
    sendJson(res, 502, {
      error: "Failed to fetch Moxfield deck via browser",
      detail: e instanceof Error ? e.message : String(e),
    });
  }
}

function advertisedUrls(): string[] {
  const urls = [`http://127.0.0.1:${PORT}`];
  if (HOST === "0.0.0.0" || HOST === "::") {
    for (const list of Object.values(networkInterfaces())) {
      for (const net of list ?? []) {
        const ipv4 = net.family === "IPv4" || (net.family as unknown) === 4;
        if (ipv4 && !net.internal) {
          urls.push(`http://${net.address}:${PORT}`);
        }
      }
    }
  } else if (HOST !== "127.0.0.1" && HOST !== "localhost") {
    urls.push(`http://${HOST}:${PORT}`);
  }
  return urls;
}

const server = createServer((req, res) => {
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`,
  );
  const method = req.method ?? "GET";
  console.log(`${method} ${url.pathname}${url.search}`);

  if (method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (isDeckGet(method, url.pathname)) {
    void handleFetchDeck(req, res, parsePublicId(url));
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

server.requestTimeout = 120_000;
server.headersTimeout = 120_000;
server.timeout = 0;

server.listen(PORT, HOST, () => {
  const urls = advertisedUrls().join("\n  ");
  console.log(`moxfield-fetcher listening on ${HOST}:${PORT}`);
  console.log(`reachable at:\n  ${urls}`);
  console.log("GET /health");
  console.log("GET /v1/decks/:publicId");
  console.log("GET /v1/decks?publicId=<id>");
  console.log(
    `secret ${SHARED_SECRET ? "set" : "UNSET — open on this host"}`,
  );
  console.log(
    "Moxfield is queried from this machine (Playwright / localhost origin).",
  );
  console.log(
    "To expose beyond LAN: npm run tunnel  (in another terminal, with this server running)",
  );
});

async function shutdown(signal: string): Promise<void> {
  console.log(`shutting down (${signal})…`);
  server.close();
  await closeBrowser();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
