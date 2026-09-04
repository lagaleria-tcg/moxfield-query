/**
 * Read magic.wizards.com home hero slide 0 (banner art + product logo).
 * Depends on public HTML; update the parser if the markup changes.
 */

const WIZARDS_HOME_EN = "https://magic.wizards.com/en";
const FETCH_TIMEOUT_MS = 20_000;

const FETCH_HEADERS = {
  "User-Agent":
    "LaGaleria/1.0 (+https://github.com/lagaleria-tcg/moxfield-query) featured-expansion",
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "en-US,en;q=0.9",
} as const;

export type WizardsHeroAssets = {
  bannerUrl: string | null;
  logoUrl: string | null;
};

function normalizeAssetUrl(raw: string): string {
  const t = raw.trim();
  if (t.startsWith("//")) {
    return `https:${t}`;
  }
  return t;
}

/**
 * Inside the first `data-slide-index="0"` block, `<img src>` order is typically:
 * 0 — banner art (picture `img` fallback)
 * 1 — product logo / title treatment
 */
export function parseWizardsHeroSlide0(html: string): WizardsHeroAssets {
  const marker = 'data-slide-index="0"';
  const start = html.indexOf(marker);
  if (start === -1) {
    return { bannerUrl: null, logoUrl: null };
  }

  const fromSlide = html.slice(start);
  const nextSlide = fromSlide.search(/data-slide-index="1"/);
  const chunk =
    nextSlide === -1 ? fromSlide.slice(0, 28000) : fromSlide.slice(0, nextSlide);

  const urls: string[] = [];
  const imgRe = /<img[^>]+src="([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(chunk)) !== null) {
    urls.push(normalizeAssetUrl(m[1]!));
  }

  return {
    bannerUrl: urls[0] ?? null,
    logoUrl: urls[1] ?? null,
  };
}

export async function fetchWizardsHeroAssets(): Promise<WizardsHeroAssets> {
  try {
    const res = await fetch(WIZARDS_HOME_EN, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { bannerUrl: null, logoUrl: null };
    }
    const html = await res.text();
    return parseWizardsHeroSlide0(html);
  } catch {
    return { bannerUrl: null, logoUrl: null };
  }
}
