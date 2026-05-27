import { getKvTextLinesCached } from "./kv.js";
import { jsonErrorResponse } from "./response.js";

const ALLOWED_REFERER_KEY = "ALLOWED_REFERER";

const REFERER_ERRORS = {
    FORBIDDEN_REFERER: { status: 403, message: "Forbidden: Referer is not allowed" },
    ALLOWED_REFERER_CONFIG_ERROR: {
        status: 500,
        message: "Internal Server Error: ALLOWED_REFERER is invalid in KV",
    },
};

// 解析 Referer 并提取 origin。
const parseRefererOrigin = (referer) => {
    try {
        return new URL(referer).origin.toLowerCase();
    } catch {
        return null;
    }
};

// 构造 Referer 禁止访问响应。
const buildForbiddenResponse = (details) =>
    jsonErrorResponse(REFERER_ERRORS.FORBIDDEN_REFERER, details);

// 构造 Referer 配置错误响应。
const buildConfigErrorResponse = () =>
    jsonErrorResponse(REFERER_ERRORS.ALLOWED_REFERER_CONFIG_ERROR);

// 读取指定 namespace 下的允许 Referer 列表。
const loadAllowedReferer = (env, namespace) =>
    getKvTextLinesCached({
        env,
        namespace,
        key: ALLOWED_REFERER_KEY,
        cacheKey: `${namespace}::allowed-referer`,
    });

// 匹配 Referer 规则：支持精确 origin 与 https://*.example.com 通配。
const matchRefererPattern = (refererOrigin, pattern) => {
    const normalizedPattern = typeof pattern === "string" ? pattern.toLowerCase() : "";
    if (!normalizedPattern) {
        return false;
    }

    const wildcardMatch = normalizedPattern.match(/^(https?):\/\/\*\.([^/*\s]+)$/i);
    if (wildcardMatch) {
        const [, protocol, baseHost] = wildcardMatch;
        let refererUrl;
        try {
            refererUrl = new URL(refererOrigin);
        } catch {
            return false;
        }
        if (refererUrl.protocol !== `${protocol.toLowerCase()}:`) {
            return false;
        }
        const refererHost = refererUrl.hostname.toLowerCase();
        const normalizedBaseHost = baseHost.toLowerCase();
        return refererHost !== normalizedBaseHost && refererHost.endsWith(`.${normalizedBaseHost}`);
    }

    let expectedOrigin;
    try {
        expectedOrigin = new URL(normalizedPattern).origin.toLowerCase();
    } catch {
        return false;
    }

    return refererOrigin === expectedOrigin;
};

// 通用 Referer 校验流程：请求头校验 -> 配置读取校验 -> 白名单匹配。
export const validateRefererAccess = async ({ env, namespace, referer = "", allowEmptyReferer = false }) => {
    if (!referer) {
        if (allowEmptyReferer) {
            return { allowed: true, response: null };
        }
        return {
            allowed: false,
            response: buildForbiddenResponse({ hint: "Referer header is required" }),
        };
    }

    const refererOrigin = parseRefererOrigin(referer);
    if (!refererOrigin) {
        return {
            allowed: false,
            response: buildForbiddenResponse({ hint: "Referer header is not a valid URL" }),
        };
    }

    const allowedReferer = await loadAllowedReferer(env, namespace);
    if (!allowedReferer) {
        return {
            allowed: false,
            response: buildConfigErrorResponse(),
        };
    }

    const isAllowed = allowedReferer.some((pattern) => matchRefererPattern(refererOrigin, pattern));
    if (!isAllowed) {
        return {
            allowed: false,
            response: buildForbiddenResponse({ hint: "Referer is not in allow list" }),
        };
    }

    return { allowed: true, response: null };
};
