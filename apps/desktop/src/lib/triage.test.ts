import { describe, expect, it } from "vitest";

import type { IssueEvidence } from "./glitchtip";
import { classify, isPreproductionEnvironment, needsAttention, readSignals, type Signals } from "./triage";

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

function evidence(patch: Partial<IssueEvidence> = {}): IssueEvidence {
  return {
    environments: [{ name: "production", count: 5 }],
    browsers: [],
    users: 0,
    handled: null,
    userAgent: "",
    url: "",
    frames: [],
    ...patch,
  };
}

function signals(patch: Partial<Signals> = {}): Signals {
  return {
    environments: { production: 5 },
    users: 0,
    handled: null,
    ownCode: null,
    extension: false,
    scanner: false,
    bot: false,
    ...patch,
  };
}

function issue(errorType: string, errorValue = "", patch: { level?: string; userCount?: number; title?: string } = {}) {
  return {
    title: patch.title ?? (errorType ? `${errorType}: ${errorValue}` : errorValue),
    level: patch.level ?? "error",
    userCount: patch.userCount ?? 0,
    errorType,
    errorValue,
  };
}

describe("isPreproductionEnvironment", () => {
  it.each(["development", "dev", "staging", "stage", "local", "test", "preview", "preview-pr-12", "staging_eu", "qa", "ci", "e2e", "sandbox", "Development"])(
    "%s is not production",
    (name) => expect(isPreproductionEnvironment(name)).toBe(true),
  );
  it.each(["production", "prod", "live", "main", "prod-eu", "eu-west-1", "devices", "testimonials", "stagecoach", "canary"])(
    "%s counts as production",
    (name) => expect(isPreproductionEnvironment(name)).toBe(false),
  );
});

describe("readSignals", () => {
  it("counts events per environment, the unnamed ones too, and keeps the people count", () => {
    const read = readSignals(evidence({ environments: [{ name: "production", count: 9 }, { name: "staging", count: 2 }, { name: "", count: 3 }, { name: "gone", count: 0 }], users: 7 }));
    expect(read.environments).toEqual({ production: 9, staging: 2, "": 3 });
    expect(read.users).toBe(7);
  });

  it("says whose code the innermost frame is, and nothing without a stack", () => {
    expect(readSignals(evidence()).ownCode).toBeNull();
    expect(readSignals(evidence({ frames: [{ file: "/app/dist/orders.js", inApp: true }, { file: "/app/node_modules/x.js", inApp: false }] })).ownCode).toBe(true);
    expect(readSignals(evidence({ frames: [{ file: "node:net", inApp: false }, { file: "/app/dist/db.js", inApp: true }] })).ownCode).toBe(false);
  });

  it("blames a browser extension only for an error thrown in its own code", () => {
    const page = { file: "https://shop.example.com/app.js", inApp: true };
    const extension = { file: "chrome-extension://abc/content.js", inApp: false };
    expect(readSignals(evidence({ frames: [extension, page] })).extension).toBe(true);
    expect(readSignals(evidence({ frames: [{ file: "moz-extension://abc/x.js", inApp: false }] })).extension).toBe(true);
    // The page crashed inside a call an extension merely wraps: the crash is the page's.
    expect(readSignals(evidence({ frames: [page, extension] })).extension).toBe(false);
    expect(readSignals(evidence({ frames: [page] })).extension).toBe(false);
  });

  it.each([
    "https://api.example.com/wp-login.php",
    "https://api.example.com/.env",
    "https://api.example.com/.env.production",
    "https://api.example.com/.git/config",
    "https://api.example.com/phpmyadmin/index.php",
    "https://api.example.com/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php",
    "https://api.example.com/cgi-bin/luci",
    "https://api.example.com/static/../../etc/passwd",
    "https://api.example.com/index.php?s=/Index/think",
    "https://api.example.com/actuator/health",
    "/wp-admin/setup-config.php?step=1",
  ])("reads %s as a scanner's request on a Node API", (url) => expect(readSignals(evidence({ url }), "node-express").scanner).toBe(true));

  it.each([
    "https://api.example.com/v1/orders",
    "https://api.example.com/v1/files?dir=../shared",
    "https://api.example.com/login?next=/wp-admin/",
    "https://api.example.com/environment",
    "https://api.example.com/blog/wp-migration-guide",
    "https://api.example.com/.well-known/security.txt",
    "",
  ])("leaves %s alone", (url) => expect(readSignals(evidence({ url }), "node-express").scanner).toBe(false));

  it("takes another stack's pages for probes only where the project is known not to be that stack", () => {
    const scanner = (url: string, platform: string) => readSignals(evidence({ url }), platform).scanner;
    // The product's own pages.
    expect(scanner("https://site.example.com/wp-admin/admin-ajax.php", "php")).toBe(false);
    expect(scanner("https://site.example.com/index.php", "php-laravel")).toBe(false);
    expect(scanner("https://site.example.com/telescope/requests", "php-laravel")).toBe(false);
    expect(scanner("https://site.example.com/Account/Default.aspx", "csharp-aspnetcore")).toBe(false);
    expect(scanner("https://site.example.com/actuator/health", "java-spring-boot")).toBe(false);
    expect(scanner("https://site.example.com/cart.jsp", "java")).toBe(false);
    // The same pages asked of another stack.
    expect(scanner("https://site.example.com/Account/Default.aspx", "python-django")).toBe(true);
    expect(scanner("https://site.example.com/cart.jsp", "node")).toBe(true);
    // A project that does not say what it is: only the unmistakable probes count.
    expect(scanner("https://site.example.com/index.php", "")).toBe(false);
    expect(scanner("https://site.example.com/.env", "")).toBe(true);
    // Secrets are a probe on every server stack.
    expect(scanner("https://site.example.com/.git/HEAD", "php-laravel")).toBe(true);
  });

  it("never takes a browser's page for a scanner's request", () => {
    for (const url of ["https://shop.example.com/product.php?id=3", "https://shop.example.com/wp-admin/post.php", "https://shop.example.com/.env"]) {
      expect(readSignals(evidence({ url }), "javascript-react").scanner).toBe(false);
    }
  });

  it("reads crawlers and scanners as bots, HTTP libraries and phones as people's clients", () => {
    const bot = (userAgent: string) => readSignals(evidence({ userAgent })).bot;
    expect(bot("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toBe(true);
    expect(bot("Mozilla/5.0 zgrab/0.x")).toBe(true);
    expect(bot("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)")).toBe(true);
    expect(bot("facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)")).toBe(true);
    expect(bot(CHROME)).toBe(false);
    expect(bot("okhttp/4.12.0")).toBe(false);
    expect(bot("python-requests/2.32.3")).toBe(false);
    expect(bot("Mozilla/5.0 (Linux; Android 13; CUBOT NOTE 21) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36")).toBe(false);
    expect(bot("")).toBe(false);
  });

  it("keeps an issue people also hit, even when its latest event came from a crawler", () => {
    const userAgent = "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)";
    const mostlyPeople = [{ name: "Chrome", count: 180 }, { name: "bingbot", count: 20 }];
    const mostlyCrawlers = [{ name: "Googlebot", count: 40 }, { name: "Other", count: 8 }, { name: "Chrome", count: 3 }];
    expect(readSignals(evidence({ userAgent, browsers: mostlyPeople })).bot).toBe(false);
    expect(readSignals(evidence({ userAgent, browsers: mostlyCrawlers })).bot).toBe(true);
  });
});

describe("classify", () => {
  it("reads a crash in the application's own code as a bug worth a notification", () => {
    const triage = classify(issue("TypeError", "Cannot read properties of undefined (reading 'id')"), signals({ handled: false, ownCode: true, users: 9 }));
    expect(triage).toEqual({ kind: "bug", priority: "important", reasons: ["crash", "own-code"] });
    expect(needsAttention(triage)).toBe(true);
  });

  it("makes a crash that reaches many people critical", () => {
    const triage = classify(issue("TypeError", "undefined is not an object (evaluating 'cart.items.map')"), signals({ handled: false, ownCode: true, users: 17 }));
    expect(triage).toEqual({ kind: "bug", priority: "critical", reasons: ["crash", "many-users", "own-code"] });
  });

  it("keeps a caught error important however many people saw it, until it spreads", () => {
    const caught = signals({ handled: true, users: 40 });
    expect(classify(issue("Error", "Minified React error #418"), caught).priority).toBe("important");
    expect(classify(issue("Error", "Minified React error #418"), caught, { rate: 45 })).toEqual({
      kind: "bug",
      priority: "critical",
      reasons: ["spreading", "many-users"],
    });
  });

  it("counts people from GlitchTip's own number when it has one", () => {
    expect(classify(issue("KeyError", "'invoice_id'", { userCount: 12 }), signals({ handled: false })).priority).toBe("critical");
  });

  it.each([
    ["Error", "connect ECONNREFUSED 10.0.0.5:5432"],
    ["OperationalError", 'connection to server at "db" (10.0.0.5), port 5432 failed: Connection refused'],
    ["PrismaClientInitializationError", "Can't reach database server at `db:5432`"],
    ["Error", "getaddrinfo ENOTFOUND redis"],
    ["MongoServerSelectionError", "Server selection timed out after 30000 ms"],
    ["PrismaClientKnownRequestError", "Timed out fetching a new connection from the connection pool."],
    ["OperationalError", "FATAL: the database system is starting up"],
  ])("reads %s: %s as an outage", (type, value) => {
    expect(classify(issue(type, value), signals())).toEqual({ kind: "outage", priority: "critical", reasons: ["dependency-down"] });
  });

  it.each([
    ["MemoryError", ""],
    ["Error", "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory"],
    ["OSError", "[Errno 28] No space left on device"],
    ["Error", "EMFILE: too many open files, open '/app/tmp/x'"],
    ["OperationalError", "FATAL: sorry, too many clients already"],
  ])("reads %s: %s as running out of resources", (type, value) => {
    expect(classify(issue(type, value), signals())).toEqual({ kind: "outage", priority: "critical", reasons: ["out-of-resources"] });
  });

  it("reads a fatal event as an outage whatever it says", () => {
    expect(classify(issue("Error", "worker exited", { level: "fatal" }), signals())).toEqual({ kind: "outage", priority: "critical", reasons: ["fatal"] });
  });

  it("reads what the code reported below error as expected, unless it crashed or names an outage", () => {
    const warning = issue("", "Retrying charge_invoice: attempt 2 of 5", { level: "warning" });
    expect(classify(warning, signals())).toEqual({ kind: "expected", priority: "quiet", reasons: ["low-level"] });
    expect(classify(issue("ValueError", "bad coupon", { level: "warning" }), signals({ handled: true })).kind).toBe("expected");
    // PHP reports E_WARNING at this level: an uncaught one is a bug all the same.
    expect(classify(issue("ErrorException", 'Undefined array key "id"', { level: "warning" }), signals({ handled: false })).kind).toBe("bug");
    // A logged "connection refused" is still a dependency that is down.
    expect(classify(issue("", "", { level: "warning", title: "Cache unavailable: connect ECONNREFUSED 127.0.0.1:6379" }), signals())).toEqual({
      kind: "outage",
      priority: "critical",
      reasons: ["dependency-down"],
    });
  });

  it.each([
    ["UnauthorizedException", "Invalid credentials"],
    ["BadRequestException", "Validation failed"],
    ["NotFoundException", "Cannot GET /favicon.ico"],
    ["ForbiddenException", "Forbidden resource"],
    ["ThrottlerException", "Too Many Requests"],
    ["Http404", "No Order matches the given query."],
    ["PermissionDenied", ""],
    ["ValidationError", "phone: Enter a valid phone number."],
    ["ZodError", "[{ code: 'invalid_type' }]"],
    ["TokenExpiredError", "jwt expired"],
    ["HTTPException", "404: Not Found"],
  ])("reads %s as the application refusing on purpose", (type, value) => {
    expect(classify(issue(type, value), signals({ handled: true }))).toEqual({ kind: "expected", priority: "quiet", reasons: ["rejected-request"] });
  });

  it("does not excuse a refusal nothing caught: it took the request down", () => {
    const uncaught = signals({ handled: false });
    // Pydantic failing on the server's own data, Zod on an upstream answer, a service account that lost access.
    expect(classify(issue("ValidationError", "1 validation error for Invoice"), uncaught).kind).toBe("bug");
    expect(classify(issue("ZodError", "[{ code: 'invalid_type' }]"), uncaught).kind).toBe("bug");
    expect(classify(issue("Forbidden", "403 POST https://storage.googleapis.com/upload: caller lacks permission"), uncaught).kind).toBe("bug");
  });

  it("does not excuse a 5xx or a look-alike name", () => {
    expect(classify(issue("HTTPException", "500: payment provider failed for order 402"), signals({ handled: true })).kind).toBe("bug");
    expect(classify(issue("HttpError", "<HttpError 401 when requesting https://www.googleapis.com/drive/v3/files>"), signals({ handled: true })).kind).toBe("bug");
    expect(classify(issue("HTTPException", "500: Internal Server Error"), signals()).kind).toBe("bug");
    expect(classify(issue("NotFoundInCacheError", "key"), signals()).kind).toBe("bug");
    expect(classify(issue("PrismaClientKnownRequestError", "Unique constraint failed on the fields: (`email`)"), signals()).kind).toBe("bug");
  });

  it.each([
    ["AbortError", "The user aborted a request."],
    ["CancelledError", ""],
    ["BrokenPipeError", "[Errno 32] Broken pipe"],
    ["Error", "write EPIPE"],
    ["ClientDisconnect", ""],
  ])("reads %s as a request someone cancelled", (type, value) => {
    expect(classify(issue(type, value), signals({ handled: false, users: 30 }))).toEqual({ kind: "expected", priority: "quiet", reasons: ["cancelled"] });
  });

  it.each([
    ["TypeError", "Failed to fetch"],
    ["TypeError", "Load failed"],
    ["TypeError", "NetworkError when attempting to fetch resource."],
    ["AxiosError", "Network Error"],
    ["AxiosError", "timeout of 10000ms exceeded"],
    ["Error", "socket hang up"],
    ["Error", "read ECONNRESET"],
    ["ReadTimeout", "HTTPSConnectionPool(host='pay.example.org', port=443): Read timed out. (read timeout=10)"],
    ["HTTPError", "502 Server Error: Bad Gateway for url: https://pay.example.org/capture"],
  ])("reads %s: %s as a network hiccup", (type, value) => {
    expect(classify(issue(type, value), signals({ handled: false, users: 12 }))).toEqual({ kind: "flaky", priority: "quiet", reasons: ["network"] });
  });

  it.each([
    ["ChunkLoadError", "Loading chunk 4821 failed."],
    ["TypeError", "Failed to fetch dynamically imported module: https://shop.example.com/assets/Cart-1f.js"],
    ["SyntaxError", "Unexpected token '<'"],
  ])("reads %s as a browser holding a build that is gone", (type, value) => {
    expect(classify(issue(type, value), signals())).toEqual({ kind: "flaky", priority: "quiet", reasons: ["stale-build"] });
  });

  it.each([
    ["Error", "Failed to fetch orders: HTTP 500"],
    ["Error", "Upload failed: S3 AccessDenied"],
    ["Error", "Download failed"],
    ["SyntaxError", "Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON"],
    ["Error", "Service Unavailable"],
  ])("does not take the application's own %s: %s for a network hiccup", (type, value) => {
    expect(classify(issue(type, value), signals({ handled: false, users: 50 }))).toMatchObject({ kind: "bug", priority: "critical" });
  });

  it("reads a database that cannot be reached in time as an outage, not a hiccup", () => {
    expect(classify(issue("Error", "connect ETIMEDOUT 10.0.0.5:5432"), signals()).kind).toBe("outage");
    expect(classify(issue("Error", "read ETIMEDOUT"), signals()).kind).toBe("flaky");
  });

  it("raises a hiccup once it spreads", () => {
    expect(classify(issue("Error", "socket hang up"), signals(), { rate: 29 }).priority).toBe("quiet");
    expect(classify(issue("Error", "socket hang up"), signals(), { rate: 30 })).toEqual({
      kind: "flaky",
      priority: "important",
      reasons: ["spreading", "network"],
    });
  });

  it.each([
    ["Error", "ResizeObserver loop completed with undelivered notifications."],
    ["Error", "ResizeObserver loop limit exceeded"],
    ["Error", "Script error."],
    ["UnhandledRejection", "Non-Error promise rejection captured with value: Object Not Found Matching Id:3, MethodName:update, ParamCount:4"],
    ["ReferenceError", "Can't find variable: __gCrWeb"],
  ])("reads %s: %s as browser noise", (type, value) => {
    expect(classify(issue(type, value), signals({ handled: false, users: 44 }), { rate: 80 })).toEqual({ kind: "noise", priority: "quiet", reasons: ["browser-quirk"] });
  });

  it("reads extensions, scanners and crawlers as noise, however the code failed", () => {
    const crash = issue("TypeError", "Cannot read properties of null (reading 'split')");
    expect(classify(crash, signals({ handled: false, extension: true }))).toEqual({ kind: "noise", priority: "quiet", reasons: ["extension"] });
    expect(classify(crash, signals({ handled: false, scanner: true }), { rate: 90 })).toEqual({ kind: "noise", priority: "quiet", reasons: ["scanner"] });
    expect(classify(crash, signals({ handled: false, bot: true }))).toEqual({ kind: "noise", priority: "quiet", reasons: ["bot"] });
  });

  it("lets many people on an error overrule one event's word that it was not a person", () => {
    const crash = issue("TypeError", "Cannot read properties of null (reading 'split')");
    for (const verdict of [{ scanner: true }, { bot: true }, { extension: true }]) {
      expect(classify(crash, signals({ handled: false, users: 9, ...verdict })).kind).toBe("noise");
      expect(classify(crash, signals({ handled: false, users: 40, ...verdict }))).toMatchObject({ kind: "bug", priority: "critical" });
    }
  });

  it("still calls a database that refuses a scanner's request an outage", () => {
    expect(classify(issue("Error", "connect ECONNREFUSED 10.0.0.5:5432"), signals({ scanner: true, bot: true })).kind).toBe("outage");
  });

  it("keeps everything outside production quiet, outages included", () => {
    const staging = signals({ environments: { staging: 3, "preview-pr-12": 1 }, handled: false, users: 50 });
    expect(classify(issue("Error", "connect ECONNREFUSED 10.0.0.5:5432"), staging, { rate: 99 })).toEqual({
      kind: "preproduction",
      priority: "quiet",
      reasons: ["environment"],
    });
    expect(classify(issue("ReferenceError", "couponCode is not defined", { level: "fatal" }), signals({ environments: { development: 5 } })).kind).toBe("preproduction");
  });

  it("does not let a few staging events speak for events that name no environment", () => {
    const partly = signals({ environments: { staging: 40, "": 2 }, handled: false });
    expect(classify(issue("TypeError", "x is not a function"), partly).kind).toBe("bug");
  });

  it("lets production decide when an error is in both", () => {
    const both = signals({ environments: { staging: 40, production: 1 }, handled: false });
    expect(classify(issue("TypeError", "x is not a function"), both).kind).toBe("bug");
  });

  it("treats an error with no environment, or no evidence yet, as production", () => {
    expect(classify(issue("TypeError", "x is not a function"), signals({ environments: {} })).kind).toBe("bug");
    expect(classify(issue("TypeError", "x is not a function"), null)).toEqual({ kind: "bug", priority: "important", reasons: [] });
    expect(classify(issue("Error", "ResizeObserver loop limit exceeded"), null).kind).toBe("noise");
    expect(classify(issue("Error", "connect ECONNREFUSED 10.0.0.5:5432"), null).priority).toBe("critical");
  });

  it("reads a message without an exception from its title", () => {
    expect(classify(issue("", "", { title: "Payment webhook signature mismatch" }), signals())).toEqual({ kind: "bug", priority: "important", reasons: [] });
    expect(classify(issue("", "", { title: "upstream connect error or disconnect/reset before headers" }), signals()).kind).toBe("outage");
  });
});
