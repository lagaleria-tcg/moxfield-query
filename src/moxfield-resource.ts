export const MOXFIELD_KINDS = ["deck", "collection", "binder", "list"] as const;
export type MoxfieldKind = (typeof MOXFIELD_KINDS)[number];

export type MoxfieldTarget = {
  kind: MoxfieldKind;
  publicId: string;
};

const KIND_ALIASES: Record<string, MoxfieldKind> = {
  deck: "deck",
  decks: "deck",
  collection: "collection",
  collections: "collection",
  binder: "binder",
  binders: "binder",
  "trade-binder": "binder",
  "trade-binders": "binder",
  list: "list",
  lists: "list",
  bookmark: "list",
  bookmarks: "list",
  "curated-decks": "list",
};

const PUBLIC_ID_RE = /^[a-zA-Z0-9_-]+$/;
const PATH_RE = /^\/?(?:www\.)?moxfield\.com(\/.*)$/i;

export const PAGE_PATH: Record<MoxfieldKind, string> = {
  deck: "decks",
  collection: "collection",
  binder: "binders",
  list: "lists",
};

export function isMoxfieldKind(value: string): value is MoxfieldKind {
  return (MOXFIELD_KINDS as readonly string[]).includes(value);
}

export function resolveKindAlias(segment: string): MoxfieldKind | "" {
  return KIND_ALIASES[segment.toLowerCase()] ?? "";
}

export function isPublicId(value: string): boolean {
  return PUBLIC_ID_RE.test(value);
}

export function moxfieldPageUrl(target: MoxfieldTarget): string {
  return `https://www.moxfield.com/${PAGE_PATH[target.kind]}/${encodeURIComponent(target.publicId)}`;
}

/**
 * Accepts a bare publicId, a Moxfield path (`/collection/{id}`), or a full URL.
 * Bare ids default to `fallbackKind` (decks, matching the original API).
 */
export function parseMoxfieldTarget(
  raw: string,
  fallbackKind: MoxfieldKind = "deck",
): MoxfieldTarget | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  if (isPublicId(trimmed)) {
    return { kind: fallbackKind, publicId: trimmed };
  }

  const path = extractMoxfieldPath(trimmed);
  if (!path) {
    return null;
  }

  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) {
    return null;
  }

  const kind = resolveKindAlias(parts[0] ?? "");
  const publicId = safeDecode(parts[1] ?? "");
  if (!kind || !isPublicId(publicId)) {
    return null;
  }
  return { kind, publicId };
}

function extractMoxfieldPath(raw: string): string {
  const asUrl = tryParseUrl(raw);
  if (asUrl) {
    if (!/(^|\.)moxfield\.com$/i.test(asUrl.hostname)) {
      return "";
    }
    return asUrl.pathname;
  }

  const hosted = raw.replace(PATH_RE, "$1");
  if (hosted !== raw) {
    return hosted.startsWith("/") ? hosted : `/${hosted}`;
  }

  if (raw.startsWith("/")) {
    return raw;
  }
  return "";
}

function tryParseUrl(raw: string): URL | null {
  try {
    if (/^https?:\/\//i.test(raw)) {
      return new URL(raw);
    }
  } catch {
    return null;
  }
  return null;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return value.trim();
  }
}

export function interceptPattern(kind: MoxfieldKind): RegExp {
  switch (kind) {
    case "deck":
      return /api2\.moxfield\.com\/v\d+\/decks\/all\//;
    case "collection":
      return /api2\.moxfield\.com\/v\d+\/collections(?:\/search)?\//;
    case "binder":
      return /api2\.moxfield\.com\/v\d+\/trade-binders\//;
    case "list":
      return /api2\.moxfield\.com\/v\d+\/(?:curated-decks|lists|bookmarks)\//;
  }
}

export function apiCandidateUrls(target: MoxfieldTarget): string[] {
  const id = encodeURIComponent(target.publicId);
  switch (target.kind) {
    case "deck":
      return [
        `https://api2.moxfield.com/v3/decks/all/${id}`,
        `https://api2.moxfield.com/v2/decks/all/${id}`,
      ];
    case "collection":
      return [
        `https://api2.moxfield.com/v1/collections/search/${id}?${collectionQuery(1)}`,
        `https://api2.moxfield.com/v1/collections/${id}?${collectionQuery(1)}`,
      ];
    case "binder":
      return [
        `https://api2.moxfield.com/v1/trade-binders/${id}/search?${binderQuery(1)}`,
        `https://api2.moxfield.com/v1/trade-binders/${id}?${binderQuery(1)}`,
      ];
    case "list":
      return [
        `https://api2.moxfield.com/v1/curated-decks/${id}?decksPageSize=101`,
        `https://api2.moxfield.com/v1/lists/${id}`,
        `https://api2.moxfield.com/v2/lists/${id}`,
        `https://api2.moxfield.com/v1/bookmarks/${id}`,
      ];
  }
}

export function nextPageUrl(currentUrl: string, pageNumber: number): string {
  const url = new URL(currentUrl);
  url.searchParams.set("pageNumber", String(pageNumber));
  return url.toString();
}

export function pageUrls(templateUrl: string, fromPage: number, toPage: number): string[] {
  const urls: string[] = [];
  for (let n = fromPage; n <= toPage; n += 1) {
    urls.push(nextPageUrl(templateUrl, n));
  }
  return urls;
}

function collectionQuery(pageNumber: number): string {
  const params = new URLSearchParams({
    pageNumber: String(pageNumber),
    pageSize: "100",
    sortType: "cardName",
    sortDirection: "ascending",
  });
  return params.toString();
}

function binderQuery(pageNumber: number): string {
  const params = new URLSearchParams({
    pageNumber: String(pageNumber),
    pageSize: "100",
    sortType: "cardName",
    sortDirection: "ascending",
  });
  return params.toString();
}

export function isPaginatedPayload(value: unknown): value is {
  data: unknown[];
  pageNumber?: number;
  pageSize?: number;
  totalPages: number;
  totalResults?: number;
} {
  if (!value || typeof value !== "object") {
    return false;
  }
  const rec = value as Record<string, unknown>;
  return Array.isArray(rec.data) && typeof rec.totalPages === "number";
}
