import * as CONFIG from "./config.js";
import { getKvJsonObjectCached, getKvUrlCached } from "../../commons/kv.js";
import { jsonErrorResponse, jsonSuccessResponse } from "../../commons/response.js";
import { validateRefererAccess } from "../../commons/referer.js";

// 将数组转为 Set，用于 O(1) 校验
const ALLOWED_QUERY_SET = new Set(CONFIG.ALLOWED_QUERY);
const SINGLE_VALUE_QUERY_SET = new Set(CONFIG.SINGLE_VALUE_QUERY);
const REQUEST_DEVICE_SET = new Set(CONFIG.REQUEST_DEVICES);
const BRIGHTNESS_SET = new Set(CONFIG.BRIGHTNESS_VALUES);
const METHOD_SET = new Set(CONFIG.METHOD_VALUES);
const RETRYABLE_UPSTREAM_STATUS_CODE_SET = new Set(CONFIG.RETRYABLE_UPSTREAM_STATUS_CODES);
// 匹配图片路径模板中可被替换的占位符
const IMAGE_PATH_PLACEHOLDER_PATTERN = /\{(device|brightness|theme|index)\}/g;

// 有效主题缓存：避免短时内多次请求重复从 FOLDER_MAP 提取主题列表
let validThemeCache = {
    themes: null,
    themeSet: null,
    sourceRef: null,
};

// 检查请求的查询参数是否均在允许列表内
const validateAllowedQuery = (query) => {
    for (const key of query.keys()) {
        if (!ALLOWED_QUERY_SET.has(key)) {
            return jsonErrorResponse(CONFIG.ERRORS.INVALID_QUERY, {
                invalidQuery: [key],
                allowedQuery: CONFIG.ALLOWED_QUERY,
            });
        }
    }
    return null;
};

// 检查单值参数是否存在重复
const validateSingleValueQuery = (query) => {
    for (const key of query.keys()) {
        if (SINGLE_VALUE_QUERY_SET.has(key) && query.getAll(key).length > 1) {
            return jsonErrorResponse(CONFIG.ERRORS.DUPLICATE_QUERY, {
                field: key,
                hint: "This parameter only accepts a single value",
            });
        }
    }
    return null;
};

// 读取图片数量索引配置
const getFolderMapFromKV = (env) =>
    getKvJsonObjectCached({
        env,
        namespace: CONFIG.CONFIG_KV_NAMESPACE,
        key: CONFIG.FOLDER_MAP_KEY,
        cacheKey: "random-img::folder-map",
    });

// 读取基础图片 URL 配置
const getBaseImageUrlFromKV = (env) =>
    getKvUrlCached({
        env,
        namespace: CONFIG.CONFIG_KV_NAMESPACE,
        key: CONFIG.BASE_IMAGE_URL_KEY,
        cacheKey: "random-img::base-image-url",
    });

// 从 folderMap 中提取所有有效主题名列表
const buildValidThemes = (folderMap) =>
    Array.from(
        new Set(
            CONFIG.MAP_DEVICES.flatMap((device) =>
                Object.values(folderMap[device] ?? {}).flatMap((brightnessMap) =>
                    Object.keys(brightnessMap ?? {})
                )
            )
        )
    );

// 惰性更新有效主题缓存：仅当 folderMap 引用变化时重新计算
const ensureValidThemeCache = (folderMap) => {
    // 引用未变化，直接返回缓存结果
    if (validThemeCache.themes && validThemeCache.sourceRef === folderMap) {
        return validThemeCache;
    }

    const themes = buildValidThemes(folderMap);
    validThemeCache = {
        themes,
        themeSet: new Set(themes),
        sourceRef: folderMap,
    };

    return validThemeCache;
};

// 按全局开关决定是否执行 Referer 校验，关闭时直接放行
const validateRefererByConfig = async (request, env) => {
    // Referer 校验未启用时直接放行
    if (!CONFIG.REFERER_CHECK_ENABLED) {
        return { allowed: true, response: null };
    }

    return validateRefererAccess({
        env,
        namespace: CONFIG.CONFIG_KV_NAMESPACE,
        referer: request.headers.get("referer") || "",
        allowEmptyReferer: CONFIG.ALLOW_EMPTY_REFERER,
    });
};

// 根据 baseImageUrl 和所选文件夹信息构造随机图片 URL 及图片信息标识
const buildImageResult = (baseImageUrl, selectedFolder) => {
    const imageIndex = Math.floor(Math.random() * selectedFolder.count) + 1;
    const paddedImageIndex = String(imageIndex).padStart(CONFIG.IMAGE_INDEX_DIGITS, "0");
    const imagePathValues = {
        device: selectedFolder.device,
        brightness: selectedFolder.brightness,
        theme: selectedFolder.theme,
        index: paddedImageIndex,
    };
    const imagePath = CONFIG.IMAGE_PATH_PATTERN
        .replace(IMAGE_PATH_PLACEHOLDER_PATTERN, (_, key) => imagePathValues[key])
        .replace(/^\/+/, "");
    const url = `${baseImageUrl}${imagePath}${CONFIG.IMAGE_FILE_EXTENSION}`;
    const imageInfo = `${selectedFolder.device}-${selectedFolder.brightness}-${selectedFolder.theme}-${imageIndex}`;
    return { url, imageInfo };
};

// 带超时控制地请求上游图片，避免上游无响应时一直挂起到平台超时
const fetchWithTimeout = async (url) => {
    if (typeof AbortController === "undefined") {
        return await fetch(url);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.FETCH_TIMEOUT_MS);

    try {
        return await fetch(url, { signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
    }
};

// 按照指定方式（proxy/redirect）响应图片请求
const respondImageByMethod = async (method, imageUrl, imageInfo) => {
    // redirect 模式：直接构造 302 跳转响应
    if (method === "redirect") {
        return new Response(null, {
            status: 302,
            headers: { Location: imageUrl },
        });
    }

    // proxy 模式：请求上游并透传响应，网络异常或临时 HTTP 状态失败时线性退避重试
    const maxAttempts = Math.max(0, Number(CONFIG.FETCH_MAX_ATTEMPTS) || 0);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const fetchStartedAt = Date.now();
            const upstreamResponse = await fetchWithTimeout(imageUrl);
            const fetchDurationMs = Date.now() - fetchStartedAt;

            // 上游返回非 2xx 状态码：临时状态重试，其他状态立即返回错误
            if (!upstreamResponse.ok) {
                if (
                    RETRYABLE_UPSTREAM_STATUS_CODE_SET.has(upstreamResponse.status) &&
                    attempt < maxAttempts
                ) {
                    await new Promise((resolve) => setTimeout(resolve, CONFIG.FETCH_RETRY_DELAY_MS * attempt));
                    continue;
                }

                return jsonErrorResponse(CONFIG.ERRORS.UPSTREAM_BAD_STATUS, {
                    upstreamStatus: upstreamResponse.status,
                    hint: "Upstream responded but did not return a success status",
                });
            }

            const response = new Response(upstreamResponse.body, {
                status: upstreamResponse.status,
                headers: upstreamResponse.headers,
            });
            if (CONFIG.IMAGE_INFO_HEADER_ENABLED) {
                response.headers.set(CONFIG.IMAGE_INFO_HEADER_NAME, `${imageInfo}; ${fetchDurationMs}`);
            }
            return response;
        } catch {
            // 已耗尽重试次数，返回上游请求失败错误
            if (attempt >= maxAttempts) {
                return jsonErrorResponse(CONFIG.ERRORS.UPSTREAM_FETCH_EXCEPTION, {
                    hint: "Upstream request failed before receiving a valid response",
                    retryAttempts: attempt,
                });
            }
            await new Promise((resolve) => setTimeout(resolve, CONFIG.FETCH_RETRY_DELAY_MS * attempt));
        }
    }

    return jsonErrorResponse(CONFIG.ERRORS.UPSTREAM_FETCH_EXCEPTION, {
        hint: "No upstream fetch attempts were made",
        retryAttempts: maxAttempts,
    });
};


// ===========================
// 随机图片主处理逻辑
// ===========================

export const handleRandomImg = async (request, env) => {
    // 仅允许 GET 请求，其余方法返回 405
    if (request.method !== "GET") {
        return jsonErrorResponse({ status: 405, message: "Method Not Allowed" });
    }

    // 按配置决定是否执行 Referer 校验，失败时返回对应错误响应
    const refererCheckResult = await validateRefererByConfig(request, env);
    if (!refererCheckResult.allowed) {
        return refererCheckResult.response;
    }

    // 解析请求 URL 以获取路径与查询参数
    let query;
    try {
        query = new URL(request.url).searchParams;
    } catch {
        return jsonErrorResponse({
            status: 400,
            message: "Bad Request: Request URL is malformed or cannot be parsed",
        }, {
            hint: "Ensure the request URL is valid and properly encoded",
        });
    }

    // 校验查询参数白名单，存在非法参数时直接返回错误
    const invalidQueryResponse = validateAllowedQuery(query);
    if (invalidQueryResponse) {
        return invalidQueryResponse;
    }

    // 校验单值参数不可重复，同一键只能出现一次
    const duplicateQueryResponse = validateSingleValueQuery(query);
    if (duplicateQueryResponse) {
        return duplicateQueryResponse;
    }

    // 解析响应方式
    const method = query.get("m")?.toLowerCase() || CONFIG.DEFAULT_METHOD;

    // 校验 method 参数：仅允许 proxy 或 redirect
    if (!METHOD_SET.has(method)) {
        return jsonErrorResponse(CONFIG.ERRORS.INVALID_METHOD, { field: "m" });
    }

    // 强制开关：若关闭 redirect，则无论参数如何都用 proxy
    const effectiveMethod = CONFIG.REDIRECT_ENABLED ? method : "proxy";

    // 读取亮度参数（若未传则为 null）
    const requestedBrightness = query.get("b")?.toLowerCase() || null;
    // 校验亮度参数合法性（允许 dark / light）
    if (requestedBrightness && !BRIGHTNESS_SET.has(requestedBrightness)) {
        return jsonErrorResponse(CONFIG.ERRORS.INVALID_BRIGHTNESS, { field: "b" });
    }
    // 构建亮度候选列表：指定时仅用该值，否则使用全部亮度
    const brightnessCandidates = requestedBrightness ? [requestedBrightness] : CONFIG.BRIGHTNESS_VALUES;

    // 读取请求指定的设备参数（若未传则为 null）
    const requestedDevice = query.get("d")?.toLowerCase() || null;
    // 校验设备参数合法性（允许 pc / mb / r）
    if (requestedDevice && !REQUEST_DEVICE_SET.has(requestedDevice)) {
        return jsonErrorResponse(CONFIG.ERRORS.INVALID_DEVICE, { field: "d" });
    }

    // 未指定设备时，根据 User-Agent 自动推断；无法识别则回退到随机
    let device = requestedDevice;
    if (!device) {
        const userAgent = request.headers.get("User-Agent") || "";
        const isMobile = /Mobi|Android|iPhone/i.test(userAgent);
        const isDesktop = /Windows|Macintosh|Linux x86_64|X11/i.test(userAgent);
        device = isMobile ? "mb" : (isDesktop ? "pc" : "r");
    }
    // 构建设备候选列表："r" 展开为全部设备，否则仅用指定值
    const deviceCandidates =
        device === "r"
            ? CONFIG.MAP_DEVICES
            : [device];

    // 读取并归一化 theme 参数：支持多次传参与逗号分隔，最终统一小写并去重
    const normalizedThemeValues = Array.from(new Set(query
        .getAll("t")
        .flatMap((value) => value.split(","))
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)));

    // 以 ! 为前缀的值表示排除该主题，不带前缀为包含，两者不可混用
    const themeIncludes = [];
    const themeExcludes = [];
    for (const value of normalizedThemeValues) {
        if (value.startsWith("!")) {
            const excludedTheme = value.slice(1);
            if (excludedTheme) {
                themeExcludes.push(excludedTheme);
            }
            continue;
        }

        themeIncludes.push(value);
    }

    // 包含与排除不可混用，同时存在时返回冲突错误
    if (themeIncludes.length > 0 && themeExcludes.length > 0) {
        return jsonErrorResponse(CONFIG.ERRORS.THEME_CONFLICT, {
            include: themeIncludes,
            exclude: themeExcludes,
            hint: "Use either include themes (e.g. t=nature) or exclude themes (e.g. t=!nature), not both",
        });
    }

    // 并行读取 FOLDER_MAP 与 BASE_IMAGE_URL 配置
    const [folderMap, baseImageUrl] = await Promise.all([
        getFolderMapFromKV(env),
        getBaseImageUrlFromKV(env),
    ]);
    // FOLDER_MAP 缺失或无效时返回配置错误
    if (!folderMap) {
        return jsonErrorResponse(CONFIG.ERRORS.FOLDER_MAP_CONFIG_ERROR);
    }
    // BASE_IMAGE_URL 缺失或无效时返回配置错误
    if (!baseImageUrl) {
        return jsonErrorResponse(CONFIG.ERRORS.BASE_IMAGE_URL_CONFIG_ERROR);
    }

    // 校验用户指定的主题是否在 FolderMap 中实际存在
    const themeCache = ensureValidThemeCache(folderMap);
    const allMentionedThemes = [...themeIncludes, ...themeExcludes];
    if (allMentionedThemes.length > 0) {
        const invalidTheme = allMentionedThemes.find((t) => !themeCache.themeSet.has(t));
        if (invalidTheme) {
            return jsonErrorResponse(CONFIG.ERRORS.INVALID_THEME, { field: "t" });
        }
    }

    // 构建主题候选列表：有包含则直接用，有排除则从全量中过滤，均未指定则使用全部主题
    let themeCandidates;
    if (themeIncludes.length > 0) {
        themeCandidates = themeIncludes;
    } else if (themeExcludes.length > 0) {
        const excludeSet = new Set(themeExcludes);
        themeCandidates = themeCache.themes.filter((t) => !excludeSet.has(t));
    } else {
        themeCandidates = themeCache.themes;
    }

    // 遍历 设备×亮度×主题 的所有组合，收集图片数 > 0 的候选项
    const candidates = [];
    for (const candidateDevice of deviceCandidates) {
        const deviceMap = folderMap[candidateDevice] ?? {};
        for (const brightness of brightnessCandidates) {
            for (const theme of themeCandidates) {
                const count = Number(deviceMap?.[brightness]?.[theme] ?? 0);
                if (Number.isFinite(count) && count > 0) {
                    candidates.push({ device: candidateDevice, brightness, theme, count });
                }
            }
        }
    }

    // 候选池为空时，根据是否指定了过滤条件返回不同的 404 错误
    const hasFilters = Boolean(
        requestedDevice ||
        requestedBrightness ||
        themeIncludes.length > 0 ||
        themeExcludes.length > 0
    );
    if (candidates.length === 0) {
        if (hasFilters) {
            return jsonErrorResponse(CONFIG.ERRORS.NO_IMAGES_FOR_COMBINATION);
        }
        return jsonErrorResponse(CONFIG.ERRORS.NO_AVAILABLE_IMAGES);
    }

    // 加权随机抽样：以 count 为权重选取候选组合，使每张图片被选中的概率趋于均等
    let selectedFolder;
    if (candidates.length === 1) {
        selectedFolder = candidates[0];
    } else {
        const totalWeight = candidates.reduce((sum, candidate) => sum + candidate.count, 0);
        // 有限正数求和可能溢出为 Infinity，兜底避免随机逻辑异常
        if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
            return jsonErrorResponse(CONFIG.ERRORS.NO_AVAILABLE_IMAGES, {
                hint: "No valid weighted candidates available",
            });
        }
        // 在 [0, totalWeight) 区间取随机点，线性递减直到命中
        let remainingWeight = Math.random() * totalWeight;
        selectedFolder = null;
        for (const candidate of candidates) {
            remainingWeight -= candidate.count;
            if (remainingWeight < 0) {
                selectedFolder = candidate;
                break;
            }
        }
        // 浮点精度兜底：理论上不会触发，取最后一项作为保底
        if (!selectedFolder) {
            selectedFolder = candidates[candidates.length - 1];
        }
    }

    // 构建图片 URL 并按所选方式（proxy / redirect）响应
    const { url: imageUrl, imageInfo } = buildImageResult(baseImageUrl, selectedFolder);
    return await respondImageByMethod(effectiveMethod, imageUrl, imageInfo);
};


// ===========================
// 隐藏路由-统计数据
// ===========================

// 汇总 FOLDER_MAP 中的图片数量：按设备-亮度组合分组、按主题聚合、并计算总数
const buildRandomImgCountData = (folderMap) => {
    const groupTotals = {};
    const themeDetails = {};
    let totalImages = 0;
    // 按字母序遍历设备层
    for (const device of Object.keys(folderMap).sort()) {
        const deviceEntry = folderMap[device];
        // 跳过非对象的无效设备条目
        if (!deviceEntry || typeof deviceEntry !== "object") {
            continue;
        }
        // 按字母序遍历亮度层
        for (const brightness of Object.keys(deviceEntry).sort()) {
            const brightnessEntry = deviceEntry[brightness];
            // 跳过非对象的无效亮度条目
            if (!brightnessEntry || typeof brightnessEntry !== "object") {
                continue;
            }
            const groupKey = `${device}-${brightness}`;
            let groupTotal = 0;
            // 按字母序遍历主题层，累加各组合的图片数量
            for (const theme of Object.keys(brightnessEntry).sort()) {
                const rawCount = Number(brightnessEntry[theme] ?? 0);
                const count = Number.isFinite(rawCount) ? rawCount : 0;
                groupTotal += count;
                totalImages += count;
                // 首次遇到该主题时初始化其统计对象
                if (!themeDetails[theme]) {
                    themeDetails[theme] = { total: 0 };
                }
                themeDetails[theme].total += count;
                themeDetails[theme][groupKey] = count;
            }
            groupTotals[groupKey] = groupTotal;
        }
    }
    return {
        totalImages,
        groupTotals,
        themeDetails,
    };
};

// 处理图片数量统计请求：读取 FOLDER_MAP 并返回汇总统计数据
export const handleRandomImgCount = async (request, env) => {
    if (request.method !== "GET") {
        return jsonErrorResponse({ status: 405, message: "Method Not Allowed" });
    }

    const folderMap = await getFolderMapFromKV(env);
    // 配置缺失时返回错误
    if (!folderMap) {
        return jsonErrorResponse(CONFIG.ERRORS.FOLDER_MAP_CONFIG_ERROR);
    }
    return jsonSuccessResponse(buildRandomImgCountData(folderMap));
};
