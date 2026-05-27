import { getKvTextCached } from "../commons/kv.js";
import { jsonErrorResponse, jsonSuccessResponse } from "../commons/response.js";
import * as randomImgHandlers from "../functions/random-img/random-img.js";

// ===========================
// 路由配置
// ===========================

const HIDDEN_ROUTES_NAMESPACE = "hidden_routes";
// 隐藏路由入口注册：新增隐藏路由时仅需在此追加 KV key 字符串
const HIDDEN_PATH_KEYS = ["RANDOM_IMG_COUNT_PATH"];

// 允许携带实际 query 参数的普通路由；不在列表中的普通路由默认禁止
const QUERY_ALLOWED_ROUTES = Object.freeze(["/random-img"]);

// 普通路由入口注册：
// - 固定 handler: 直接传函数
// - 业务模块: 传模块导出对象，按 handleXxx 自动匹配
const ROUTES = {
    "/": () => jsonErrorResponse({ status: 404, message: "No API route specified" }),
    "/hello": () => jsonSuccessResponse({ message: "Hello, World!" }),
    "/healthcheck": () => jsonSuccessResponse({ message: "API on EdgeFunction is healthy" }),
    "/random-img": randomImgHandlers,
};

// ===========================
// 路由处理器自动解析逻辑
// ===========================

// 普通路由 handler 缓存，避免重复按命名约定解析模块导出。
const routeHandlerCache = new Map();
// 隐藏路由 handler 映射的初始化 Promise，全局只构建一次。
let hiddenHandlerMapPromise = null;
const queryAllowedRouteSet = new Set(QUERY_ALLOWED_ROUTES);

// 规范化路由路径：保留根路径，其余路径压缩前导斜杠并去掉尾部斜杠
const normalizePathname = (pathname) => {
    const normalizedPath = `/${pathname.replace(/^\/+/, "")}`;
    return normalizedPath.replace(/\/+$/, "") || "/";
};

// 默认禁止实际 query 参数；确实需要 query 的普通路由需加入 QUERY_ALLOWED_ROUTES。
const rejectQuery = (query) => {
    if (query.size > 0) {
        return jsonErrorResponse({
            status: 403,
            message: "Forbidden: Query parameters are not allowed",
        });
    }

    return null;
};

// 将横线或下划线分隔的字符串转换为 PascalCase（如 random-img → RandomImg）。
const toPascalCase = (value) =>
    value
        .split(/[-_]/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join("");

// 由路由路径派生 handler 函数名（如 /random-img → handleRandomImg）。
const toHandlerNameFromRoutePath = (routePath) => {
    const normalizedPath = routePath.replace(/^\/+/, "");
    return `handle${toPascalCase(normalizedPath)}`;
};

// 约定：KV key `XXX_PATH` 对应 handler `handleXxx`。
const toHiddenHandlerName = (kvPathKey) =>
    `handle${toPascalCase(kvPathKey.replace(/_PATH$/, "").toLowerCase())}`;

// 提取 ROUTES 中所有对象类型的模块引用，去重后返回（用于 handler 自动匹配）。
const getRegisteredRouteModules = () =>
    Array.from(new Set(Object.values(ROUTES).filter((value) => value && typeof value === "object")));

// 按 pathname 解析对应的处理函数，结果写入本地缓存以复用。
const resolveRouteHandler = async (pathname) => {
    if (routeHandlerCache.has(pathname)) {
        return routeHandlerCache.get(pathname);
    }

    const routeEntry = ROUTES[pathname];
    if (!routeEntry) {
        return null;
    }

    if (typeof routeEntry === "function") {
        routeHandlerCache.set(pathname, routeEntry);
        return routeEntry;
    }

    if (typeof routeEntry !== "object") {
        return null;
    }

    const handlerName = toHandlerNameFromRoutePath(pathname);
    const handler = routeEntry[handlerName];
    if (typeof handler === "function") {
        routeHandlerCache.set(pathname, handler);
        return handler;
    }

    return null;
};

// 按 KV key 从已注册模块中懒加载对应的 handler（全局只初始化一次）。
const resolveHiddenHandler = async (kvPathKey) => {
    if (!hiddenHandlerMapPromise) {
        hiddenHandlerMapPromise = (async () => {
            const map = new Map();
            const unresolvedPathKeys = [];
            for (const pathKey of HIDDEN_PATH_KEYS) {
                const handlerName = toHiddenHandlerName(pathKey);
                let resolved = false;
                for (const moduleExports of getRegisteredRouteModules()) {
                    const handler = moduleExports[handlerName];
                    if (typeof handler === "function") {
                        map.set(pathKey, handler);
                        resolved = true;
                        break;
                    }
                }

                if (!resolved) {
                    unresolvedPathKeys.push(pathKey);
                }
            }

            if (unresolvedPathKeys.length > 0) {
                console.warn(
                    "Hidden route handler mapping missing for keys:",
                    unresolvedPathKeys.join(", ")
                );
            }

            return map;
        })();
    }

    const hiddenHandlerMap = await hiddenHandlerMapPromise;
    if (hiddenHandlerMap.has(kvPathKey)) {
        return hiddenHandlerMap.get(kvPathKey);
    }

    return null;
};

// 命中隐藏路径时返回对应响应，未命中返回 null。
const resolveHiddenPathRoute = async (request, env, pathname, query) => {
    const hiddenPathEntries = await Promise.all(
        HIDDEN_PATH_KEYS.map(async (pathKey) => ({
            pathKey,
            dynamicPath: await getKvTextCached({
                env,
                namespace: HIDDEN_ROUTES_NAMESPACE,
                key: pathKey,
                cacheKey: `hidden-routes::${pathKey}`,
            }),
        }))
    );

    for (const { pathKey, dynamicPath } of hiddenPathEntries) {
        if (dynamicPath && pathname === normalizePathname(dynamicPath)) {
            const queryResponse = rejectQuery(query);
            if (queryResponse) {
                return queryResponse;
            }

            const handler = await resolveHiddenHandler(pathKey);
            if (handler) {
                return await handler(request, env);
            }

            return jsonErrorResponse({ status: 500, message: "Internal Server Error: Route handler is not configured" });
        }
    }

    return null;
};

// ===========================
// 边缘函数入口
// ===========================

export default {
    // 边缘函数主入口：按 pathname 分发路由并兜底处理未捕获异常。
    async fetch(request, env) {
        try {
            const url = new URL(request.url);
            const pathname = normalizePathname(url.pathname);
            const handler = await resolveRouteHandler(pathname);

            if (handler) {
                if (!queryAllowedRouteSet.has(pathname)) {
                    const queryResponse = rejectQuery(url.searchParams);
                    if (queryResponse) {
                        return queryResponse;
                    }
                }

                return await handler(request, env);
            }

            if (HIDDEN_PATH_KEYS.length > 0) {
                const hiddenPathResponse = await resolveHiddenPathRoute(request, env, pathname, url.searchParams);
                if (hiddenPathResponse) {
                    return hiddenPathResponse;
                }
            }

            return jsonErrorResponse({ status: 404, message: "API Not Found" });
        } catch (error) {
            // 捕获未预期的错误，避免函数崩溃
            console.error("Unhandled error in edge function:", error instanceof Error ? error.message : "unknown");
            return jsonErrorResponse({ status: 500, message: "Internal Server Error" });
        }
    },
};
