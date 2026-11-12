// How real an error is: what it is (`kind`) and whether it deserves the developer now (`priority`).
//
// GlitchTip's level says how loud the code was, not whether anyone is hurt. A scanner probing
// /wp-login.php and a null dereference in checkout are both "error". So each open issue is read
// from its evidence instead: which environments it comes from, whether it was a crash or a
// caught error, who or what triggered it, whose code it is in, and how fast it is arriving.
//
// The rules run in a fixed order and the first one that fits decides the kind:
//
//   not production -> outage -> noise -> expected -> flaky -> bug
//
// A bug is what is left: an error in production that nothing explains away. Without evidence
// (`signals` is null: GlitchTip could not be asked yet) an issue is read from its title alone and
// counts as production, so a missing answer never hides an error.
//
// Every quiet verdict is a claim that nobody needs to look, so each is kept narrow: a pattern
// matches a whole message or a code that does not occur in prose, a refusal or a warning is quiet
// only when the code caught it, and a verdict that rests on one event (scanner, crawler,
// extension) gives way once ten people are on the error.
//
// Pure: no I/O, no clock. Kinds, priorities and reasons are codes; their words live in the i18n
// files (`triage.kind.*`, `triage.reason.*`).

import type { Issue, IssueEvidence } from "./glitchtip";

export type Kind = "outage" | "bug" | "flaky" | "expected" | "noise" | "preproduction";

/** `critical` and `important` notify; `quiet` only shows in the inbox. */
export type Priority = "critical" | "important" | "quiet";

export type Reason =
  // outage
  | "fatal"
  | "dependency-down"
  | "out-of-resources"
  // what makes a production error heavier
  | "crash"
  | "own-code"
  | "many-users"
  | "spreading"
  // expected
  | "low-level"
  | "rejected-request"
  | "cancelled"
  // flaky
  | "network"
  | "stale-build"
  // noise
  | "browser-quirk"
  | "extension"
  | "scanner"
  | "bot"
  // not production
  | "environment";

export type Triage = { kind: Kind; priority: Priority; reasons: Reason[] };

/**
 * What one issue's events say, reduced to yes/no answers and counts. This is what the app keeps
 * between polls; it holds no message, address, user or stack text.
 */
export type Signals = {
  /** Events per environment name. The key `""` counts events that name none, which read as production. */
  environments: Record<string, number>;
  /** Distinct people (`user.id`) across the issue's events. */
  users: number;
  /** False for a crash nothing caught, true for an error the code caught and reported; null when the event does not say. */
  handled: boolean | null;
  /** The innermost frame is the application's own code; null without a stack. */
  ownCode: boolean | null;
  /** The error was thrown in a browser extension's code. From the latest event alone. */
  extension: boolean;
  /** The request was for a path only vulnerability scanners ask for. From the latest event alone. */
  scanner: boolean;
  /** The latest event came from a crawler or scanner, and so did most events that name a browser. */
  bot: boolean;
};

export type Behaviour = {
  /** Events per minute since the previous poll; for an issue new to the app, since it was first seen. */
  rate: number;
};

export const MANY_USERS = 10;
/** Events per minute at which an error counts as spreading. */
export const SPREADING_RATE = 30;

export const PRIORITY_RANK: Record<Priority, 0 | 1 | 2> = { quiet: 0, important: 1, critical: 2 };

export function needsAttention(triage: Triage): boolean {
  return triage.priority !== "quiet";
}

// ------------------------------------------------------------------ evidence -> signals

const PREPRODUCTION_ENV =
  /^(dev|devel|develop|development|local|localhost|test|tests|testing|stage|staging|preview|qa|uat|ci|e2e|sandbox|demo)([-_./ ].*)?$/i;

/** True for names such as `staging`, `development` or `preview-pr-12`; any other name counts as production. */
export function isPreproductionEnvironment(name: string): boolean {
  return PREPRODUCTION_ENV.test(name.trim());
}

const EXTENSION_FRAME = /^(chrome|moz|safari|safari-web|ms-browser)-extension:\/\/|^webkit-masked-url:\/\/|^user-script:/i;

// Probes for secrets and for appliances' admin pages: nobody's own product serves these.
const SECRET_PROBE =
  /\/\.(env|git|aws|ssh|svn|hg|DS_Store|htaccess|htpasswd)(\.[\w.-]+)?(\/|$)|\/etc\/passwd$|\/(phpmyadmin|pma|cgi-bin|boaform|HNAP1)(\/|$)|\.\.\/|%2e%2e(%2f|\/)/i;

// Another stack's pages. Each counts as a probe only on a project whose platform is known and is
// not that stack: `/wp-admin/` is a scanner on a Node API and the product itself on a PHP site.
const FOREIGN_STACK: Array<{ path: RegExp; owners: string[] }> = [
  { path: /\.php\d?$|\/(wp-(login|admin|content|includes|json|config)|xmlrpc|phpunit|_ignition|telescope)(\/|\.|$)/i, owners: ["php"] },
  { path: /\.aspx?$|\/(owa|autodiscover)(\/|$)/i, owners: ["csharp", "dotnet"] },
  { path: /\.jsp$|\/(actuator|solr)(\/|$)/i, owners: ["java"] },
  { path: /\.cgi$/i, owners: ["perl"] },
];

// Crawlers, link previewers and scanners. Not HTTP libraries (python-requests, okhttp, curl):
// real integrations and mobile apps send those.
const BOT_AGENT =
  /bot[/;)-]|bot$|crawler|spider|slurp|zgrab|masscan|nmap|nuclei|sqlmap|nikto|wpscan|dirbuster|gobuster|censys|shodan|expanse|internet-measurement|HeadlessChrome|PhantomJS|facebookexternalhit|bingpreview|Google-InspectionTool|GoogleOther|Mediapartners|APIs-Google|ia_archiver|Scrapy|HTTrack/i;

/** The path alone: a query may quote anything, `?next=/wp-admin` included. */
function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split(/[?#]/)[0];
  }
}

function isScannerRequest(url: string, platform: string): boolean {
  // A browser's event names the page a person is on, and scanners do not run a page's scripts.
  if (url === "" || platform.startsWith("javascript")) return false;
  const path = pathnameOf(url);
  if (SECRET_PROBE.test(path)) return true;
  return (
    platform !== "" &&
    FOREIGN_STACK.some((stack) => stack.path.test(path) && !stack.owners.some((owner) => platform.startsWith(owner)))
  );
}

/** Whether most of the issue's events come from something that is not a person's browser. */
function mostlyBots(evidence: IssueEvidence): boolean {
  if (!BOT_AGENT.test(evidence.userAgent)) return false;
  let people = 0;
  let total = 0;
  for (const { name, count } of evidence.browsers) {
    total += count;
    if (name !== "Other" && name.trim() !== "" && !BOT_AGENT.test(name)) people += count;
  }
  return total === 0 || people * 2 < total;
}

export function readSignals(evidence: IssueEvidence, platform = ""): Signals {
  const environments: Record<string, number> = {};
  for (const { name, count } of evidence.environments) {
    if (count > 0) environments[name.trim()] = (environments[name.trim()] ?? 0) + count;
  }
  const innermost = evidence.frames.find((frame) => frame.file !== "");
  return {
    environments,
    users: evidence.users,
    handled: evidence.handled,
    ownCode: innermost ? innermost.inApp : null,
    // Thrown inside the extension's own code. An extension that only wraps the page's calls shows
    // up further out in a real crash's stack, and that crash is the page's.
    extension: innermost !== undefined && EXTENSION_FRAME.test(innermost.file),
    scanner: isScannerRequest(evidence.url, platform),
    bot: mostlyBots(evidence),
  };
}

// ------------------------------------------------------------------ what the error text says

const OUT_OF_RESOURCES =
  /\b(MemoryError|OutOfMemoryError|ENOMEM|ENOSPC|EMFILE)\b|heap out of memory|Cannot allocate memory|Out of memory|No space left on device|Too many open files|too many (connections|clients)|remaining connection slots/i;

const DEPENDENCY_DOWN =
  /\b(ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH)\b|connect ETIMEDOUT|Connection refused|getaddrinfo|Name or service not known|Temporary failure in name resolution|could not (connect to server|translate host name)|Can't reach database server|the database system is (starting up|shutting down|in recovery mode)|server closed the connection unexpectedly|Connection terminated (unexpectedly|due to connection timeout)|MongoNetworkError|MongoServerSelectionError|Server selection timed out|connection pool (is )?(exhausted|timed out)|QueuePool limit|Timed out fetching a new connection from the connection pool|PoolTimeout|Redis connection (lost|to \S+ failed)|AMQPConnectionError|NoBrokersAvailable|KafkaJSConnectionError|no healthy upstream|upstream connect error/i;

const BROWSER_QUIRK =
  /ResizeObserver loop|^(Error: )?Script error\.?$|Object Not Found Matching Id|Non-Error promise rejection captured with value: (undefined|null|Timeout)\b|__gCrWeb|window\.webkit\.messageHandlers|_AutofillCallbackHandler|instantSearchSDKJSBridgeClearHighlight|ZiteReader|fb_xd_fragment|top\.GLOBALS|Blocked a frame with origin|ibFindAllVideos|zaloJSV2|evaluating 'window\.ethereum/i;

// The application refusing a request on purpose: its own 4xx answers, by exception name.
const REJECTED_REQUEST =
  /^(NotFound|Unauthorized|Forbidden|BadRequest|UnprocessableEntity|Conflict|Gone|PayloadTooLarge|MethodNotAllowed|NotAcceptable|UnsupportedMediaType|TooManyRequests|Throttler|PreconditionFailed)(Exception|Error)?$|^(Http404|PermissionDenied|NotAuthenticated|AuthenticationFailed|(Request)?ValidationError|ValidationException|ZodError|TokenExpiredError|JsonWebTokenError|NotBeforeError|ExpiredSignatureError|InvalidTokenError|InvalidSignatureError|RateLimitExceeded|Throttled|DisallowedHost|SuspiciousOperation|CsrfError)$/;
const HTTP_4XX = /^(HTTPException|HttpException|HttpError|ResponseStatusException|StarletteHTTPException)$/;
// The status leads the message ("404: Not Found"); a 4xx-looking number further in may be an order id.
const STATUS_4XX = /^\s*4\d\d\b/;

const CANCELLED =
  /\b(AbortError|CancelledError|CanceledError|ClientDisconnect|BrokenPipeError|EPIPE|ECONNABORTED)\b|The (user|operation was) aborted|operation was aborted|Request aborted|request was cancell?ed|client disconnected|The play\(\) request was interrupted/i;

const STALE_BUILD =
  /ChunkLoadError|Loading (CSS )?chunk [\w-]+ failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Failed to load module script/i;
// A script tag given the site's HTML page. With anything after it ("… is not valid JSON") it is
// the API answering with an error page, which is a real failure.
const HTML_FOR_SCRIPT = /^Unexpected token '?<'?$/;

// A browser's own words for a request that never arrived, as the whole message: an application's
// "Failed to fetch orders: HTTP 500" or "Upload failed" is not one of them.
const BROWSER_NETWORK =
  /^(Failed to fetch( \([^)]*\))?|Load failed|NetworkError when attempting to fetch resource\.?|Network request failed|Network Error|The Internet connection appears to be offline\.?|The network connection was lost\.?|timeout of \d+ ?ms exceeded)$/i;
// Codes and class names of a connection that broke under way; these do not occur in prose.
const NETWORK_CODE =
  /net::ERR_|\bERR_(NETWORK|INTERNET_DISCONNECTED)\b|socket hang up|\b(ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT|EAI_AGAIN)\b|UND_ERR_|HeadersTimeoutError|BodyTimeoutError|Read timed out|\b(ReadTimeout|ConnectTimeout|ConnectionResetError|RemoteDisconnected|ChunkedEncodingError|IncompleteRead)\b|Connection reset by peer|Bad Gateway|Gateway Time-?out/i;

const LOW_LEVELS = new Set(["warning", "info", "debug", "log"]);

type Readable = Pick<Issue, "title" | "level" | "userCount" | "errorType" | "errorValue">;

function quiet(kind: Kind, reason: Reason): Triage {
  return { kind, priority: "quiet", reasons: [reason] };
}

/** Read one open issue. `signals` is null until GlitchTip has been asked about it. */
export function classify(issue: Readable, signals: Signals | null, behaviour: Behaviour = { rate: 0 }): Triage {
  const text = issue.errorType ? `${issue.errorType}: ${issue.errorValue}` : issue.title;

  const environments = Object.keys(signals?.environments ?? {});
  if (environments.length > 0 && environments.every(isPreproductionEnvironment)) return quiet("preproduction", "environment");

  if (issue.level === "fatal") return { kind: "outage", priority: "critical", reasons: ["fatal"] };
  if (OUT_OF_RESOURCES.test(text)) return { kind: "outage", priority: "critical", reasons: ["out-of-resources"] };
  if (DEPENDENCY_DOWN.test(text)) return { kind: "outage", priority: "critical", reasons: ["dependency-down"] };

  const caught = signals?.handled !== false;
  // The code reported it below error, and nothing crashed: it is telling, not failing.
  if (LOW_LEVELS.has(issue.level) && caught) return quiet("expected", "low-level");

  if (BROWSER_QUIRK.test(text)) return quiet("noise", "browser-quirk");
  // The next three rest on the latest event alone. When many people are on the same error, they
  // outweigh one event's word that it was not a person.
  const users = Math.max(issue.userCount, signals?.users ?? 0);
  if (users < MANY_USERS) {
    if (signals?.extension) return quiet("noise", "extension");
    if (signals?.scanner) return quiet("noise", "scanner");
    if (signals?.bot) return quiet("noise", "bot");
  }

  if (CANCELLED.test(text)) return quiet("expected", "cancelled");
  // A refusal the code caught and reported. The same exception left uncaught took the request down.
  const refusal = REJECTED_REQUEST.test(issue.errorType) || (HTTP_4XX.test(issue.errorType) && STATUS_4XX.test(issue.errorValue));
  if (refusal && caught) return quiet("expected", "rejected-request");

  const spreading = behaviour.rate >= SPREADING_RATE;
  const value = (issue.errorType ? issue.errorValue : issue.title).trim();
  const flaky: Reason | null =
    STALE_BUILD.test(text) || HTML_FOR_SCRIPT.test(value)
      ? "stale-build"
      : BROWSER_NETWORK.test(value) || NETWORK_CODE.test(text)
        ? "network"
        : null;
  // A hiccup is quiet until it stops being one: the provider is down, or the deploy broke loading.
  if (flaky !== null) {
    return spreading
      ? { kind: "flaky", priority: "important", reasons: ["spreading", flaky] }
      : quiet("flaky", flaky);
  }

  const crash = signals?.handled === false;
  const reasons: Reason[] = [];
  if (spreading) reasons.push("spreading");
  if (crash) reasons.push("crash");
  if (users >= MANY_USERS) reasons.push("many-users");
  if (signals?.ownCode) reasons.push("own-code");
  const critical = spreading || (crash && users >= MANY_USERS);
  return { kind: "bug", priority: critical ? "critical" : "important", reasons };
}
