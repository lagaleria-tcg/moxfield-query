import "./playwright-env.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { chromium } from "playwright";
import { getFeaturedExpansion } from "./featured-expansion.js";
import { fetchMoxfieldViaBrowser, closeBrowser } from "./fetch-deck.js";
import { fetchWizardsHeroAssets } from "./wizards-hero.js";
import {
  isPublicId,
  parseMoxfieldTarget,
  resolveKindAlias,
  type MoxfieldTarget,
} from "./moxfield-resource.js";

const PORT = Number(process.env.PORT ?? 8791);
const HOST = process.env.HOST ?? "0.0.0.0";
const SHARED_SECRET = process.env.MOXFIELD_FETCHER_SECRET ?? "";

const RESOURCE_PATH_RE =
  /^\/v1\/(decks?|collections?|binders?|lists?|bookmarks?)(?:\/([^/]+))?$/;
const FETCH_PATHS = new Set(["/v1/fetch", "/v1/decks/fetch"]);

function sendJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): number {
  const payload = JSON.stringify(body);
  const bytes = Buffer.byteLength(payload);
  if (res.writableEnded || res.destroyed) {
    return bytes;
  }
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": bytes,
  });
  res.end(payload);
  return bytes;
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const err = error as { name?: string; message?: string };
  return (
    err.name === "AbortError" ||
    (typeof err.message === "string" && /aborted/i.test(err.message))
  );
}

function summarizeMoxfieldData(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object") {
    return { dataType: data === null ? "null" : typeof data };
  }

  const rec = data as Record<string, unknown>;
  const rows = Array.isArray(rec.data) ? rec.data : null;
  const user =
    rec.user && typeof rec.user === "object"
      ? (rec.user as { displayName?: string; userName?: string })
      : null;
  const boards =
    rec.boards && typeof rec.boards === "object" && !Array.isArray(rec.boards)
      ? (rec.boards as Record<string, { cards?: Record<string, unknown> }>)
      : null;
  const mainboard = boards?.mainboard?.cards;
  const sample = (rows ?? []).slice(0, 5).map((row) => {
    if (!row || typeof row !== "object") {
      return row;
    }
    const item = row as Record<string, unknown>;
    const card =
      item.card && typeof item.card === "object"
        ? (item.card as { name?: string; set?: string })
        : null;
    return {
      quantity: item.quantity ?? null,
      name: card?.name ?? (typeof item.name === "string" ? item.name : null),
      set: card?.set ?? null,
    };
  });

  const items = rows
    ? rows.length
    : mainboard && typeof mainboard === "object"
      ? Object.keys(mainboard).length
      : rec.mainboard && typeof rec.mainboard === "object"
        ? Object.keys(rec.mainboard as object).length
        : undefined;
  const totalResults =
    typeof rec.totalResults === "number" ? rec.totalResults : undefined;

  return {
    name:
      typeof rec.name === "string"
        ? rec.name
        : user?.displayName ?? user?.userName ?? null,
    keys: Object.keys(rec).slice(0, 20),
    items,
    totalResults,
    complete:
      typeof items === "number" && typeof totalResults === "number"
        ? items >= totalResults
        : undefined,
    sample,
  };
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

function parseTarget(url: URL): MoxfieldTarget | null {
  const fromUrl = url.searchParams.get("url")?.trim() ?? "";
  if (fromUrl) {
    return parseMoxfieldTarget(fromUrl);
  }

  const fromQuery = url.searchParams.get("publicId")?.trim() ?? "";
  const pathMatch = url.pathname.match(RESOURCE_PATH_RE);
  const pathKind = resolveKindAlias(pathMatch?.[1] ?? "decks") || "deck";
  const pathId = pathMatch?.[2] && pathMatch[2] !== "fetch" ? pathMatch[2] : "";

  let decodedPathId = "";
  if (pathId) {
    try {
      decodedPathId = decodeURIComponent(pathId).trim();
    } catch {
      decodedPathId = pathId.trim();
    }
  }

  const raw = fromQuery || decodedPathId;
  if (!raw) {
    return null;
  }
  return parseMoxfieldTarget(raw, pathKind);
}

function isMoxfieldGet(method: string, pathname: string): boolean {
  if (method !== "GET") {
    return false;
  }
  return FETCH_PATHS.has(pathname) || RESOURCE_PATH_RE.test(pathname);
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

async function handleFeaturedExpansion(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!authorize(req)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  const started = Date.now();
  try {
    const expansion = await getFeaturedExpansion();
    if (!expansion) {
      sendJson(res, 502, { error: "Failed to resolve featured expansion" });
      return;
    }
    console.log("featured-expansion", {
      code: expansion.code,
      usesWizardsBackground: expansion.usesWizardsBackground,
      ms: Date.now() - started,
    });
    sendJson(res, 200, expansion);
  } catch (e) {
    console.error("featured-expansion failed", {
      ms: Date.now() - started,
      message: e instanceof Error ? e.message : String(e),
    });
    sendJson(res, 502, {
      error: "Failed to resolve featured expansion",
      detail: e instanceof Error ? e.message : String(e),
    });
  }
}

async function handleWizardsHero(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!authorize(req)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  const started = Date.now();
  try {
    const assets = await fetchWizardsHeroAssets();
    console.log("wizards-hero", {
      hasBanner: Boolean(assets.bannerUrl),
      hasLogo: Boolean(assets.logoUrl),
      ms: Date.now() - started,
    });
    sendJson(res, 200, assets);
  } catch (e) {
    console.error("wizards-hero failed", {
      ms: Date.now() - started,
      message: e instanceof Error ? e.message : String(e),
    });
    sendJson(res, 502, {
      error: "Failed to scrape Wizards hero",
      detail: e instanceof Error ? e.message : String(e),
    });
  }
}

async function handleFetchMoxfield(
  req: IncomingMessage,
  res: ServerResponse,
  target: MoxfieldTarget | null,
): Promise<void> {
  if (!authorize(req)) {
    sendJson(res, 401, { error: "Unauthorized" });
    console.log("GET moxfield response", { status: 401, error: "Unauthorized" });
    return;
  }

  if (!target || !isPublicId(target.publicId)) {
    sendJson(res, 400, {
      error:
        "Moxfield url or publicId required (e.g. /collection/{id}, /decks/{id}, /binders/{id}, /lists/{id})",
    });
    console.log("GET moxfield response", {
      status: 400,
      error: "Moxfield url or publicId required",
      path: req.url ?? "",
    });
    return;
  }

  console.log("GET moxfield", {
    kind: target.kind,
    publicId: target.publicId,
    path: req.url ?? "",
  });

  const started = Date.now();
  const ac = new AbortController();
  let finished = false;
  const onClientGone = () => {
    if (finished || ac.signal.aborted || res.writableEnded) {
      return;
    }
    console.log("GET moxfield aborted", {
      kind: target.kind,
      publicId: target.publicId,
      ms: Date.now() - started,
      reqDestroyed: req.destroyed,
      resDestroyed: res.destroyed,
    });
    ac.abort();
  };
  req.once("close", onClientGone);
  res.once("close", onClientGone);

  try {
    const fetched = await enqueue(() =>
      fetchMoxfieldViaBrowser(target, ac.signal),
    );
    if (ac.signal.aborted) {
      console.log("GET moxfield response", {
        status: "aborted",
        kind: fetched.kind,
        publicId: fetched.publicId,
        via: fetched.via,
        ms: Date.now() - started,
        ...summarizeMoxfieldData(fetched.data),
      });
      return;
    }
    console.log("GET moxfield serializing", {
      kind: fetched.kind,
      publicId: fetched.publicId,
      ms: Date.now() - started,
    });
    const body = {
      kind: fetched.kind,
      publicId: fetched.publicId,
      via: fetched.via,
      data: fetched.data,
      ...(fetched.kind === "deck" ? { deck: fetched.data } : {}),
    };
    const bytes = sendJson(res, 200, body);
    console.log("GET moxfield response", {
      status: 200,
      kind: fetched.kind,
      publicId: fetched.publicId,
      via: fetched.via,
      bytes,
      ms: Date.now() - started,
      ...summarizeMoxfieldData(fetched.data),
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    if (ac.signal.aborted || isAbortError(e)) {
      console.log("GET moxfield response", {
        status: "aborted",
        kind: target.kind,
        publicId: target.publicId,
        ms: Date.now() - started,
        error: detail,
      });
      return;
    }
    const bytes = sendJson(res, 502, {
      error: `Failed to fetch Moxfield ${target.kind} via browser`,
      detail,
    });
    console.error("GET moxfield response", {
      status: 502,
      kind: target.kind,
      publicId: target.publicId,
      bytes,
      ms: Date.now() - started,
      error: detail,
    });
  } finally {
    finished = true;
    req.off("close", onClientGone);
    res.off("close", onClientGone);
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

  if (isMoxfieldGet(method, url.pathname)) {
    void handleFetchMoxfield(req, res, parseTarget(url));
    return;
  }

  if (method === "GET" && url.pathname === "/v1/featured-expansion") {
    void handleFeaturedExpansion(req, res);
    return;
  }

  if (method === "GET" && url.pathname === "/v1/wizards-hero") {
    void handleWizardsHero(req, res);
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
  console.log(`Chromium executable: ${chromium.executablePath()}`);
  console.log(`reachable at:\n  ${urls}`);
  console.log("GET /health");
  console.log("GET /v1/decks/:publicId");
  console.log("GET /v1/collections/:publicId");
  console.log("GET /v1/binders/:publicId");
  console.log("GET /v1/lists/:publicId");
  console.log("GET /v1/fetch?url=https://www.moxfield.com/collection/<id>");
  console.log("GET /v1/featured-expansion");
  console.log("GET /v1/wizards-hero");
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
