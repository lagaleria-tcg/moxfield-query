import { chromium, type Browser, type Page } from "playwright";

const DECK_API_PATH = /api2\.moxfield\.com\/v\d+\/decks\/all\//;
const NAV_TIMEOUT_MS = 45_000;
const RESPONSE_TIMEOUT_MS = 30_000;

export type MoxfieldBrowserFetchResult = {
  deck: unknown;
  /** How the JSON was obtained. */
  via: "network-intercept" | "browser-request";
};

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled"],
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
 * Loads a public Moxfield deck page and captures the same JSON the SPA requests
 * from api2 (preferred), with a direct browser-context request as fallback.
 */
export async function fetchMoxfieldDeckViaBrowser(
  publicId: string,
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
    const intercept = waitForDeckApiResponse(page);
    const deckUrl = `https://www.moxfield.com/decks/${encodeURIComponent(publicId)}`;

    await page.goto(deckUrl, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });

    try {
      const deck = await intercept;
      return { deck, via: "network-intercept" };
    } catch {
      // Cloudflare challenge or SPA never fired the XHR — try API from the browser context.
      const deck = await fetchDeckJsonInBrowser(page, publicId);
      return { deck, via: "browser-request" };
    }
  } finally {
    await context.close();
  }
}

function waitForDeckApiResponse(page: Page): Promise<unknown> {
  return page
    .waitForResponse(
      (res) =>
        DECK_API_PATH.test(res.url()) &&
        res.request().method() === "GET" &&
        res.ok(),
      { timeout: RESPONSE_TIMEOUT_MS },
    )
    .then((res) => res.json());
}

async function fetchDeckJsonInBrowser(
  page: Page,
  publicId: string,
): Promise<unknown> {
  const encoded = encodeURIComponent(publicId);
  const urls = [
    `https://api2.moxfield.com/v3/decks/all/${encoded}`,
    `https://api2.moxfield.com/v2/decks/all/${encoded}`,
  ];

  for (const url of urls) {
    const result = await page.evaluate(async (apiUrl) => {
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

    if (result.ok) {
      return result.body;
    }
  }

  throw new Error(
    `Moxfield browser fetch failed for publicId=${publicId} (intercept + api v3/v2)`,
  );
}
