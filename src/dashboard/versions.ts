const RELEASES_URL = "https://api.github.com/repos/NoVate911/novate-mcp/releases?per_page=30";
const VERSION_RE = /^[0-9]{2}\.(0?[1-9]|1[0-2])\.[1-9][0-9]*\.[0-9]{3}$/;
const CACHE_TTL_MS = 5 * 60 * 1000;

export type ReleaseInfo = {
  version: string;
  name: string;
  notes: string;
  url: string;
  publishedAt: string;
};

export type VersionsInfo = {
  installed: string;
  latest: ReleaseInfo | null;
  releases: ReleaseInfo[];
  updateAvailable: boolean;
  trackingLatest: boolean;
  checkedAt: string;
};

type GitHubRelease = {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  draft?: unknown;
  prerelease?: unknown;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let cache: { at: number; releases: ReleaseInfo[] } | null = null;

export function isVersionTag(value: string): boolean {
  return VERSION_RE.test(value);
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] => value.split(".").map((part) => Number(part));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export function installedVersion(env: Record<string, string | undefined> = process.env): string {
  const configured = (env.NOVATE_VERSION || "").trim();
  return configured && (configured === "latest" || isVersionTag(configured)) ? configured : "latest";
}

function parseRelease(value: unknown): ReleaseInfo | null {
  if (!value || typeof value !== "object") return null;
  const release = value as GitHubRelease;
  const version = typeof release.tag_name === "string" ? release.tag_name.trim() : "";
  if (!isVersionTag(version) || release.draft === true || release.prerelease === true) return null;
  return {
    version,
    name: typeof release.name === "string" && release.name.trim() ? release.name.trim() : version,
    notes: typeof release.body === "string" && release.body.trim()
      ? release.body.trim().slice(0, 20_000)
      : "Для этого релиза описание не опубликовано.",
    url: typeof release.html_url === "string" ? release.html_url : "",
    publishedAt: typeof release.published_at === "string" ? release.published_at : "",
  };
}

export async function fetchReleases(fetcher: FetchLike = fetch): Promise<ReleaseInfo[]> {
  if (fetcher === fetch && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.releases;
  const response = await fetcher(RELEASES_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "NoVate-MCP-dashboard",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`GitHub Releases: HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload)) throw new Error("GitHub Releases вернул неожиданный ответ");
  const releases = payload
    .map(parseRelease)
    .filter((release): release is ReleaseInfo => release !== null)
    .sort((left, right) => compareVersions(right.version, left.version));
  if (fetcher === fetch) cache = { at: Date.now(), releases };
  return releases;
}

export async function loadVersionsInfo(fetcher: FetchLike = fetch): Promise<VersionsInfo> {
  const installed = installedVersion();
  const releases = await fetchReleases(fetcher);
  const latest = releases[0] || null;
  const trackingLatest = installed === "latest";
  return {
    installed,
    latest,
    releases,
    updateAvailable: Boolean(latest && !trackingLatest && compareVersions(installed, latest.version) < 0),
    trackingLatest,
    checkedAt: new Date().toISOString(),
  };
}

export async function versionCanBeDeployed(version: string, fetcher: FetchLike = fetch): Promise<boolean> {
  if (!isVersionTag(version)) return false;
  const releases = await fetchReleases(fetcher);
  return releases.some((release) => release.version === version);
}
