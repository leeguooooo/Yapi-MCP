import axios, { AxiosError } from "axios";
import { Logger } from "./logger";
import { YApiAuthCache, YApiSessionCookie } from "./authCache";

type JsonObject = Record<string, any>;

function pickCookieValue(setCookie: string[] | undefined, key: string): string | undefined {
  if (!setCookie || setCookie.length === 0) return undefined;
  const prefix = `${key}=`;
  for (const item of setCookie) {
    const trimmed = String(item || "").trim();
    if (!trimmed.startsWith(prefix)) continue;
    const value = trimmed.slice(prefix.length).split(";")[0];
    return value || undefined;
  }
  return undefined;
}

function pickCookieExpiresAt(setCookie: string[] | undefined, key: string): number | undefined {
  if (!setCookie || setCookie.length === 0) return undefined;
  const prefix = `${key}=`;
  for (const item of setCookie) {
    const trimmed = String(item || "").trim();
    if (!trimmed.startsWith(prefix)) continue;
    const parts = trimmed.split(";").map(s => s.trim());
    const expiresPart = parts.find(p => /^expires=/i.test(p));
    if (!expiresPart) return undefined;
    const dateStr = expiresPart.split("=").slice(1).join("=");
    const ts = Date.parse(dateStr);
    return Number.isFinite(ts) ? ts : undefined;
  }
  return undefined;
}

export class YApiAuthService {
  private readonly baseUrl: string;
  private readonly email: string;
  private readonly password: string;
  private readonly logger: Logger;
  private readonly cache: YApiAuthCache;

  constructor(baseUrl: string, email: string, password: string, logLevel: string = "info") {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.email = email;
    this.password = password;
    this.logger = new Logger("YApiAuthService", logLevel);
    this.cache = new YApiAuthCache(this.baseUrl, logLevel);
  }

  loadCachedProjectTokens(): Map<string, string> {
    return this.cache.loadProjectTokens();
  }

  private getCookieHeader(session: YApiSessionCookie): string {
    const parts = [`_yapi_token=${session.yapiToken}`];
    if (session.yapiUid) parts.push(`_yapi_uid=${session.yapiUid}`);
    return parts.join("; ");
  }

  private isSessionValid(session: YApiSessionCookie | null): session is YApiSessionCookie {
    if (!session?.yapiToken) return false;
    if (!session.expiresAt) return true;
    return Date.now() < session.expiresAt - 60_000; // 预留 1 分钟
  }

  async login(force: boolean = false): Promise<YApiSessionCookie> {
    const cached = this.cache.loadSession();
    if (!force && this.isSessionValid(cached)) return cached;

    try {
      this.logger.info("正在登录 YApi 以刷新全局 token...");
      const response = await axios.post(
        `${this.baseUrl}/api/user/login`,
        { email: this.email, password: this.password },
        { headers: { "Content-Type": "application/json;charset=UTF-8" } },
      );

      const setCookie = response.headers["set-cookie"] as string[] | undefined;
      const yapiToken = pickCookieValue(setCookie, "_yapi_token");
      const yapiUid = pickCookieValue(setCookie, "_yapi_uid");
      const expiresAt = pickCookieExpiresAt(setCookie, "_yapi_token");

      if (!yapiToken) {
        const msg = (response.data as any)?.errmsg || "登录失败，未返回 _yapi_token";
        throw new Error(msg);
      }

      const session: YApiSessionCookie = {
        yapiToken,
        yapiUid,
        expiresAt,
        updatedAt: Date.now(),
      };
      this.cache.saveSession(session);
      return session;
    } catch (error) {
      if (error instanceof AxiosError && error.response) {
        throw new Error(error.response.data?.errmsg || "登录失败");
      }
      throw error instanceof Error ? error : new Error("登录失败");
    }
  }

  private async cookieRequest<T>(
    method: "GET" | "POST",
    endpoint: string,
    session: YApiSessionCookie,
    options: { params?: JsonObject; data?: JsonObject } = {},
  ): Promise<T> {
    try {
      const url = `${this.baseUrl}${endpoint}`;
      const cookie = this.getCookieHeader(session);
      const headers: Record<string, string> = { Cookie: cookie, Accept: "application/json, text/plain, */*" };
      const res =
        method === "GET"
          ? await axios.get(url, { params: options.params, headers })
          : await axios.post(url, options.data ?? {}, { params: options.params, headers });
      return res.data as T;
    } catch (error) {
      if (error instanceof AxiosError && error.response) {
        throw new Error(error.response.data?.errmsg || "请求失败");
      }
      throw error instanceof Error ? error : new Error("请求失败");
    }
  }

  private async listGroups(session: YApiSessionCookie): Promise<any[]> {
    // 有些实例同时支持 group/get_mygroup 和 group/list，这里尽量都试一下并去重
    const groups: any[] = [];
    const tryFetch = async (endpoint: string) => {
      try {
        const res = await this.cookieRequest<any>("GET", endpoint, session);
        if (res?.errcode === 0 && Array.isArray(res.data)) groups.push(...res.data);
      } catch {
        // ignore
      }
    };
    await tryFetch("/api/group/get_mygroup");
    await tryFetch("/api/group/list");

    const seen = new Set<string>();
    return groups.filter(g => {
      const id = String(g?._id ?? g?.id ?? "");
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  private async listProjectsInGroup(session: YApiSessionCookie, groupId: string): Promise<any[]> {
    const all: any[] = [];
    const limit = 50;
    let page = 1;
    while (true) {
      const res = await this.cookieRequest<any>("GET", "/api/project/list", session, {
        params: { group_id: groupId, page, limit },
      });
      if (res?.errcode !== 0) break;
      const list = res?.data?.list;
      if (Array.isArray(list)) all.push(...list);
      const total = Number(res?.data?.total ?? NaN);
      if (!Number.isFinite(total)) {
        if (!Array.isArray(list) || list.length < limit) break;
      } else if (all.length >= total) {
        break;
      }
      page += 1;
      if (page > 200) break;
    }
    return all;
  }

  private async getProjectDetail(session: YApiSessionCookie, projectId: string): Promise<any> {
    const res = await this.cookieRequest<any>("GET", "/api/project/get", session, { params: { id: projectId } });
    if (res?.errcode !== 0) throw new Error(res?.errmsg || "获取项目详情失败");
    return res.data;
  }

  async refreshProjectTokens(
    options: { forceLogin?: boolean } = {},
  ): Promise<{ tokens: Map<string, string>; projects: any[]; groups: any[] }> {
    const session = await this.login(Boolean(options.forceLogin));
    const groups = await this.listGroups(session);
    const projects: any[] = [];

    for (const g of groups) {
      const groupId = String(g?._id ?? g?.id ?? "");
      if (!groupId) continue;
      try {
        const list = await this.listProjectsInGroup(session, groupId);
        projects.push(...list);
      } catch (e) {
        this.logger.warn(`获取分组项目列表失败(groupId=${groupId}): ${e}`);
      }
    }

    const tokens = new Map<string, string>();
    for (const p of projects) {
      const projectId = String(p?._id ?? p?.id ?? "");
      if (!projectId) continue;
      try {
        const detail = await this.getProjectDetail(session, projectId);
        const token = String(detail?.token ?? "").trim();
        if (token) tokens.set(projectId, token);
      } catch (e) {
        this.logger.warn(`获取项目 token 失败(projectId=${projectId}): ${e}`);
      }
    }

    this.cache.saveProjectTokens(tokens);
    return { tokens, projects, groups };
  }
}

