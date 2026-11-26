// Describing captured scripts for snapshot/scripts/index.json. Nothing here
// filters anything out: the labels exist so the model can decide what to open
// first, and every guess is allowed to be wrong.

export interface ScriptPayload {
  url: string | null;
  /** The <script type> attribute; empty for classic scripts and resource-timing finds. */
  type: string;
  async: boolean;
  defer: boolean;
  /** "tag": a <script> element in the DOM. "resource": only seen in resource timing (lazy chunks). */
  source: "tag" | "resource";
  code: string | null;
  error?: string;
}

export type ScriptKind = "script" | "module" | "json" | "other";

export function scriptKind(type: string): ScriptKind {
  const t = type.trim().toLowerCase();
  if (t === "module") return "module";
  if (t === "" || /^(text|application)\/(x-)?(java|ecma)script$/.test(t)) return "script";
  if (t.includes("json") || t === "importmap" || t === "speculationrules") return "json";
  return "other"; // templates, shaders, etc. parked in <script> tags
}

export const kindExtension: Record<ScriptKind, string> = {
  script: ".js",
  module: ".mjs",
  json: ".json",
  other: ".txt",
};

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "ac", "edu"]);

/** Rough registrable domain: good enough to tell cdn.shop.com from klaviyo.com. */
function siteOf(hostname: string): string {
  const labels = hostname.toLowerCase().split(".");
  const tld = labels.at(-1) ?? "";
  const take = labels.length >= 3 && tld.length === 2 && SECOND_LEVEL.has(labels.at(-2)!) ? 3 : 2;
  return labels.slice(-take).join(".");
}

export function isFirstParty(pageUrl: string, scriptUrl: string | null): boolean {
  if (!scriptUrl) return true; // inline
  try {
    return siteOf(new URL(pageUrl).hostname) === siteOf(new URL(scriptUrl).hostname);
  } catch {
    return false;
  }
}

const URL_CATEGORIES: [category: string, pattern: RegExp][] = [
  [
    "analytics",
    /google-analytics|googletagmanager|gtag\/js|doubleclick|googlesyndication|segment\.(com|io)|hotjar|mixpanel|amplitude|sentry|datadoghq|newrelic|nr-data|clarity\.ms|fbevents|connect\.facebook|bat\.bing|plausible|matomo|fullstory|heap(analytics)?|optimizely|tiktok|snap\.licdn|ads-twitter/i,
  ],
  [
    "widget",
    /klaviyo|mailchimp|chimpstatic|list-manage|optinmonster|optmnstr|privy|hubspot|hs-scripts|hsforms|hs-banner|intercom|drift|zendesk|zdassets|onetrust|cookielaw|cookiebot|osano|sumo(me)?\.com|justuno|attentive|omnisend|wisepops|poptin|sleeknote|convertkit|tawk\.to|crisp\.chat|livechat|olark|yotpo|trustpilot|recaptcha|hcaptcha|challenges\.cloudflare/i,
  ],
  [
    "framework",
    /(^|[/._-])(react(-dom)?|preact|vue|angular|svelte|jquery|lodash|underscore|moment|polyfills?|core-js|webpack-runtime|runtime|framework|vendors?|chunk-vendors|commons|bootstrap|backbone|ember|alpine|htmx|three|d3|gsap)([._~-][\w.~-]*)?\.m?js$/i,
  ],
];

const BANNER_FRAMEWORK =
  /jQuery v?\d|@license React|react-dom|Vue\.js v\d|@license Angular|Lodash <|core-js|regenerator-runtime|Bootstrap v\d|webpackBootstrap/;

/** Best-guess label: "analytics", "widget", "framework", "app", "third-party", or "data". */
export function classify(kind: ScriptKind, url: string | null, firstParty: boolean, code: string | null): string {
  if (kind === "json" || kind === "other") return "data";
  if (url) {
    for (const [category, pattern] of URL_CATEGORIES) {
      if (pattern.test(url)) return category;
    }
  }
  if (code && BANNER_FRAMEWORK.test(code.slice(0, 2048))) return "framework";
  return firstParty ? "app" : "third-party";
}

/** The script's declared source map, resolved against its URL; "(inline)" for data: maps. */
export function sourceMapUrl(code: string, scriptUrl: string | null): string | null {
  const match = /\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/.exec(code.slice(-4096));
  if (!match) return null;
  const ref = match[1]!;
  if (ref.startsWith("data:")) return "(inline)";
  try {
    return new URL(ref, scriptUrl ?? undefined).href;
  } catch {
    return ref;
  }
}
