import "./playwright-env.js";
import {
  chromium,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import {
  apiCandidateUrls,
  interceptPattern,
  isPaginatedPayload,
  moxfieldPageUrl,
  pageUrls,
  type MoxfieldKind,
  type MoxfieldTarget,
} from "./moxfield-resource.js";

const NAV_TIMEOUT_MS = 45_000;
const RESPONSE_TIMEOUT_MS = 30_000;
const PAGE_FETCH_TIMEOUT_MS = 20_000;
const PAGE_CONCURRENCY = 4;
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const API_HEADERS = {
  Accept: "application/json, text/plain, */*",
  Referer: "https://www.moxfield.com/",
  Origin: "https://www.moxfield.com",
};

export type MoxfieldFetchVia =
  | "network-intercept"
  | "cookie-replay"
  | "context-request"
  | "browser-request";

export type MoxfieldBrowserFetchResult = {
  kind: MoxfieldKind;
  publicId: string;
  data: unknown;
  via: MoxfieldFetchVia;
  deck?: unknown;
};

type JsonFetch =
  | { ok: true; body: unknown }
  | { ok: false; status: number; error?: string };

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium
      .launch({
        headless: true,
        chromiumSandbox: false,
        args: [
          "--disable-blink-features=AutomationControlled",
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-extensions",
        ],
      })
      .catch((err: unknown) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

export async function closeBrowser(): Promise<void> {
  if (!browserPromise) {
    return;
  }
  const browser = await browserPromise;
  browserPromise = null;
  await browser.close();
}

/**
 * Playwright solves Cloudflare. Remaining collection pages should come from
 * Node or Playwright's APIRequestContext so we do not serialize thousands of
 * cards through page.evaluate (that OOMs small Render instances).
 */
export async function fetchMoxfieldViaBrowser(
  target: MoxfieldTarget,
  signal?: AbortSignal,
): Promise<MoxfieldBrowserFetchResult> {
  throwIfAborted(signal);
  const started = Date.now();
  const browser = await getBrowser();
  const context = await browser.newContext({
    locale: "en-US",
    userAgent: BROWSER_UA,
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  const onAbort = () => {
    void context.close();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const page = await context.newPage();
  try {
    console.log("moxfield fetch", {
      stage: "goto",
      kind: target.kind,
      publicId: target.publicId,
    });
    const intercept = waitForResourceApiResponse(page, target.kind);
    await page.goto(moxfieldPageUrl(target), {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });
    throwIfAborted(signal);

    let intercepted: unknown = null;
    try {
      intercepted = await intercept;
    } catch {
      intercepted = null;
    }
    console.log("moxfield fetch", {
      stage: "handshake",
      kind: target.kind,
      publicId: target.publicId,
      intercepted: Boolean(intercepted),
      ms: Date.now() - started,
    });

    if (target.kind === "deck") {
      if (intercepted) {
        return toResult(target, intercepted, "network-intercept");
      }
      const data = await fetchFirstFromCandidates(page, context, target, signal);
      return toResult(target, data.body, data.via);
    }

    if (
      intercepted &&
      (!isPaginatedPayload(intercepted) || intercepted.totalPages <= 1)
    ) {
      return toResult(target, intercepted, "network-intercept");
    }

    const first = await fetchFirstFromCandidates(page, context, target, signal);
    const firstMeta = isPaginatedPayload(first.body)
      ? {
          totalPages: first.body.totalPages,
          totalResults: first.body.totalResults,
        }
      : {};
    console.log("moxfield fetch", {
      stage: "first-page",
      kind: target.kind,
      publicId: target.publicId,
      via: first.via,
      ms: Date.now() - started,
      ...firstMeta,
    });
    const data = await expandPages(
      page,
      context,
      first.body,
      first.templateUrl,
      first.via,
      signal,
    );
    return toResult(target, data, first.via);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await context.close().catch(() => undefined);
  }
}

/** @deprecated Use fetchMoxfieldViaBrowser — kept for existing deck-only callers. */
export async function fetchMoxfieldDeckViaBrowser(
  publicId: string,
): Promise<MoxfieldBrowserFetchResult> {
  return fetchMoxfieldViaBrowser({ kind: "deck", publicId });
}

function toResult(
  target: MoxfieldTarget,
  data: unknown,
  via: MoxfieldFetchVia,
): MoxfieldBrowserFetchResult {
  const result: MoxfieldBrowserFetchResult = {
    kind: target.kind,
    publicId: target.publicId,
    data,
    via,
  };
  if (target.kind === "deck") {
    result.deck = data;
  }
  return result;
}

function waitForResourceApiResponse(page: Page, kind: MoxfieldKind): Promise<unknown> {
  const pattern = interceptPattern(kind);
  return page
    .waitForResponse(
      (res) =>
        pattern.test(res.url()) &&
        res.request().method() === "GET" &&
        res.ok(),
      { timeout: RESPONSE_TIMEOUT_MS },
    )
    .then((res) => res.json());
}

async function fetchFirstFromCandidates(
  page: Page,
  context: BrowserContext,
  target: MoxfieldTarget,
  signal?: AbortSignal,
): Promise<{ body: unknown; templateUrl: string; via: MoxfieldFetchVia }> {
  throwIfAborted(signal);
  const cookies = await cookieHeader(context);
  for (const url of apiCandidateUrls(target)) {
    const result = await fetchJson(page, context, url, cookies, signal);
    if (result.ok) {
      return { body: result.body, templateUrl: url, via: result.via };
    }
    console.log("moxfield fetch", {
      stage: "candidate-miss",
      url,
      via: result.via,
      status: result.status,
      error: result.error ?? null,
    });
  }

  throw new Error(
    `Moxfield browser fetch failed for ${target.kind}=${target.publicId} (intercept + api)`,
  );
}

async function expandPages(
  page: Page,
  context: BrowserContext,
  firstPage: unknown,
  templateUrl: string,
  via: MoxfieldFetchVia,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!isPaginatedPayload(firstPage) || firstPage.totalPages <= 1) {
    return firstPage;
  }

  const urls = pageUrls(templateUrl, 2, firstPage.totalPages);
  console.log("moxfield fetch", {
    stage: "pages",
    via,
    remaining: urls.length,
    totalPages: firstPage.totalPages,
    totalResults: firstPage.totalResults ?? null,
  });
  const rest = await fetchPages(page, context, urls, via, signal);
  const pages = [firstPage, ...rest];
  const data = pages.flatMap((p) => (isPaginatedPayload(p) ? p.data : []));
  const expected =
    typeof firstPage.totalResults === "number" ? firstPage.totalResults : null;

  if (expected !== null && data.length < expected) {
    throw new Error(
      `Moxfield ${via} incomplete: got ${data.length}/${expected} items ` +
        `(${pages.length}/${firstPage.totalPages} pages)`,
    );
  }

  return {
    ...firstPage,
    pageNumber: 1,
    pageSize: data.length,
    totalPages: 1,
    data,
  };
}

async function fetchPages(
  page: Page,
  context: BrowserContext,
  urls: string[],
  via: MoxfieldFetchVia,
  signal?: AbortSignal,
): Promise<unknown[]> {
  if (urls.length === 0) {
    return [];
  }

  const cookies = await cookieHeader(context);
  const preferEvaluate = via === "browser-request";
  const out: unknown[] = [];

  if (!preferEvaluate) {
    const fromFast = await mapPool(urls, PAGE_CONCURRENCY, async (url, index) => {
      throwIfAborted(signal);
      const result = await fetchJson(page, context, url, cookies, signal, {
        allowEvaluate: false,
      });
      if ((index + 1) % 8 === 0 || index + 1 === urls.length) {
        console.log("moxfield fetch", {
          stage: "pages-progress",
          done: index + 1,
          remaining: urls.length,
        });
      }
      return result;
    });
    if (fromFast.every((r) => r.ok)) {
      return fromFast.map((r) => r.body);
    }
    console.log("moxfield fetch", {
      stage: "pages-fallback-evaluate",
      failed: fromFast.filter((r) => !r.ok).length,
    });
  }

  for (const [index, url] of urls.entries()) {
    throwIfAborted(signal);
    const result = await fetchJsonInBrowser(page, url);
    if (!result.ok) {
      throw new Error(
        `Moxfield page fetch failed (status=${result.status} page=${index + 2})`,
      );
    }
    out.push(result.body);
    if ((index + 1) % 4 === 0 || index + 1 === urls.length) {
      console.log("moxfield fetch", {
        stage: "pages-progress",
        via: "browser-request",
        done: index + 1,
        remaining: urls.length,
      });
    }
  }
  return out;
}

async function fetchJson(
  page: Page,
  context: BrowserContext,
  url: string,
  cookies: string,
  signal?: AbortSignal,
  options?: { allowEvaluate?: boolean },
): Promise<JsonFetch & { via: MoxfieldFetchVia }> {
  const allowEvaluate = options?.allowEvaluate ?? true;

  if (cookies) {
    const fromNode = await fetchJsonFromNode(url, cookies, signal);
    if (fromNode.ok) {
      return { ...fromNode, via: "cookie-replay" };
    }
  }

  const fromContext = await fetchJsonFromContext(context.request, url);
  if (fromContext.ok) {
    return { ...fromContext, via: "context-request" };
  }

  if (!allowEvaluate) {
    return { ...fromContext, via: "context-request" };
  }

  const fromBrowser = await fetchJsonInBrowser(page, url);
  return { ...fromBrowser, via: "browser-request" };
}

async function fetchJsonFromContext(
  request: APIRequestContext,
  url: string,
): Promise<JsonFetch> {
  try {
    const res = await request.get(url, {
      timeout: PAGE_FETCH_TIMEOUT_MS,
      headers: API_HEADERS,
    });
    if (!res.ok()) {
      return { ok: false, status: res.status() };
    }
    const type = res.headers()["content-type"] ?? "";
    if (!type.includes("json")) {
      return { ok: false, status: res.status(), error: "not-json" };
    }
    return { ok: true, body: await res.json() };
  } catch (e) {
    if (isAbortError(e)) {
      throw e instanceof Error ? e : new Error("Moxfield fetch aborted");
    }
    return {
      ok: false,
      status: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function fetchJsonInBrowser(page: Page, url: string): Promise<JsonFetch> {
  return page.evaluate(async (apiUrl) => {
    try {
      const res = await fetch(apiUrl, {
        headers: {
          Accept: "application/json, text/plain, */*",
          Referer: "https://www.moxfield.com/",
          Origin: "https://www.moxfield.com",
        },
        credentials: "include",
      });
      if (!res.ok) {
        return { ok: false as const, status: res.status };
      }
      return { ok: true as const, body: await res.json() };
    } catch (e) {
      return {
        ok: false as const,
        status: 0,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }, url);
}

async function fetchJsonFromNode(
  url: string,
  cookies: string,
  signal?: AbortSignal,
): Promise<JsonFetch> {
  try {
    const res = await fetch(url, {
      signal: fetchSignal(signal),
      headers: {
        ...API_HEADERS,
        "User-Agent": BROWSER_UA,
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: cookies,
      },
    });
    if (!res.ok) {
      return { ok: false, status: res.status };
    }
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("json")) {
      return { ok: false, status: res.status, error: "not-json" };
    }
    return { ok: true, body: await res.json() };
  } catch (e) {
    if (isAbortError(e)) {
      throw e instanceof Error ? e : new Error("Moxfield fetch aborted");
    }
    return {
      ok: false,
      status: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
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

async function cookieHeader(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies([
    "https://www.moxfield.com/",
    "https://api2.moxfield.com/",
  ]);
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T, index);
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

function fetchSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS);
  if (!signal) {
    return timeout;
  }
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([signal, timeout]);
  }
  return signal;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error("Moxfield fetch aborted");
    err.name = "AbortError";
    throw err;
  }
}
