// ===========================
// 随机图片 API 配置
// ===========================

// 图片配置 KV 命名空间名称
export const CONFIG_KV_NAMESPACE = "random_img_config";
// KV 中 FOLDER_MAP 的键名，值为设备-亮度-主题到图片数量的映射 JSON
export const FOLDER_MAP_KEY = "FOLDER_MAP";
// KV 中基础图片 URL 的键名，用于拼接最终图片地址
export const BASE_IMAGE_URL_KEY = "BASE_IMAGE_URL";

// 允许的查询参数：d=设备, b=亮度, t=主题, m=响应方式
export const ALLOWED_QUERY = Object.freeze(["d", "b", "t", "m"]);
// 仅允许传入单个值的参数（主题 t 允许多值）
export const SINGLE_VALUE_QUERY = Object.freeze(["d", "b", "m"]);
// folderMap 中的设备类型：pc=桌面端, mb=移动端
export const MAP_DEVICES = Object.freeze(["pc", "mb"]);
// 请求可接受的设备值：在 MAP_DEVICES 基础上增加 r = 强制随机
export const REQUEST_DEVICES = Object.freeze([...MAP_DEVICES, "r"]);
// 亮度类型：dark=暗色, light=亮色
export const BRIGHTNESS_VALUES = Object.freeze(["dark", "light"]);
// 可选响应方式：proxy=代理转发, redirect=302 重定向
export const METHOD_VALUES = Object.freeze(["proxy", "redirect"]);

// 默认响应方式
export const DEFAULT_METHOD = "proxy";
// 是否允许 redirect 响应方式，关闭时强制回退为 proxy
export const REDIRECT_ENABLED = true;

// proxy 模式下上游请求最大重试次数
export const FETCH_MAX_ATTEMPTS = 3;
// proxy 模式下重试间隔基数（毫秒），实际延迟 = 基数 × 当前重试次数
export const FETCH_RETRY_DELAY_MS = 50;
// proxy 模式下单次上游请求超时时间（毫秒）
export const FETCH_TIMEOUT_MS = 15 * 1000;
// proxy 模式下可重试的临时上游 HTTP 状态码
export const RETRYABLE_UPSTREAM_STATUS_CODES = Object.freeze([408, 425, 429, 500, 502, 503, 504]);

// proxy 模式下是否返回 X-Image-Info 响应头（包含图片分组信息）
export const IMAGE_INFO_HEADER_ENABLED = true;
// proxy 模式下 X-Image-Info 响应头的名称
export const IMAGE_INFO_HEADER_NAME = "X-Image-Info";

// 是否启用 Referer 校验，关闭时跳过白名单检查
export const REFERER_CHECK_ENABLED = false;
// Referer 校验启用时，是否允许空 Referer（直接访问）
export const ALLOW_EMPTY_REFERER = true;

// 图片索引数字位数，如 6 → 000001
export const IMAGE_INDEX_DIGITS = 6;
// 图片文件扩展名
export const IMAGE_FILE_EXTENSION = ".webp";
// 图片路径模板：拼接在 BASE_IMAGE_URL 后，不含文件扩展名
export const IMAGE_PATH_PATTERN = "{device}-{brightness}/{theme}/{index}";

// 随机图片 API 错误定义
export const ERRORS = {
    // 非法查询参数键
    INVALID_QUERY: { status: 400, message: "Bad Request: Invalid query parameters" },
    // 单值参数重复
    DUPLICATE_QUERY: { status: 400, message: "Bad Request: Duplicate query parameter" },
    // 非法设备值
    INVALID_DEVICE: { status: 400, message: "Bad Request: Invalid device" },
    // 非法亮度值
    INVALID_BRIGHTNESS: { status: 400, message: "Bad Request: Invalid brightness" },
    // 非法主题值
    INVALID_THEME: { status: 400, message: "Bad Request: Invalid theme" },
    // 包含与排除主题混用
    THEME_CONFLICT: { status: 400, message: "Bad Request: Cannot mix include and exclude theme selectors" },
    // 非法图片响应方式参数
    INVALID_METHOD: { status: 400, message: "Bad Request: Invalid method" },
    // KV 中 BASE_IMAGE_URL 缺失或无效
    BASE_IMAGE_URL_CONFIG_ERROR: { status: 500, message: "Internal Server Error: BASE_IMAGE_URL is invalid or missing in KV" },
    // KV 中 FOLDER_MAP 缺失或无效
    FOLDER_MAP_CONFIG_ERROR: { status: 500, message: "Internal Server Error: FOLDER_MAP is invalid or missing in KV" },
    // 筛选条件下无匹配图片
    NO_IMAGES_FOR_COMBINATION: { status: 404, message: "Not Found: No available images for the selected filters" },
    // 完全无可用图片
    NO_AVAILABLE_IMAGES: { status: 404, message: "Not Found: No available images" },
    // 上游返回非成功状态码
    UPSTREAM_BAD_STATUS: { status: 502, message: "Bad Gateway: Upstream image service responded with a non-success status" },
    // 上游请求网络/运行时异常
    UPSTREAM_FETCH_EXCEPTION: { status: 502, message: "Bad Gateway: Failed to reach upstream image service due to network/runtime exception" },
};
