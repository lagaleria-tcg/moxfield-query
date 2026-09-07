import "./playwright-env.js";
import {
  chromium,
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
const PAGE_CONCURRENCY = 6;
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export type MoxfieldFetchVia =
  | "network-intercept"
  | "cookie-replay"
  | "browser-request";

export type MoxfieldBrowserFetchResult = {
  kind: MoxfieldKind;
  publicId: string;
  data: unknown;
  /** How the JSON was obtained. */
  via: MoxfieldFetchVia;
  /** Present for decks so existing clients keep working. */
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
 * Playwright is only used to pass Cloudflare (real Chrome + cookies).
 * Paginated resources then replay api2 from Node with those cookies, in
 * parallel. If Cloudflare still blocks Node, pages are fetched inside the
 * browser in concurrent batches.
 */
export async function fetchMoxfieldViaBrowser(
  target: MoxfieldTarget,
): Promise<MoxfieldBrowserFetchResult> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    locale: "en-US",
    userAgent: BROWSER_UA,
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  const page = await context.newPage();
  try {
    const intercept = waitForResourceApiResponse(page, target.kind);
    await page.goto(moxfieldPageUrl(target), {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });

    let intercepted: unknown = null;
    try {
      intercepted = await intercept;
    } catch {
      intercepted = null;
    }

    if (target.kind === "deck") {
      if (intercepted) {
        return toResult(target, intercepted, "network-intercept");
      }
      const data = await fetchFirstFromCandidates(page, null, target);
      return toResult(target, data.body, data.via);
    }

    if (
      intercepted &&
      (!isPaginatedPayload(intercepted) || intercepted.totalPages <= 1)
    ) {
      return toResult(target, intercepted, "network-intercept");
    }

    const cookies = await cookieHeader(context);
    const first = await fetchFirstFromCandidates(page, cookies, target);
    const data = await expandPages(page, cookies, first.body, first.templateUrl, first.via);
    return toResult(target, data, first.via);
  } finally {
    await context.close();
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
  cookies: string | null,
  target: MoxfieldTarget,
): Promise<{ body: unknown; templateUrl: string; via: MoxfieldFetchVia }> {
  for (const url of apiCandidateUrls(target)) {
    if (cookies) {
      const fromNode = await fetchJsonFromNode(url, cookies);
      if (fromNode.ok) {
        return { body: fromNode.body, templateUrl: url, via: "cookie-replay" };
      }
    }
    const fromBrowser = await fetchJsonInBrowser(page, url);
    if (fromBrowser.ok) {
      return { body: fromBrowser.body, templateUrl: url, via: "browser-request" };
    }
  }

  throw new Error(
    `Moxfield browser fetch failed for ${target.kind}=${target.publicId} (intercept + api)`,
  );
}

async function expandPages(
  page: Page,
  cookies: string | null,
  firstPage: unknown,
  templateUrl: string,
  via: MoxfieldFetchVia,
): Promise<unknown> {
  if (!isPaginatedPayload(firstPage) || firstPage.totalPages <= 1) {
    return firstPage;
  }

  const urls = pageUrls(templateUrl, 2, firstPage.totalPages);
  const rest = await fetchPages(page, cookies, urls, via);
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
  cookies: string | null,
  urls: string[],
  via: MoxfieldFetchVia,
): Promise<unknown[]> {
  if (urls.length === 0) {
    return [];
  }

  if (via === "cookie-replay" && cookies) {
    const fromNode = await mapPool(urls, PAGE_CONCURRENCY, (url) =>
      fetchJsonFromNode(url, cookies),
    );
    if (fromNode.every((r) => r.ok)) {
      return fromNode.map((r) => r.body);
    }
  }

  const fromBrowser = await fetchJsonBatchInBrowser(page, urls);
  if (!fromBrowser.every((r) => r.ok)) {
    const failed = fromBrowser.find((r) => !r.ok);
    throw new Error(
      `Moxfield page fetch failed (status=${failed && !failed.ok ? failed.status : "?"})`,
    );
  }
  return fromBrowser.map((r) => r.body);
}

async function fetchJsonBatchInBrowser(
  page: Page,
  urls: string[],
): Promise<JsonFetch[]> {
  const batches = chunk(urls, PAGE_CONCURRENCY);
  const out: JsonFetch[] = [];
  for (const batch of batches) {
    const part = await page.evaluate(async (apiUrls) => {
      const headers = {
        Accept: "application/json, text/plain, */*",
        Referer: "https://www.moxfield.com/",
      };
      return Promise.all(
        apiUrls.map(async (apiUrl) => {
          try {
            const res = await fetch(apiUrl, { headers, credentials: "include" });
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
        }),
      );
    }, batch);
    out.push(...part);
    if (part.some((r) => !r.ok)) {
      break;
    }
  }
  return out;
}

async function fetchJsonInBrowser(page: Page, url: string): Promise<JsonFetch> {
  const [result] = await fetchJsonBatchInBrowser(page, [url]);
  return result ?? { ok: false, status: 0, error: "empty batch" };
}

async function fetchJsonFromNode(url: string, cookies: string): Promise<JsonFetch> {
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json, text/plain, */*",
        Referer: "https://www.moxfield.com/",
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
    return {
      ok: false,
      status: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function cookieHeader(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies();
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T);
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
