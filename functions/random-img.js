import { getKvJsonObjectCached, getKvUrlCached } from "../commons/kv.js";
import { jsonErrorResponse, jsonSuccessResponse } from "../commons/response.js";
import { validateRefererAccess } from "../commons/referer.js";


// ===========================
// 随机图片 API 配置
// ===========================

// KV 命名空间名称
const RANDOM_IMG_CONFIG_NAMESPACE = "random_img_config";
// KV 中 FOLDER_MAP 的键名，值为设备-亮度-主题到图片数量的映射 JSON
const FOLDER_MAP_KEY = "FOLDER_MAP";
// KV 中基础图片 URL 的键名，用于拼接最终图片地址
const BASE_IMAGE_URL_KEY = "BASE_IMAGE_URL";

// 允许的查询参数白名单：d=设备, b=亮度, t=主题, m=响应方式
const ALLOWED_PARAMS = ["d", "b", "t", "m"];
// 仅允许单值的查询参数：设备、亮度、响应方式各只能出现一次
const SINGLE_VALUE_PARAMS = ["d", "b", "m"];
// FOLDER_MAP 中实际存在的设备维度
const MAP_DEVICES = ["pc", "mb"];
// 请求允许的设备值：在 MAP_DEVICES 基础上增加 "r"（强制随机）
const REQUEST_DEVICES = [...MAP_DEVICES, "r"];
// 允许的亮度值
const BRIGHTNESS_VALUES = ["dark", "light"];
// 允许的响应方式：proxy（代理转发）或 redirect（302 跳转）
const METHOD_VALUES = ["proxy", "redirect"];

// proxy 模式下上游请求最大重试次数
const FETCH_MAX_ATTEMPTS = 3;
// proxy 模式下重试间隔基数（毫秒），实际延迟 = 基数 × 当前重试次数
const FETCH_RETRY_DELAY_MS = 50;
// 代理模式下可重试的临时上游 HTTP 状态码
const RETRYABLE_UPSTREAM_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

// 默认响应方式
const DEFAULT_METHOD = "proxy";
// 是否允许 redirect 响应方式，关闭时强制回退为 proxy
const REDIRECT_ENABLED = true;

// proxy 模式下是否返回 X-Image-Info 响应头（包含图片分组信息）
const IMAGE_INFO_HEADER_ENABLED = true;
// proxy 模式下 X-Image-Info 响应头的名称
const IMAGE_INFO_HEADER_NAME = "X-Image-Info";

// 是否启用 Referer 校验，关闭时跳过白名单检查
const REFERER_CHECK_ENABLED = false;
// Referer 校验启用时，是否允许空 Referer（直接访问）
const ALLOW_EMPTY_REFERER = true;

// 图片文件名数字位数，如 6 → 000001.webp
const IMAGE_FILENAME_DIGITS = 6;
// 图片文件扩展名
const IMAGE_FILE_EXTENSION = ".webp";

// 将数组转为 Set，用于 O(1) 校验
const ALLOWED_PARAMS_SET = new Set(ALLOWED_PARAMS);
const SINGLE_VALUE_PARAMS_SET = new Set(SINGLE_VALUE_PARAMS);
const REQUEST_DEVICE_SET = new Set(REQUEST_DEVICES);
const BRIGHTNESS_SET = new Set(BRIGHTNESS_VALUES);
const METHOD_SET = new Set(METHOD_VALUES);


// ===========================
// 随机图片 API 错误定义
// ===========================

const ERRORS = {
	// 非法查询参数键
	BAD_PARAMS: { status: 400, message: "Bad Request: Invalid query parameters" },
	// 单值参数重复
	DUPLICATE_PARAM: { status: 400, message: "Bad Request: Duplicate query parameter" },
	// 非法设备值
	BAD_DEVICE: { status: 400, message: "Bad Request: Invalid device" },
	// 非法亮度值
	BAD_BRIGHTNESS: { status: 400, message: "Bad Request: Invalid brightness" },
	// 非法主题值
	BAD_THEME: { status: 400, message: "Bad Request: Invalid theme" },
	// 包含与排除主题混用
	THEME_CONFLICT: { status: 400, message: "Bad Request: Cannot mix include and exclude theme values" },
	// 非法响应方式
	BAD_METHOD: { status: 400, message: "Bad Request: Invalid method" },
	// KV 中 BASE_IMAGE_URL 缺失或无效
	BAD_BASE_URL: { status: 500, message: "Internal Server Error: BASE_IMAGE_URL is invalid or missing in KV" },
	// KV 中 FOLDER_MAP 缺失或无效
	BAD_FOLDER_MAP: { status: 500, message: "Internal Server Error: FOLDER_MAP is invalid or missing in KV" },
	// 筛选条件下无匹配图片
	NO_COMBO_IMAGES: { status: 404, message: "Not Found: No available images for the selected filters" },
	// 完全无可用图片
	NO_IMAGES: { status: 404, message: "Not Found: No available images" },
	// 上游返回非成功状态码
	UPSTREAM_STATUS: { status: 502, message: "Bad Gateway: Upstream image service responded with a non-success status" },
	// 上游请求网络/运行时异常
	UPSTREAM_FETCH: { status: 502, message: "Bad Gateway: Failed to reach upstream image service due to network/runtime exception" },
};

// 有效主题缓存：避免每次请求重复从 FOLDER_MAP 提取主题列表
let validThemeCache = {
	themes: null,
	themeSet: null,
	sourceRef: null,
};

// 检查查询参数是否都在白名单内，若存在非法参数则直接返回 400 错误响应
const validateAllowedQueryParams = (params) => {
	for (const key of params.keys()) {
		if (!ALLOWED_PARAMS_SET.has(key)) {
			return jsonErrorResponse(ERRORS.BAD_PARAMS, {
				invalidParams: [key],
				allowedParams: ALLOWED_PARAMS,
			});
		}
	}
	// 全部合法，返回 null
	return null;
};

// 检查单值参数是否存在重复
const validateSingleValueParams = (params) => {
	for (const key of params.keys()) {
		if (SINGLE_VALUE_PARAMS_SET.has(key) && params.getAll(key).length > 1) {
			return jsonErrorResponse(ERRORS.DUPLICATE_PARAM, {
				field: key,
				hint: "This parameter only accepts a single value",
			});
		}
	}
	return null;
};

// 从 folderMap 中提取所有有效主题名列表
const buildValidThemes = (folderMap) =>
	Array.from(
		new Set(
			// 按设备展开，再按 brightness 展开，最终收集每个主题名
			MAP_DEVICES.flatMap((device) =>
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

// 读取并校验 FOLDER_MAP 配置
const getFolderMapFromKV = async (env) => {
	return getKvJsonObjectCached({
		env,
		namespace: RANDOM_IMG_CONFIG_NAMESPACE,
		key: FOLDER_MAP_KEY,
		cacheKey: "random-img::folder-map",
	});
};

// 按全局开关决定是否执行 Referer 校验，关闭时直接放行
const validateRefererByConfig = async (request, env) => {
	// Referer 校验未启用时直接放行
	if (!REFERER_CHECK_ENABLED) {
		return { allowed: true, response: null };
	}

	return validateRefererAccess({
		env,
		namespace: RANDOM_IMG_CONFIG_NAMESPACE,
		referer: request.headers.get("referer") || "",
		allowEmptyReferer: ALLOW_EMPTY_REFERER,
	});
};

// 根据所选组合随机生成图片 URL，格式：{baseUrl}{device}-{brightness}/{theme}/{number}.webp
// 同时返回未补位的图片序号，供 X-Image-Info 响应头使用
const buildImageResult = (baseImageUrl, selectedFolder) => {
	const imageNumber = Math.floor(Math.random() * selectedFolder.count) + 1;
	const imageFilename = `${String(imageNumber).padStart(IMAGE_FILENAME_DIGITS, "0")}${IMAGE_FILE_EXTENSION}`;
	const url = `${baseImageUrl}${selectedFolder.device}-${selectedFolder.brightness}/${selectedFolder.theme}/${imageFilename}`;
	const imageInfo = `${selectedFolder.device}-${selectedFolder.brightness}-${selectedFolder.theme}-${imageNumber}`;
	return { url, imageInfo };
};

// 按指定 method 响应图片：redirect 直接跳转，proxy 拉取上游后转发（失败时按次数重试）
const respondImageByMethod = async (method, imageUrl, imageInfo) => {
	// redirect 模式：直接构造 302 跳转响应
	if (method === "redirect") {
		return new Response(null, {
			status: 302,
			headers: { Location: imageUrl },
		});
	}

	// proxy 模式：循环尝试拉取上游图片，失败时按递增延迟重试
	for (let attempt = 1; attempt <= FETCH_MAX_ATTEMPTS; attempt++) {
		try {
			const fetchStartedAt = Date.now();
			const upstreamResponse = await fetch(imageUrl);
			const fetchDurationMs = Date.now() - fetchStartedAt;

			// 上游返回非 2xx 状态码：临时状态重试，其他状态立即返回错误
			if (!upstreamResponse.ok) {
				if (
					RETRYABLE_UPSTREAM_STATUS_CODES.has(upstreamResponse.status) &&
					attempt < FETCH_MAX_ATTEMPTS
				) {
					await new Promise((resolve) => setTimeout(resolve, FETCH_RETRY_DELAY_MS * attempt));
					continue;
				}

				return jsonErrorResponse(ERRORS.UPSTREAM_STATUS, {
					upstreamStatus: upstreamResponse.status,
					hint: "Upstream responded but did not return a success status",
				});
			}

			const response = new Response(upstreamResponse.body, {
				status: upstreamResponse.status,
				headers: upstreamResponse.headers,
			});
			if (IMAGE_INFO_HEADER_ENABLED) {
				response.headers.set(IMAGE_INFO_HEADER_NAME, `${imageInfo}; ${fetchDurationMs}`);
			}
			return response;
		} catch {
			// 已耗尽重试次数，返回上游请求失败错误
			if (attempt >= FETCH_MAX_ATTEMPTS) {
				return jsonErrorResponse(ERRORS.UPSTREAM_FETCH, {
					hint: "Upstream request failed before receiving a valid response",
					retryAttempts: attempt,
				});
			}
			await new Promise((resolve) => setTimeout(resolve, FETCH_RETRY_DELAY_MS * attempt));
		}
	}
};


// ===========================
// 随机图片主处理逻辑
// 处理随机图片请求：参数校验 -> 候选组合筛选 -> 加权抽样 -> redirect/proxy 返回
// ===========================

export const handleRandomImg = async (request, env) => {
	// 仅允许 GET 请求，其余方法返回 405
	if (request.method !== "GET") {
		return jsonErrorResponse({ status: 405, message: "Method Not Allowed" });
	}

	const refererCheckResult = await validateRefererByConfig(request, env);
	if (!refererCheckResult.allowed) {
		return refererCheckResult.response;
	}

	// 解析请求 URL 以获取路径与查询参数
	let params;
	try {
		params = new URL(request.url).searchParams;
	} catch {
		return jsonErrorResponse({
			status: 400,
			message: "Bad Request: Request URL is malformed or cannot be parsed",
		}, {
			hint: "Ensure the request URL is valid and properly encoded",
		});
	}

	// 校验查询参数白名单，存在非法参数时直接返回错误
	const invalidParamsResponse = validateAllowedQueryParams(params);
	if (invalidParamsResponse) {
		return invalidParamsResponse;
	}

	// 校验单值参数不可重复，同一键只能出现一次
	const duplicateParamResponse = validateSingleValueParams(params);
	if (duplicateParamResponse) {
		return duplicateParamResponse;
	}

	// 解析响应方式
	const method = params.get("m")?.toLowerCase() || DEFAULT_METHOD;

	// 校验 method 参数：仅允许 proxy 或 redirect
	if (!METHOD_SET.has(method)) {
		return jsonErrorResponse(ERRORS.BAD_METHOD, { field: "m" });
	}

	// 强制开关：若关闭 redirect，则无论参数如何都用 proxy
	const effectiveMethod = REDIRECT_ENABLED ? method : "proxy";

	// 读取亮度参数（若未传则为 null）
	const requestedBrightness = params.get("b")?.toLowerCase() || null;
	// 校验亮度参数合法性（允许 dark / light）
	if (requestedBrightness && !BRIGHTNESS_SET.has(requestedBrightness)) {
		return jsonErrorResponse(ERRORS.BAD_BRIGHTNESS, { field: "b" });
	}
	// 构建亮度候选列表：指定时仅用该值，否则使用全部亮度
	const brightnessCandidates = requestedBrightness ? [requestedBrightness] : BRIGHTNESS_VALUES;

	// 读取请求指定的设备参数（若未传则为 null）
	const requestedDevice = params.get("d")?.toLowerCase() || null;
	// 校验设备参数合法性（允许 pc / mb / r）
	if (requestedDevice && !REQUEST_DEVICE_SET.has(requestedDevice)) {
		return jsonErrorResponse(ERRORS.BAD_DEVICE, { field: "d" });
	}

	// 未指定设备时，根据 User-Agent 自动推断；无法识别则回退到随机
	let autoDevice = "r";
	if (!requestedDevice) {
		const userAgent = request.headers.get("User-Agent") || "";
		const isMobile = /Mobi|Android|iPhone/i.test(userAgent);
		const isDesktop = /Windows|Macintosh|Linux x86_64|X11/i.test(userAgent);
		autoDevice = isMobile ? "mb" : (isDesktop ? "pc" : "r");
	}
	const device = requestedDevice || autoDevice;
	// 构建设备候选列表："r" 展开为全部设备，否则仅用指定值
	const deviceCandidates =
		device === "r"
			? MAP_DEVICES
			: [device];

	// 读取并归一化 theme 参数：支持多次传参与逗号分隔，最终统一小写并去重
	const normalizedThemeValues = Array.from(new Set(params
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
		return jsonErrorResponse(ERRORS.THEME_CONFLICT, {
			include: themeIncludes,
			exclude: themeExcludes,
			hint: "Use either include themes (e.g. t=nature) or exclude themes (e.g. t=!nature), not both",
		});
	}

	// 并行读取 FOLDER_MAP 与 BASE_IMAGE_URL 配置（两者互不依赖）
	const [folderMap, baseImageUrl] = await Promise.all([
		getFolderMapFromKV(env),
		getKvUrlCached({
			env,
			namespace: RANDOM_IMG_CONFIG_NAMESPACE,
			key: BASE_IMAGE_URL_KEY,
			cacheKey: "random-img::base-image-url",
		}),
	]);
	// FOLDER_MAP 缺失或无效时返回配置错误
	if (!folderMap) {
		return jsonErrorResponse(ERRORS.BAD_FOLDER_MAP);
	}
	// BASE_IMAGE_URL 为空时返回配置错误
	if (!baseImageUrl) {
		return jsonErrorResponse(ERRORS.BAD_BASE_URL);
	}

	// 校验主题参数：所有提及的主题名必须在 FOLDER_MAP 中存在
	const themeCache = ensureValidThemeCache(folderMap);
	const allMentionedThemes = [...themeIncludes, ...themeExcludes];
	if (allMentionedThemes.length > 0) {
		const invalidTheme = allMentionedThemes.find((t) => !themeCache.themeSet.has(t));
		if (invalidTheme) {
			return jsonErrorResponse(ERRORS.BAD_THEME, { field: "t" });
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

	// 三重遍历（设备 × 亮度 × 主题）构建候选组合，仅保留图片数 > 0 的有效组合
	const candidates = [];
	for (const candidateDevice of deviceCandidates) {
		const deviceMap = folderMap[candidateDevice] ?? {};
		for (const b of brightnessCandidates) {
			for (const t of themeCandidates) {
				const count = Number(deviceMap?.[b]?.[t] ?? 0);
				if (Number.isFinite(count) && count > 0) {
					candidates.push({ device: candidateDevice, brightness: b, theme: t, count });
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
			return jsonErrorResponse(ERRORS.NO_COMBO_IMAGES);
		}
		return jsonErrorResponse(ERRORS.NO_IMAGES, {
			hint: "Check FOLDER_MAP counts in KV to ensure at least one image count is greater than 0",
		});
	}

	// 加权随机抽样：以 count 为权重选取候选组合，使每张图片被选中的概率趋于均等
	let selectedFolder;
	if (candidates.length === 1) {
		selectedFolder = candidates[0];
	} else {
		const totalWeight = candidates.reduce((sum, candidate) => sum + candidate.count, 0);
		// 总权重非法时兜底返回错误，避免随机逻辑异常
		if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
			return jsonErrorResponse(ERRORS.NO_IMAGES, {
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
				const count = Number(brightnessEntry[theme] ?? 0);
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
export const handleRandomImgCount = async (_request, env) => {
	const folderMap = await getFolderMapFromKV(env);
	// 配置缺失时返回错误
	if (!folderMap) {
		return jsonErrorResponse(ERRORS.BAD_FOLDER_MAP);
	}
	return jsonSuccessResponse(buildRandomImgCountData(folderMap));
};
