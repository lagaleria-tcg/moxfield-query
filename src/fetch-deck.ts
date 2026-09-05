import "./playwright-env.js";
import { chromium, type Browser, type Page } from "playwright";
import {
  apiCandidateUrls,
  interceptPattern,
  isPaginatedPayload,
  moxfieldPageUrl,
  nextPageUrl,
  type MoxfieldKind,
  type MoxfieldTarget,
} from "./moxfield-resource.js";

const NAV_TIMEOUT_MS = 45_000;
const RESPONSE_TIMEOUT_MS = 30_000;

export type MoxfieldBrowserFetchResult = {
  kind: MoxfieldKind;
  publicId: string;
  data: unknown;
  /** How the JSON was obtained. */
  via: "network-intercept" | "browser-request";
  /** Present for decks so existing clients keep working. */
  deck?: unknown;
};

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
 * Loads a public Moxfield page and captures the same JSON the SPA requests
 * from api2 (preferred), with a direct browser-context request as fallback.
 */
export async function fetchMoxfieldViaBrowser(
  target: MoxfieldTarget,
): Promise<MoxfieldBrowserFetchResult> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    locale: "en-US",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  const page = await context.newPage();
  try {
    const intercept = waitForResourceApiResponse(page, target.kind);
    const pageUrl = moxfieldPageUrl(target);

    await page.goto(pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });

    try {
      const intercepted = await intercept;
      const data = await expandIfPaginated(page, target, intercepted);
      return toResult(target, data, "network-intercept");
    } catch {
      const data = await fetchResourceJsonInBrowser(page, target);
      return toResult(target, data, "browser-request");
    }
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
  via: MoxfieldBrowserFetchResult["via"],
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

async function fetchResourceJsonInBrowser(
  page: Page,
  target: MoxfieldTarget,
): Promise<unknown> {
  const urls = apiCandidateUrls(target);

  for (const url of urls) {
    const first = await fetchJsonInBrowser(page, url);
    if (!first.ok) {
      continue;
    }
    return collectPages(page, first.body, url);
  }

  throw new Error(
    `Moxfield browser fetch failed for ${target.kind}=${target.publicId} (intercept + api)`,
  );
}

/**
 * SPA intercepts are usually page 1 at a smaller pageSize. For collections
 * and binders, refetch every page from our API URL so the payload is complete.
 */
async function expandIfPaginated(
  page: Page,
  target: MoxfieldTarget,
  intercepted: unknown,
): Promise<unknown> {
  if (!isPaginatedPayload(intercepted) || intercepted.totalPages <= 1) {
    return intercepted;
  }

  for (const url of apiCandidateUrls(target)) {
    const first = await fetchJsonInBrowser(page, url);
    if (!first.ok) {
      continue;
    }
    return collectPages(page, first.body, url);
  }

  return intercepted;
}

async function collectPages(
  page: Page,
  firstPage: unknown,
  templateUrl: string,
): Promise<unknown> {
  if (!isPaginatedPayload(firstPage) || firstPage.totalPages <= 1) {
    return firstPage;
  }

  const pages = [firstPage];
  for (let n = 2; n <= firstPage.totalPages; n += 1) {
    const next = await fetchJsonInBrowser(page, nextPageUrl(templateUrl, n));
    if (!next.ok || !isPaginatedPayload(next.body)) {
      break;
    }
    pages.push(next.body);
  }

  const data = pages.flatMap((p) => p.data);
  return {
    ...firstPage,
    pageNumber: 1,
    pageSize: data.length,
    totalPages: 1,
    data,
  };
}

async function fetchJsonInBrowser(
  page: Page,
  url: string,
): Promise<
  | { ok: true; body: unknown }
  | { ok: false; status: number; error?: string }
> {
  return page.evaluate(async (apiUrl) => {
    try {
      const res = await fetch(apiUrl, {
        headers: {
          Accept: "application/json, text/plain, */*",
          Referer: "https://www.moxfield.com/",
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
