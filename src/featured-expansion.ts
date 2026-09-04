/**
 * Latest paper-set hero for La Galería home.
 * Scryfall + Wizards homepage scrape, cached in-process (this host is not Vercel).
 */

import { fetchWizardsHeroAssets } from "./wizards-hero.js";

const SCRYFALL_USER_AGENT =
  "LaGaleria/1.0 (https://github.com/lagaleria-tcg/moxfield-query) featured-expansion";
const FETCH_TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 60 * 60 * 1000;

export type FeaturedExpansionPayload = {
  code: string;
  name: string;
  releasedAt: string;
  imageUrl: string | null;
  logoUrl: string | null;
  usesWizardsBackground: boolean;
};

type ScryfallSet = {
  code: string;
  name: string;
  released_at: string | null;
  set_type: string;
  digital_only: boolean;
};

type ScryfallList<T> = { data: T[]; has_more?: boolean; next_page?: string | null };

type ScryfallCardLite = {
  image_uris?: { normal?: string | null; large?: string | null } | null;
  card_faces?: Array<{ image_uris?: { normal?: string | null } | null }>;
};

type CacheEntry = {
  at: number;
  payload: FeaturedExpansionPayload | null;
};

let cache: CacheEntry | null = null;
let inflight: Promise<FeaturedExpansionPayload | null> | null = null;

function pickCardImage(card: ScryfallCardLite): string | null {
  const front = card.card_faces?.[0]?.image_uris?.normal;
  const direct = card.image_uris?.normal ?? card.image_uris?.large;
  return direct ?? front ?? null;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": SCRYFALL_USER_AGENT,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** `released_at` is `YYYY-MM-DD`; compare to “today” in America/Lima. */
function isReleasedOnOrBeforeToday(set: ScryfallSet): boolean {
  const d = set.released_at?.trim();
  if (!d) {
    return false;
  }
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/Lima",
  });
  return d <= today;
}

async function loadFeaturedExpansion(): Promise<FeaturedExpansionPayload | null> {
  const [list, wizards] = await Promise.all([
    fetchJson<ScryfallList<ScryfallSet>>("https://api.scryfall.com/sets"),
    fetchWizardsHeroAssets(),
  ]);

  if (!list?.data?.length) {
    return null;
  }

  const latest =
    list.data.find(
      (s) =>
        !s.digital_only &&
        s.set_type === "expansion" &&
        isReleasedOnOrBeforeToday(s),
    ) ??
    list.data.find(
      (s) =>
        !s.digital_only &&
        isReleasedOnOrBeforeToday(s) &&
        (s.set_type === "masters" ||
          s.set_type === "draft_innovation" ||
          s.set_type === "commander"),
    );
  if (!latest?.code || !latest.name) {
    return null;
  }

  const search = await fetchJson<ScryfallList<ScryfallCardLite>>(
    `https://api.scryfall.com/cards/search?q=${encodeURIComponent(
      `set:${latest.code}`,
    )}&unique=cards&order=released&dir=desc`,
  );
  const sample = search?.data?.[0];
  const scryfallImage = sample ? pickCardImage(sample) : null;
  const usesWizardsBackground = Boolean(wizards.bannerUrl);

  return {
    code: latest.code,
    name: latest.name,
    releasedAt: latest.released_at ?? "",
    imageUrl: wizards.bannerUrl ?? scryfallImage,
    logoUrl: wizards.logoUrl,
    usesWizardsBackground,
  };
}

export async function getFeaturedExpansion(): Promise<FeaturedExpansionPayload | null> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) {
    return cache.payload;
  }
  if (inflight) {
    return inflight;
  }

  inflight = loadFeaturedExpansion()
    .then((payload) => {
      cache = { at: Date.now(), payload };
      return payload;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}
