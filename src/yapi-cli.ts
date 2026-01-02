#!/usr/bin/env node

import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";
import { runInstallSkill } from "./skill/install";

type Options = {
  config?: string;
  baseUrl?: string;
  token?: string;
  projectId?: string;
  authMode?: string;
  email?: string;
  password?: string;
  cookie?: string;
  tokenParam?: string;
  method?: string;
  path?: string;
  url?: string;
  query?: string[];
  header?: string[];
  data?: string;
  dataFile?: string;
  timeout?: number;
  noPretty?: boolean;
  help?: boolean;
  version?: boolean;
};

function parseKeyValue(raw: string): [string, string] {
  if (!raw || !raw.includes("=")) throw new Error("expected key=value");
  const idx = raw.indexOf("=");
  return [raw.slice(0, idx), raw.slice(idx + 1)];
}

function parseHeader(raw: string): [string, string] {
  if (!raw || !raw.includes(":")) throw new Error("expected Header:Value");
  const idx = raw.indexOf(":");
  return [raw.slice(0, idx).trim(), raw.slice(idx + 1).trim()];
}

function joinUrl(baseUrl: string, endpoint: string): string {
  if (!baseUrl) return endpoint;
  if (baseUrl.endsWith("/") && endpoint.startsWith("/")) return baseUrl.slice(0, -1) + endpoint;
  if (!baseUrl.endsWith("/") && !endpoint.startsWith("/")) return baseUrl + "/" + endpoint;
  return baseUrl + endpoint;
}

function globalConfigPath(): string {
  const yapiHome = process.env.YAPI_HOME || path.join(os.homedir(), ".yapi");
  return path.join(yapiHome, "config.toml");
}

function parseSimpleToml(text: string): Record<string, string> {
  const data: Record<string, string> = {};
  const lines = String(text || "").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.split("#", 1)[0].split(";", 1)[0].trim();
    if (!line || line.startsWith("[")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (!key) continue;
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    data[key] = value;
  }
  return data;
}

function resolveToken(tokenValue: string, projectId: string): string {
  if (!tokenValue) return "";
  if (tokenValue.includes(",") || tokenValue.includes(":")) {
    let defaultToken = "";
    const mapping: Record<string, string> = {};
    tokenValue.split(",").forEach((rawPair) => {
      const pair = rawPair.trim();
      if (!pair) return;
      const idx = pair.indexOf(":");
      if (idx === -1) {
        defaultToken = pair;
        return;
      }
      const pid = pair.slice(0, idx).trim();
      const token = pair.slice(idx + 1).trim();
      if (pid && token) mapping[pid] = token;
    });
    if (projectId && mapping[projectId]) return mapping[projectId];
    if (defaultToken) return defaultToken;
    const keys = Object.keys(mapping);
    if (keys.length) return mapping[keys[0]];
  }
  return tokenValue;
}

function getSetCookie(headers: Headers): string[] {
  const anyHeaders = headers as unknown as { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === "function") {
    return anyHeaders.getSetCookie();
  }
  const value = headers.get("set-cookie");
  return value ? [value] : [];
}

function extractCookieValue(setCookies: string[], name: string): string {
  if (!setCookies || !setCookies.length) return "";
  for (const entry of setCookies) {
    const parts = String(entry || "").split(";");
    for (const part of parts) {
      const item = part.trim();
      if (item.startsWith(name + "=")) return item.split("=").slice(1).join("=");
    }
  }
  return "";
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function loginGetCookie(baseUrl: string, email: string, password: string, timeoutMs: number): Promise<string> {
  const url = joinUrl(baseUrl, "/api/user/login");
  const payload = JSON.stringify({ email, password });
  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json;charset=UTF-8" },
      body: payload,
    },
    timeoutMs,
  );
  const bodyText = await response.text();
  const setCookies = getSetCookie(response.headers);
  const yapiToken = extractCookieValue(setCookies, "_yapi_token");
  const yapiUid = extractCookieValue(setCookies, "_yapi_uid");
  if (!yapiToken) {
    let message = "login failed: missing _yapi_token cookie";
    try {
      const parsed = JSON.parse(bodyText) as { errmsg?: string };
      if (parsed?.errmsg) message = parsed.errmsg;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  let cookie = `_yapi_token=${yapiToken}`;
  if (yapiUid) cookie = `${cookie}; _yapi_uid=${yapiUid}`;
  return cookie;
}

function buildUrl(
  baseUrl: string | null,
  endpoint: string,
  queryItems: [string, string][],
  token: string,
  tokenParam: string,
): string {
  const url = baseUrl ? joinUrl(baseUrl, endpoint) : endpoint;
  const parsed = new URL(url);
  for (const [key, value] of queryItems) {
    if (key) parsed.searchParams.append(key, value ?? "");
  }
  if (token && !parsed.searchParams.has(tokenParam)) {
    parsed.searchParams.append(tokenParam, token);
  }
  return parsed.toString();
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    query: [],
    header: [],
    method: "GET",
    tokenParam: "token",
    timeout: 30000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "-V" || arg === "--version") {
      options.version = true;
      continue;
    }
    if (arg === "--config") { options.config = argv[++i]; continue; }
    if (arg.startsWith("--config=")) { options.config = arg.slice(9); continue; }
    if (arg === "--base-url") { options.baseUrl = argv[++i]; continue; }
    if (arg.startsWith("--base-url=")) { options.baseUrl = arg.slice(11); continue; }
    if (arg === "--token") { options.token = argv[++i]; continue; }
    if (arg.startsWith("--token=")) { options.token = arg.slice(8); continue; }
    if (arg === "--project-id") { options.projectId = argv[++i]; continue; }
    if (arg.startsWith("--project-id=")) { options.projectId = arg.slice(13); continue; }
    if (arg === "--auth-mode") { options.authMode = argv[++i]; continue; }
    if (arg.startsWith("--auth-mode=")) { options.authMode = arg.slice(12); continue; }
    if (arg === "--email") { options.email = argv[++i]; continue; }
    if (arg.startsWith("--email=")) { options.email = arg.slice(8); continue; }
    if (arg === "--password") { options.password = argv[++i]; continue; }
    if (arg.startsWith("--password=")) { options.password = arg.slice(11); continue; }
    if (arg === "--cookie") { options.cookie = argv[++i]; continue; }
    if (arg.startsWith("--cookie=")) { options.cookie = arg.slice(9); continue; }
    if (arg === "--token-param") { options.tokenParam = argv[++i]; continue; }
    if (arg.startsWith("--token-param=")) { options.tokenParam = arg.slice(14); continue; }
    if (arg === "--method") { options.method = argv[++i]; continue; }
    if (arg.startsWith("--method=")) { options.method = arg.slice(9); continue; }
    if (arg === "--path") { options.path = argv[++i]; continue; }
    if (arg.startsWith("--path=")) { options.path = arg.slice(7); continue; }
    if (arg === "--url") { options.url = argv[++i]; continue; }
    if (arg.startsWith("--url=")) { options.url = arg.slice(6); continue; }
    if (arg === "--query") { options.query?.push(argv[++i]); continue; }
    if (arg.startsWith("--query=")) { options.query?.push(arg.slice(8)); continue; }
    if (arg === "--header") { options.header?.push(argv[++i]); continue; }
    if (arg.startsWith("--header=")) { options.header?.push(arg.slice(9)); continue; }
    if (arg === "--data") { options.data = argv[++i]; continue; }
    if (arg.startsWith("--data=")) { options.data = arg.slice(7); continue; }
    if (arg === "--data-file") { options.dataFile = argv[++i]; continue; }
    if (arg.startsWith("--data-file=")) { options.dataFile = arg.slice(12); continue; }
    if (arg === "--timeout") { options.timeout = Number(argv[++i]); continue; }
    if (arg.startsWith("--timeout=")) { options.timeout = Number(arg.slice(10)); continue; }
    if (arg === "--no-pretty") { options.noPretty = true; continue; }
  }
  return options;
}

function usage(): string {
  return [
    "Usage:",
    "  yapi --path /api/interface/get --query id=123",
    "  yapi install-skill [options]",
    "Options:",
    "  --config <path>        config file path (default: ~/.yapi/config.toml)",
    "  --base-url <url>       YApi base URL",
    "  --token <token>        project token (supports projectId:token)",
    "  --project-id <id>      select token for project",
    "  --auth-mode <mode>     token or global",
    "  --email <email>        login email for global mode",
    "  --password <pwd>       login password for global mode",
    "  --path <path>          API path (e.g., /api/interface/get)",
    "  --url <url>            full URL (overrides base-url/path)",
    "  --query key=value      query param (repeatable)",
    "  --header Header:Value  request header (repeatable)",
    "  --method <method>      HTTP method",
    "  --data <payload>       request body (JSON or text)",
    "  --data-file <file>     request body file",
    "  --timeout <ms>         request timeout in ms",
    "  --no-pretty            print raw response",
    "  -V, --version          print version",
    "  -h, --help             show help",
  ].join("\n");
}

function escapeTomlValue(value: string): string {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function formatToml(config: Record<string, string>): string {
  const orderedKeys = ["base_url", "auth_mode", "email", "password", "token", "project_id"];
  const lines = ["# YApi CLI config"];
  for (const key of orderedKeys) {
    const value = config[key] || "";
    lines.push(`${key} = "${escapeTomlValue(value)}"`);
  }
  return `${lines.join("\n")}\n`;
}

function writeConfig(filePath: string, config: Record<string, string>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, formatToml(config), "utf8");
}

function promptText(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function promptHidden(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const originalWrite = (rl as unknown as { _writeToOutput?: (value: string) => void })._writeToOutput;
  (rl as unknown as { stdoutMuted?: boolean }).stdoutMuted = true;
  (rl as unknown as { _writeToOutput?: (value: string) => void })._writeToOutput = function writeToOutput(value: string) {
    if ((rl as unknown as { stdoutMuted?: boolean }).stdoutMuted) return;
    if (typeof originalWrite === "function") {
      originalWrite.call(this, value);
    } else {
      (rl as unknown as { output: NodeJS.WritableStream }).output.write(value);
    }
  };
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      (rl as unknown as { stdoutMuted?: boolean }).stdoutMuted = false;
      rl.close();
      resolve(answer);
    });
  });
}

async function promptRequired(question: string, hidden: boolean): Promise<string> {
  while (true) {
    const answer = hidden ? await promptHidden(question) : await promptText(question);
    const trimmed = String(answer || "").trim();
    if (trimmed) return trimmed;
  }
}

async function initConfigIfMissing(options: Options): Promise<{ configPath: string; config: Record<string, string> } | null> {
  const hasBaseUrl = Boolean(options.baseUrl);
  const hasEmail = Boolean(options.email);
  const hasPassword = Boolean(options.password);
  if (!hasBaseUrl || !hasEmail || !hasPassword) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  }
  const baseUrl = hasBaseUrl ? options.baseUrl : await promptRequired("YApi base URL: ", false);
  const email = hasEmail ? options.email : await promptRequired("YApi email: ", false);
  const password = hasPassword ? options.password : await promptRequired("YApi password: ", true);
  const config: Record<string, string> = {
    base_url: baseUrl || "",
    auth_mode: "global",
    email: email || "",
    password: password || "",
    token: options.token || "",
    project_id: options.projectId || "",
  };
  const configPath = globalConfigPath();
  writeConfig(configPath, config);
  return { configPath, config };
}

function readVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, "../package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

async function main(): Promise<number> {
  const rawArgs = process.argv.slice(2);
  if (rawArgs[0] === "install-skill") {
    await runInstallSkill(rawArgs.slice(1));
    return 0;
  }

  const options = parseArgs(rawArgs);
  if (options.version) {
    console.log(readVersion());
    return 0;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }

  if (options.url && options.path) {
    console.error("use --url or --path, not both");
    return 2;
  }

  if (!options.url && !options.path) {
    console.error("missing --path or --url");
    console.error(usage());
    return 2;
  }

  let config: Record<string, string> = {};
  let configPath = options.config || "";
  if (options.config) {
    if (fs.existsSync(configPath)) {
      config = parseSimpleToml(fs.readFileSync(configPath, "utf8"));
    } else {
      const init = await initConfigIfMissing(options);
      if (init) {
        config = init.config;
        configPath = init.configPath;
      } else {
        console.error(`missing config file: ${configPath}`);
        return 2;
      }
    }
  } else {
    const globalPath = globalConfigPath();
    if (fs.existsSync(globalPath)) {
      configPath = globalPath;
      config = parseSimpleToml(fs.readFileSync(globalPath, "utf8"));
    } else {
      const init = await initConfigIfMissing(options);
      if (init) {
        config = init.config;
        configPath = init.configPath;
      } else {
        console.error("missing config: create ~/.yapi/config.toml or pass --config");
        return 2;
      }
    }
  }

  const baseUrl = options.url ? null : (options.baseUrl || config.base_url || "");
  const endpoint = options.url || options.path || "";
  if (!options.url && !baseUrl) {
    console.error("missing --base-url or config base_url");
    return 2;
  }

  const projectId = options.projectId || config.project_id || "";
  const rawToken = options.token || config.token || "";
  const token = resolveToken(rawToken, projectId);

  let authMode = (options.authMode || config.auth_mode || "").trim().toLowerCase();
  if (!authMode) {
    authMode = token ? "token" : (options.email || options.password || config.email || config.password) ? "global" : "token";
  }
  if (authMode !== "token" && authMode !== "global") {
    console.error("invalid --auth-mode (use token or global)");
    return 2;
  }

  const headers: Record<string, string> = {};
  for (const header of options.header || []) {
    const [key, value] = parseHeader(header);
    headers[key] = value;
  }

  if (options.cookie) {
    headers.Cookie = options.cookie;
  } else if (authMode === "global") {
    const email = options.email || config.email;
    const password = options.password || config.password;
    if (!email || !password) {
      console.error("missing email/password for global auth");
      return 2;
    }
    try {
      headers.Cookie = await loginGetCookie(baseUrl || "", email, password, options.timeout || 30000);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }

  const queryItems: [string, string][] = [];
  for (const query of options.query || []) {
    queryItems.push(parseKeyValue(query));
  }
  const url = buildUrl(baseUrl, endpoint, queryItems, authMode === "token" ? token : "", options.tokenParam || "token");

  let dataRaw: string | null = null;
  if (options.dataFile) {
    dataRaw = fs.readFileSync(options.dataFile, "utf8");
  } else if (options.data !== undefined) {
    dataRaw = options.data;
  }

  let body: string | undefined;
  const method = (options.method || "GET").toUpperCase();
  if (dataRaw !== null && method !== "GET" && method !== "HEAD") {
    try {
      const parsed = JSON.parse(dataRaw);
      body = JSON.stringify(parsed);
      if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
    } catch {
      body = String(dataRaw);
      if (!headers["Content-Type"]) headers["Content-Type"] = "text/plain";
    }
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(
      url,
      {
        method,
        headers,
        body,
      },
      options.timeout || 30000,
    );
  } catch (error) {
    console.error("request failed: " + (error instanceof Error ? error.message : String(error)));
    return 2;
  }

  const text = await response.text();
  if (options.noPretty) {
    console.log(text);
    return 0;
  }
  try {
    const payload = JSON.parse(text);
    console.log(JSON.stringify(payload, null, 2));
  } catch {
    console.log(text);
  }
  return 0;
}

main().then((code) => {
  process.exitCode = code;
});
