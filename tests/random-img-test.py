#!/usr/bin/env python3
"""
随机图片 API (/random-img) 端到端集成测试。

运行方式：
    CONFIG='{"API_BASE_URL":"...","ASSET_BASE_URL":"...","RANDOM_IMG_COUNT_PATH":"..."}' python3 random-img-test.py

测试流程：
    1) 隐藏统计路由 — 校验响应结构与数据类型
    2) 请求方法限制 — 非 GET 方法应返回 405
    3) 错误参数覆盖 — 各类非法参数返回对应 4xx 错误
    3.5) 单值参数重复 — d/b/m 重复时返回 400，t 重复则允许
    4) 大小写兼容 — 参数值大小写不敏感
    5) 默认请求 — 无参数时 proxy 返回图片
    6) 组合覆盖 — 基于统计数据遍历设备×亮度
    7) 有效参数组合 — 各种合法 query 返回 200
    8) 多主题/主题排除 — CSV 与重复参数形式
    9) 全量组合 — 每个有图组合至少测一次 proxy + redirect
    10) 方法模式行为 — proxy 与 redirect 语义断言
    11) 稳定性抽样 — 多次随机请求验证一致性
"""
from __future__ import annotations

import json
import os
import re
import socket
import ssl
import time
import http.client
import urllib.parse
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any


# ===========================
# 工具函数：环境变量与配置解析
# ===========================


# 读取必需的环境变量，缺失时抛出异常。
def _required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


# 关键运行/测试参数（规则变化时优先修改这里）。
# 统一配置环境变量名（JSON 字符串）。
CONFIG_ENV_NAME = "CONFIG"

# 单次 HTTP 请求超时时间（秒）。
TIMEOUT_SECONDS = 30.0
# 稳定性测试中抽样次数。
RANDOM_RUNS = 10
# 未传 m 参数时的默认响应方式。
DEFAULT_METHOD = "proxy"
# redirect 行为开关：True=期望 m=redirect 返回 302，False=期望回退到 proxy。
REDIRECT_ENABLED = True
# proxy 模式下是否返回图片信息响应头。
IMAGE_INFO_HEADER_ENABLED = True
# proxy 模式下图片信息响应头名称。
IMAGE_INFO_HEADER_NAME = "X-Image-Info"
# 图片索引数字位数（例如 6 -> 000001）。
IMAGE_INDEX_DIGITS = 6
# 图片文件扩展名。
IMAGE_FILE_EXTENSION = ".webp"
# 图片路径模板，需与 functions/random-img/config.js 中的 IMAGE_PATH_PATTERN 保持一致。
IMAGE_PATH_PATTERN = "{device}-{brightness}/{theme}/{index}"
# 5xx 响应最大重试次数（不含首次请求）。
MAX_HTTP_5XX_RETRIES = 5
# 瞬时网络/读取失败时的最大重试次数（不含首次请求）。
MAX_NETWORK_RETRIES = 5
# 线性退避基数（sleep = base * attempt）。
RETRY_BACKOFF_BASE_SECONDS = 1
# 认为可重试的服务端状态码范围。
RETRYABLE_STATUS_MIN = 500
RETRYABLE_STATUS_MAX = 599

# 从统计结果筛选测试组合时允许的设备与亮度维度。
SUPPORTED_DEVICES = {"pc", "mb"}
SUPPORTED_BRIGHTNESS = {"dark", "light"}

# 一次完整测试中必须覆盖到的错误类型。
REQUIRED_ERROR_COVERAGE_KEYS = {
    "INVALID_QUERY",
    "DUPLICATE_QUERY",
    "INVALID_DEVICE",
    "INVALID_BRIGHTNESS",
    "INVALID_METHOD",
    "INVALID_THEME",
    "THEME_CONFLICT",
}
# 受数据分布影响、可能缺失的错误类型。
OPTIONAL_ERROR_COVERAGE_KEYS = {"NO_IMAGES_FOR_COMBINATION"}


# 确保 URL 以 / 结尾，用于拼接资源路径。
def _normalize_asset_base_url(url: str) -> str:
    return url.rstrip("/") + "/"


# 将图片路径模板转换成 redirect Location 的正则片段。
def _image_path_pattern_to_regex(pattern: str) -> str:
    token_patterns = {
        "device": r"(pc|mb)",
        "brightness": r"(dark|light)",
        "theme": r"[a-z0-9_-]+",
        "index": rf"\d{{{IMAGE_INDEX_DIGITS}}}",
    }

    normalized_pattern = str(pattern).strip().lstrip("/")
    escaped_pattern = re.escape(normalized_pattern)
    for token, token_pattern in token_patterns.items():
        escaped_pattern = escaped_pattern.replace(re.escape(f"{{{token}}}"), token_pattern)
    return escaped_pattern


# 解析 CONFIG JSON 字符串为字典，格式异常时抛出。
def _required_config(raw_config: str) -> dict[str, Any]:
    try:
        parsed = json.loads(raw_config)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Invalid CONFIG JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise RuntimeError("Invalid CONFIG JSON: root must be an object")
    return parsed


# 从 CONFIG 字典中提取必需的字符串字段。
def _required_config_str(config: dict[str, Any], key: str) -> str:
    value = config.get(key)
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError(f"Missing or invalid CONFIG field: {key}")
    return value.strip()


def _mask_config_for_log(config_raw: str) -> str:
    """
    对 CONFIG_RAW 进行脱敏，只保留字段名和类型信息，不输出具体值。
    """
    try:
        parsed = json.loads(config_raw)
        if isinstance(parsed, dict):
            summary = {k: type(v).__name__ for k, v in parsed.items()}
            return f"<CONFIG fields: {summary}>"
        else:
            return "<CONFIG: not a dict>"
    except Exception:
        return "<CONFIG: invalid JSON>"


# ===========================
# 全局配置初始化
# ===========================

CONFIG_RAW = _required_env(CONFIG_ENV_NAME)
CONFIG = _required_config(CONFIG_RAW)

API_BASE_URL = _required_config_str(CONFIG, "API_BASE_URL")
ASSET_BASE_URL = _normalize_asset_base_url(
    _required_config_str(CONFIG, "ASSET_BASE_URL")
)
RANDOM_IMG_COUNT_PATH = "/" + _required_config_str(
    CONFIG, "RANDOM_IMG_COUNT_PATH"
).strip("/")
IMAGE_PATH_PATTERN = str(IMAGE_PATH_PATTERN).strip().lstrip("/")

HIDDEN_ROUTE_QUERY_FORBIDDEN_MESSAGE_PART = "Routes do not accept query parameters"

SENSITIVE_LOG_TOKENS = sorted(
    {
        str(value).strip()
        for value in CONFIG.values()
        if isinstance(value, str) and str(value).strip()
    },
    key=len,
    reverse=True,
)

# 重定向地址格式校验正则（基于 ASSET_BASE_URL、IMAGE_PATH_PATTERN 与 IMAGE_FILE_EXTENSION 做完整 URL 校验）。
REDIRECT_LOCATION_PATTERN = rf"^{re.escape(ASSET_BASE_URL)}{_image_path_pattern_to_regex(IMAGE_PATH_PATTERN)}{re.escape(IMAGE_FILE_EXTENSION)}$"

# X-Image-Info 响应头格式校验正则：{device}-{brightness}-{theme}-{imageIndex}; {ms}
IMAGE_INFO_HEADER_PATTERN = re.compile(r"^(pc|mb)-(dark|light)-[a-z0-9_-]+-\d+; \d+$")


# ===========================
# 日志脱敏工具
# ===========================


# 将 URL 替换为占位符，避免日志泄露敏感地址。
def _mask_url_for_log(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    if not parsed.scheme or not parsed.netloc:
        return "<invalid-url>"
    return "<redacted-url>"


# 对文本中的 URL 和敏感 token 统一做脱敏替换。
def _redact_urls_in_text(text: str, extra_tokens: list[str] | None = None) -> str:
    value = str(text)

    redact_tokens = list(SENSITIVE_LOG_TOKENS)
    if extra_tokens:
        redact_tokens.extend(extra_tokens)

    for token in sorted(set(redact_tokens), key=len, reverse=True):
        if not token:
            continue
        value = value.replace(token, "<redacted-value>")

    def _replace(match: re.Match[str]) -> str:
        return _mask_url_for_log(match.group(0))

    return re.sub(r"https?://[^\s'\"\]\[)>,]+", _replace, value)


# 禁止自动跟随重定向的 handler，用于断言 302 响应本身。
class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


# HTTP 响应的结构化封装。
@dataclass
class HttpResult:
    status: int
    headers: dict[str, str]
    body: bytes

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")


# ===========================
# 核心测试类
# ===========================


class ApiTester:
    def __init__(
        self, api_base_url: str, asset_base_url: str, timeout: float, random_runs: int
    ) -> None:
        self.api_base_url = api_base_url.rstrip("/")
        self.asset_base_url = _normalize_asset_base_url(asset_base_url)
        self.timeout = timeout
        self.random_runs = random_runs
        self.error_coverage: dict[str, bool] = {
            "INVALID_QUERY": False,
            "DUPLICATE_QUERY": False,
            "INVALID_DEVICE": False,
            "INVALID_BRIGHTNESS": False,
            "INVALID_METHOD": False,
            "INVALID_THEME": False,
            "THEME_CONFLICT": False,
            "NO_IMAGES_FOR_COMBINATION": False,
        }
        self.passed = 0
        self.failed = 0
        self.failures: list[str] = []
        self.theme_tokens_for_log: list[str] = []
        self._next_assert_retry_note = ""

        self.normal_opener = urllib.request.build_opener()
        self.no_redirect_opener = urllib.request.build_opener(NoRedirectHandler())

    def register_theme_tokens(self, themes: list[str]) -> None:
        # 动态收集主题名，后续统一做日志脱敏。
        merged = {token for token in self.theme_tokens_for_log if token}
        for theme in themes:
            normalized = str(theme).strip()
            if normalized:
                merged.add(normalized)
        self.theme_tokens_for_log = sorted(merged, key=len, reverse=True)

    # 对日志文本做脱敏处理（URL + 主题名等敏感 token）。
    def redact_for_log(self, text: str) -> str:
        return _redact_urls_in_text(text, extra_tokens=self.theme_tokens_for_log)

    # 格式化重试次数后缀，非零时追加到断言标签中。
    def _format_retry_note(self, http_5xx_retries: int, network_retries: int) -> str:
        total_retries = http_5xx_retries + network_retries
        if total_retries <= 0:
            return ""
        return f" (retries={total_retries})"

    # 拼接完整请求 URL（路径 + query 参数）。支持 dict 或元组列表（用于重复 key）。
    def _build_url(
        self,
        path: str,
        query: dict[str, str] | list[tuple[str, str]] | None = None,
    ) -> str:
        if not path.startswith("/"):
            path = "/" + path
        if not query:
            return f"{self.api_base_url}{path}"
        return f"{self.api_base_url}{path}?{urllib.parse.urlencode(query)}"

    # 底层请求执行：负责网络重试、5xx 重试和结果结构化。
    def _do_request(
        self, url: str, method: str, follow_redirects: bool
    ) -> HttpResult:
        req = urllib.request.Request(url, method=method)
        opener = self.normal_opener if follow_redirects else self.no_redirect_opener

        http_5xx_retries = 0
        network_retries = 0

        while True:
            try:
                with opener.open(req, timeout=self.timeout) as resp:
                    status = resp.getcode()
                    headers = {k.lower(): v for k, v in resp.headers.items()}
                    try:
                        body = resp.read()
                    except http.client.IncompleteRead as exc:
                        partial = bytes(exc.partial or b"")
                        if partial:
                            body = partial
                        elif network_retries < MAX_NETWORK_RETRIES:
                            network_retries += 1
                            time.sleep(RETRY_BACKOFF_BASE_SECONDS * network_retries)
                            continue
                        else:
                            raise
                    self._next_assert_retry_note = self._format_retry_note(
                        http_5xx_retries, network_retries
                    )
                    return HttpResult(
                        status=status,
                        headers=headers,
                        body=body,
                    )
            except urllib.error.HTTPError as exc:
                if (
                    RETRYABLE_STATUS_MIN <= exc.code <= RETRYABLE_STATUS_MAX
                    and http_5xx_retries < MAX_HTTP_5XX_RETRIES
                ):
                    http_5xx_retries += 1
                    time.sleep(RETRY_BACKOFF_BASE_SECONDS * http_5xx_retries)
                    continue
                try:
                    error_body = exc.read()
                except http.client.IncompleteRead as read_exc:
                    error_body = bytes(read_exc.partial or b"")
                self._next_assert_retry_note = self._format_retry_note(
                    http_5xx_retries, network_retries
                )
                return HttpResult(
                    status=exc.code,
                    headers={k.lower(): v for k, v in exc.headers.items()},
                    body=error_body,
                )
            except (
                urllib.error.URLError,
                socket.timeout,
                TimeoutError,
                ssl.SSLError,
                http.client.IncompleteRead,
                http.client.RemoteDisconnected,
                ConnectionResetError,
                OSError,
            ) as exc:
                if network_retries >= MAX_NETWORK_RETRIES:
                    self._next_assert_retry_note = self._format_retry_note(
                        http_5xx_retries, network_retries
                    )
                    return HttpResult(
                        status=599,
                        headers={},
                        body=f"request failed after retries: {exc}".encode(
                            "utf-8", errors="replace"
                        ),
                    )
                network_retries += 1
                time.sleep(RETRY_BACKOFF_BASE_SECONDS * network_retries)

    # 统一请求入口（query 为 dict）。
    def request(
        self,
        path: str,
        query: dict[str, str] | None = None,
        follow_redirects: bool = True,
        method: str = "GET",
    ) -> HttpResult:
        return self._do_request(self._build_url(path, query), method, follow_redirects)

    # 统一请求入口（query 为元组列表，支持重复 key 如 t=a&t=b）。
    def request_query_items(
        self,
        path: str,
        query_items: list[tuple[str, str]],
        follow_redirects: bool = True,
        method: str = "GET",
    ) -> HttpResult:
        return self._do_request(self._build_url(path, query_items), method, follow_redirects)

    # 单条件断言：通过时计数 PASS，失败时记录详情并计数 FAIL。
    def assert_true(self, condition: bool, label: str, details: str = "") -> None:
        retry_note = self._next_assert_retry_note
        self._next_assert_retry_note = ""
        safe_label = self.redact_for_log(f"{label}{retry_note}")
        if condition:
            self.passed += 1
            print(f"[PASS] {safe_label}")
            return

        self.failed += 1
        message = f"[FAIL] {safe_label}"
        if details:
            message += f" | {self.redact_for_log(details)}"
        self.failures.append(message)
        print(message)

    # 解析响应 body 为 JSON，失败时标记断言失败并返回 None。
    def parse_json(self, result: HttpResult, label: str) -> Any:
        try:
            return json.loads(result.text)
        except json.JSONDecodeError as exc:
            self.assert_true(
                False,
                label,
                f"Invalid JSON: {exc}; body={self.redact_for_log(result.text[:200])}",
            )
            return None

    # 根据错误消息关键词标记已覆盖的错误类型，用于最终覆盖率检查。
    def _mark_error_coverage(self, message: str) -> None:
        if "Invalid query parameters" in message:
            self.error_coverage["INVALID_QUERY"] = True
        elif "Duplicate query parameter" in message:
            self.error_coverage["DUPLICATE_QUERY"] = True
        elif "Invalid device" in message:
            self.error_coverage["INVALID_DEVICE"] = True
        elif "Invalid brightness" in message:
            self.error_coverage["INVALID_BRIGHTNESS"] = True
        elif "Invalid method" in message:
            self.error_coverage["INVALID_METHOD"] = True
        elif "Invalid theme" in message:
            self.error_coverage["INVALID_THEME"] = True
        elif "Cannot mix include and exclude" in message:
            self.error_coverage["THEME_CONFLICT"] = True
        elif "No available images for the selected filters" in message:
            self.error_coverage["NO_IMAGES_FOR_COMBINATION"] = True

    # 校验错误响应的 JSON 结构：content-type、status、message 字段。
    def _assert_error_json_payload(
        self, result: HttpResult, expected_status: int, label: str
    ) -> dict[str, Any] | None:
        self.assert_true(
            "application/json" in result.headers.get("content-type", ""),
            f"{label} (content-type)",
            result.headers.get("content-type", ""),
        )
        payload = self.parse_json(result, f"{label} (json parse)")
        if not isinstance(payload, dict):
            return None
        self.assert_true(
            payload.get("status") == expected_status,
            f"{label} (payload status)",
            str(payload),
        )
        message = payload.get("message")
        self.assert_true(
            isinstance(message, str) and bool(message.strip()),
            f"{label} (payload message)",
            str(payload),
        )
        if isinstance(message, str):
            self._mark_error_coverage(message)
        return payload

    def expect_json_error(
        self,
        path: str,
        query: dict[str, str],
        expected_status: int,
        expected_message_part: str,
        label: str,
        expected_detail_keys: list[str] | None = None,
        forbidden_detail_keys: list[str] | None = None,
        expected_field: str | None = None,
        expect_allowed_list: bool = False,
    ) -> None:
        # 错误场景统一断言：状态码、JSON 基本结构与可选 details 字段。
        result = self.request(path, query=query, follow_redirects=True)
        self.assert_true(
            result.status == expected_status,
            label,
            f"status={result.status}, expected={expected_status}",
        )
        payload = self._assert_error_json_payload(result, expected_status, label)
        if not isinstance(payload, dict):
            return
        message = str(payload.get("message", ""))
        self.assert_true(
            expected_message_part in message, f"{label} (message)", f"message={message}"
        )

        if (
            expected_detail_keys is None
            and forbidden_detail_keys is None
            and expected_field is None
            and not expect_allowed_list
        ):
            return

        details = payload.get("details")
        self.assert_true(
            isinstance(details, dict), f"{label} (details object)", str(payload)
        )
        if not isinstance(details, dict):
            return

        if expected_detail_keys:
            for key in expected_detail_keys:
                self.assert_true(
                    key in details, f"{label} (details.{key})", str(details)
                )

        if forbidden_detail_keys:
            for key in forbidden_detail_keys:
                self.assert_true(
                    key not in details, f"{label} (details.{key} absent)", str(details)
                )

        if expected_field is not None:
            self.assert_true(
                details.get("field") == expected_field,
                f"{label} (details.field)",
                str(details),
            )

        if expect_allowed_list:
            allowed = details.get("allowed")
            self.assert_true(
                isinstance(allowed, list) and len(allowed) > 0,
                f"{label} (details.allowed)",
                str(details),
            )

    def expect_empty_status(
        self,
        path: str,
        query: dict[str, str] | None,
        expected_status: int,
        label: str,
        follow_redirects: bool = True,
    ) -> HttpResult:
        # 用于 302 等应返回空 body 的场景，返回结果供后续断言 header。
        result = self.request(path, query=query, follow_redirects=follow_redirects)
        self.assert_true(
            result.status == expected_status,
            label,
            f"status={result.status}, expected={expected_status}",
        )
        self.assert_true(
            len(result.body) == 0, f"{label} empty body", f"len={len(result.body)}"
        )
        return result

    # 断言 302 Location 头以 ASSET_BASE_URL 开头。
    def assert_redirect_asset_base(self, location: str, label: str) -> None:
        if not location:
            self.assert_true(False, label, "empty location")
            return
        self.assert_true(
            location.startswith(self.asset_base_url),
            label,
            f"expected_prefix={self.asset_base_url}, location={location}",
        )

    # 主测试流程入口：依次执行所有测试段落并汇总结果。
    def run(self) -> int:
        print(f"CONFIG env value: {_mask_config_for_log(CONFIG_RAW)}")
        print(f"Testing API base URL: {_mask_url_for_log(self.api_base_url)}")
        print(
            f"Expect asset base URL: {_mask_url_for_log(self.asset_base_url)} (strict=True)"
        )
        print(f"Expect image path pattern: {IMAGE_PATH_PATTERN}{IMAGE_FILE_EXTENSION}")
        print(f"Expect actual redirect behavior: {REDIRECT_ENABLED}")
        started = time.time()

        # 1) 隐藏统计路由：仅做边界校验（状态、类型、非负值）。
        count_resp = self.request(RANDOM_IMG_COUNT_PATH)
        self.assert_true(count_resp.status == 200, "GET count route status")
        self.assert_true(
            "application/json" in count_resp.headers.get("content-type", ""),
            "GET count route content-type",
            count_resp.headers.get("content-type", ""),
        )
        count_data = self.parse_json(count_resp, "GET count route json")
        if not isinstance(count_data, dict):
            return 1

        required_keys = {"totalImages", "groupTotals", "themeDetails"}
        self.assert_true(
            required_keys.issubset(set(count_data.keys())), "count json keys"
        )

        group_totals = count_data.get("groupTotals", {})
        theme_details = count_data.get("themeDetails", {})

        if isinstance(theme_details, dict):
            self.register_theme_tokens([str(theme) for theme in theme_details.keys()])

        self.assert_true(isinstance(group_totals, dict), "groupTotals is object")
        self.assert_true(isinstance(theme_details, dict), "themeDetails is object")
        if not isinstance(group_totals, dict) or not isinstance(theme_details, dict):
            return 1

        try:
            total_images = int(count_data.get("totalImages", -1))
        except (TypeError, ValueError):
            total_images = -1
        self.assert_true(
            total_images >= 0,
            "totalImages is non-negative integer",
            str(count_data.get("totalImages")),
        )

        self.assert_true(
            all(isinstance(value, int) and value >= 0 for value in group_totals.values()),
            "groupTotals values are non-negative integers",
        )

        # 将统计数据展开为 device/brightness/theme/count 的扁平列表，供后续测试使用。
        normalized_theme_details: list[dict[str, Any]] = []
        for theme, detail in theme_details.items():
            if not isinstance(detail, dict):
                continue
            for group_key, count in detail.items():
                if group_key == "total":
                    continue
                if not isinstance(count, int):
                    continue
                try:
                    device, brightness = group_key.split("-", 1)
                except ValueError:
                    continue
                if device not in SUPPORTED_DEVICES or brightness not in SUPPORTED_BRIGHTNESS:
                    continue
                normalized_theme_details.append(
                    {
                        "device": device,
                        "brightness": brightness,
                        "theme": str(theme),
                        "count": count,
                    }
                )

        # 抽样校验 themeDetails 中首个条目的结构与类型。
        if theme_details:
            sample_theme, sample_detail = next(iter(theme_details.items()))
            self.register_theme_tokens([str(sample_theme)])
            self.assert_true(bool(str(sample_theme).strip()), "themeDetails theme key is non-empty")
            self.assert_true(isinstance(sample_detail, dict), "themeDetails item is object")
            if isinstance(sample_detail, dict):
                sample_total = sample_detail.get("total")
                self.assert_true(
                    isinstance(sample_total, int) and sample_total >= 0,
                    "themeDetails total is non-negative integer",
                    str(sample_total),
                )

        # 隐藏路由附带查询参数时应返回 403。
        self.expect_json_error(
            RANDOM_IMG_COUNT_PATH,
            {"x": "1"},
            403,
            HIDDEN_ROUTE_QUERY_FORBIDDEN_MESSAGE_PART,
            "count route query forbidden",
        )

        # 2) 请求方法限制：非 GET 方法应返回 405。
        for bad_method in ["POST", "PUT", "DELETE", "PATCH"]:
            method_result = self.request("/random-img", method=bad_method)
            self.assert_true(
                method_result.status == 405,
                f"{bad_method} /random-img returns 405",
                f"status={method_result.status}",
            )

        # 3) 错误参数覆盖（仅 /random-img）
        # 非法 query key（不在白名单内）应返回 400。
        self.expect_json_error(
            "/random-img",
            {"x": "1"},
            400,
            "Invalid query parameters",
            "invalid query key",
            expected_detail_keys=["invalidQuery", "allowedQuery"],
        )
        # 非法 device 值应返回 400 并附带 field 详情。
        self.expect_json_error(
            "/random-img",
            {"d": "bad-device"},
            400,
            "Invalid device",
            "invalid device",
            expected_field="d",
            forbidden_detail_keys=["allowed"],
        )
        # 非法 brightness 值应返回 400。
        self.expect_json_error(
            "/random-img",
            {"b": "bad-brightness"},
            400,
            "Invalid brightness",
            "invalid brightness",
            expected_field="b",
            forbidden_detail_keys=["allowed"],
        )
        # 非法 method 值应返回 400。
        self.expect_json_error(
            "/random-img",
            {"m": "bad-method"},
            400,
            "Invalid method",
            "invalid method",
            expected_field="m",
            forbidden_detail_keys=["allowed"],
        )
        # 不存在的主题名应返回 400，且不暴露 allowed 列表。
        self.expect_json_error(
            "/random-img",
            {"t": "__nonexistent_theme__"},
            400,
            "Invalid theme",
            "invalid theme",
            expected_field="t",
            forbidden_detail_keys=["allowed"],
        )
        # 含非法 key 时，即使其他参数合法也应优先返回 invalid query 错误。
        self.expect_json_error(
            "/random-img",
            {"m": "ReDiReCt", "x": "1"},
            400,
            "Invalid query parameters",
            "invalid query key has higher priority than method logic",
            expected_detail_keys=["invalidQuery", "allowedQuery"],
        )

        # 非法 key 与合法已知参数混用时仍应拦截。
        self.expect_json_error(
            "/random-img",
            {"x": "1", "d": "pc", "m": "redirect"},
            400,
            "Invalid query parameters",
            "invalid query still blocks valid known params",
            expected_detail_keys=["invalidQuery", "allowedQuery"],
        )

        # method 校验优先级高于 device/brightness/theme。
        self.expect_json_error(
            "/random-img",
            {"d": "bad-device", "m": "bad-method"},
            400,
            "Invalid method",
            "invalid method has priority over device/brightness/theme",
            expected_field="m",
            forbidden_detail_keys=["allowed"],
        )

        # 3.5) 单值参数重复（d/b/m 各只能出现一次）→ 400 DUPLICATE_QUERY
        dup_device_result = self.request_query_items(
            "/random-img",
            query_items=[("d", "pc"), ("d", "mb")],
            follow_redirects=True,
        )
        self.assert_true(
            dup_device_result.status == 400,
            "duplicate device param status",
            f"status={dup_device_result.status}, expected=400",
        )
        dup_device_payload = self._assert_error_json_payload(
            dup_device_result, 400, "duplicate device param"
        )
        if isinstance(dup_device_payload, dict):
            dup_device_message = str(dup_device_payload.get("message", ""))
            self.assert_true(
                "Duplicate query parameter" in dup_device_message,
                "duplicate device param message",
                f"message={dup_device_message}",
            )
            dup_device_details = dup_device_payload.get("details", {})
            self.assert_true(
                isinstance(dup_device_details, dict) and dup_device_details.get("field") == "d",
                "duplicate device param field=d",
                str(dup_device_details),
            )

        dup_brightness_result = self.request_query_items(
            "/random-img",
            query_items=[("b", "dark"), ("b", "light")],
            follow_redirects=True,
        )
        self.assert_true(
            dup_brightness_result.status == 400,
            "duplicate brightness param status",
            f"status={dup_brightness_result.status}, expected=400",
        )
        dup_brightness_payload = self._assert_error_json_payload(
            dup_brightness_result, 400, "duplicate brightness param"
        )
        if isinstance(dup_brightness_payload, dict):
            dup_brightness_message = str(dup_brightness_payload.get("message", ""))
            self.assert_true(
                "Duplicate query parameter" in dup_brightness_message,
                "duplicate brightness param message",
                f"message={dup_brightness_message}",
            )
            dup_brightness_details = dup_brightness_payload.get("details", {})
            self.assert_true(
                isinstance(dup_brightness_details, dict) and dup_brightness_details.get("field") == "b",
                "duplicate brightness param field=b",
                str(dup_brightness_details),
            )

        dup_method_result = self.request_query_items(
            "/random-img",
            query_items=[("m", "proxy"), ("m", "redirect")],
            follow_redirects=True,
        )
        self.assert_true(
            dup_method_result.status == 400,
            "duplicate method param status",
            f"status={dup_method_result.status}, expected=400",
        )
        dup_method_payload = self._assert_error_json_payload(
            dup_method_result, 400, "duplicate method param"
        )
        if isinstance(dup_method_payload, dict):
            dup_method_message = str(dup_method_payload.get("message", ""))
            self.assert_true(
                "Duplicate query parameter" in dup_method_message,
                "duplicate method param message",
                f"message={dup_method_message}",
            )
            dup_method_details = dup_method_payload.get("details", {})
            self.assert_true(
                isinstance(dup_method_details, dict) and dup_method_details.get("field") == "m",
                "duplicate method param field=m",
                str(dup_method_details),
            )

        # 重复 t 参数应仍然允许（t 是多值参数）。
        any_valid_theme = next(
            (str(row["theme"]) for row in normalized_theme_details if int(row["count"]) > 0),
            None,
        )
        if any_valid_theme:
            dup_theme_ok = self.request_query_items(
                "/random-img",
                query_items=[("t", any_valid_theme), ("t", any_valid_theme), ("m", "proxy")],
                follow_redirects=True,
            )
            self.assert_true(
                dup_theme_ok.status == 200,
                "duplicate theme param still allowed",
                f"status={dup_theme_ok.status}",
            )

        # 非法 key 校验优先级高于重复参数校验。
        dup_with_invalid_key = self.request_query_items(
            "/random-img",
            query_items=[("x", "1"), ("d", "pc"), ("d", "mb")],
            follow_redirects=True,
        )
        self.assert_true(
            dup_with_invalid_key.status == 400,
            "invalid key priority over duplicate param",
            f"status={dup_with_invalid_key.status}",
        )
        dup_with_invalid_payload = self.parse_json(dup_with_invalid_key, "invalid key priority json")
        if isinstance(dup_with_invalid_payload, dict):
            self.assert_true(
                "Invalid query parameters" in str(dup_with_invalid_payload.get("message", "")),
                "invalid key priority message over duplicate",
                str(dup_with_invalid_payload.get("message", "")),
            )

        # 从统计数据中取一个有图的 device+brightness 组合，构造混合大小写参数进行测试。
        strict_mixed_case_group = next(
            (
                (str(row["device"]), str(row["brightness"]))
                for row in normalized_theme_details
                if int(row["count"]) > 0
            ),
            None,
        )
        if strict_mixed_case_group is None:
            self.assert_true(False, "mixed-case strict group available")
            return 1

        mixed_case_device_raw, mixed_case_brightness_raw = strict_mixed_case_group
        mixed_case_device = "PC" if mixed_case_device_raw == "pc" else "Mb"
        mixed_case_brightness = (
            "LiGhT" if mixed_case_brightness_raw == "light" else "DaRk"
        )

        # 4) 大小写兼容（始终覆盖 proxy 与 redirect）。
        mixed_case_proxy = self.request(
            "/random-img",
            query={"d": mixed_case_device, "b": mixed_case_brightness, "m": "PrOxY"},
            follow_redirects=True,
        )
        self.assert_true(
            mixed_case_proxy.status == 200,
            "mixed-case device/brightness proxy status",
            f"status={mixed_case_proxy.status}",
        )

        mixed_case_method_redirect = self.request(
            "/random-img",
            query={"m": "ReDiReCt"},
            follow_redirects=False,
        )
        if REDIRECT_ENABLED:
            self.assert_true(
                mixed_case_method_redirect.status == 302,
                "mixed-case method redirect status",
                f"status={mixed_case_method_redirect.status}",
            )
        else:
            self.assert_true(
                mixed_case_method_redirect.status == 200,
                "mixed-case method redirect fallback-to-proxy status",
                f"status={mixed_case_method_redirect.status}",
            )

        mixed_case_device_brightness_redirect = self.request(
            "/random-img",
            query={"d": mixed_case_device, "b": mixed_case_brightness, "m": "ReDiReCt"},
            follow_redirects=False,
        )
        if REDIRECT_ENABLED:
            self.assert_true(
                mixed_case_device_brightness_redirect.status == 302,
                "mixed-case device/brightness redirect status",
                f"status={mixed_case_device_brightness_redirect.status}",
            )
        else:
            self.assert_true(
                mixed_case_device_brightness_redirect.status == 200,
                "mixed-case device/brightness redirect fallback-to-proxy status",
                f"status={mixed_case_device_brightness_redirect.status}",
            )

        # 5) 默认请求：不传 m 参数时应按 DEFAULT_METHOD 行为响应。
        default_img = self.request("/random-img", follow_redirects=False)
        if DEFAULT_METHOD == "redirect" and REDIRECT_ENABLED:
            self.assert_true(
                default_img.status == 302,
                "GET /random-img default status (redirect)",
                f"status={default_img.status}",
            )
            default_location = default_img.headers.get("location", "")
            self.assert_true(
                bool(default_location),
                "GET /random-img default location present",
            )
            self.assert_redirect_asset_base(
                default_location, "GET /random-img default asset base match"
            )
        else:
            self.assert_true(
                default_img.status == 200,
                "GET /random-img default status",
                f"status={default_img.status}",
            )
            self.assert_true(
                "application/json" not in default_img.headers.get("content-type", ""),
                "GET /random-img default content-type not json",
                default_img.headers.get("content-type", ""),
            )
            self.assert_true(
                len(default_img.body) > 0, "GET /random-img default body non-empty"
            )
            if IMAGE_INFO_HEADER_ENABLED:
                info_val = default_img.headers.get(IMAGE_INFO_HEADER_NAME.lower(), "")
                self.assert_true(
                    bool(IMAGE_INFO_HEADER_PATTERN.match(info_val)),
                    f"GET /random-img default {IMAGE_INFO_HEADER_NAME} format",
                    f"value={info_val}",
                )

        # 6) 基于统计数据做组合覆盖：遍历每个设备×亮度分组，有图则测 proxy+redirect，无图则断言 404。
        nonzero_details = [
            row for row in normalized_theme_details if int(row["count"]) > 0
        ]
        zero_details = [
            row for row in normalized_theme_details if int(row["count"]) == 0
        ]

        self.assert_true(
            len(nonzero_details) > 0, "there is at least one nonzero combination"
        )

        for device in sorted(SUPPORTED_DEVICES):
            for brightness in sorted(SUPPORTED_BRIGHTNESS):
                group_key = f"{device}-{brightness}"
                group_count = int(group_totals.get(group_key, 0))
                if group_count > 0:
                    group_proxy = self.request(
                        "/random-img",
                        query={"d": device, "b": brightness, "m": "proxy"},
                        follow_redirects=True,
                    )
                    self.assert_true(
                        group_proxy.status == 200,
                        f"group {group_key} proxy status",
                        f"status={group_proxy.status}",
                    )

                    group_redirect = self.request(
                        "/random-img",
                        query={"d": device, "b": brightness, "m": "redirect"},
                        follow_redirects=False,
                    )
                    if REDIRECT_ENABLED:
                        self.assert_true(
                            group_redirect.status == 302,
                            f"group {group_key} redirect status",
                            f"status={group_redirect.status}",
                        )
                    else:
                        self.assert_true(
                            group_redirect.status == 200,
                            f"group {group_key} redirect fallback-to-proxy status",
                            f"status={group_redirect.status}",
                        )
                else:
                    self.expect_json_error(
                        "/random-img",
                        {"d": device, "b": brightness},
                        404,
                        "No available images for the selected filters",
                        f"group {group_key} has no images",
                    )

        # 7) 有效参数组合（严格断言成功状态）：动态构建各种合法 query 并验证返回 200 或 302。
        pc_has_images = (
            int(group_totals.get("pc-dark", 0)) + int(group_totals.get("pc-light", 0))
            > 0
        )
        mb_has_images = (
            int(group_totals.get("mb-dark", 0)) + int(group_totals.get("mb-light", 0))
            > 0
        )
        dark_has_images = (
            int(group_totals.get("pc-dark", 0)) + int(group_totals.get("mb-dark", 0))
            > 0
        )
        light_has_images = (
            int(group_totals.get("pc-light", 0)) + int(group_totals.get("mb-light", 0))
            > 0
        )

        valid_queries = [{"m": "proxy"}, {"d": "r"}]
        if pc_has_images:
            valid_queries.append({"d": "pc"})
        if mb_has_images:
            valid_queries.append({"d": "mb"})
        if dark_has_images:
            valid_queries.append({"b": "dark"})
        if light_has_images:
            valid_queries.append({"b": "light"})
        if int(group_totals.get("pc-dark", 0)) > 0:
            valid_queries.append({"d": "pc", "b": "dark"})
        if int(group_totals.get("mb-light", 0)) > 0:
            valid_queries.append({"d": "mb", "b": "light"})
        strict_random_brightness = "dark" if dark_has_images else "light"
        valid_queries.append({"d": "r", "b": strict_random_brightness})

        for idx, query in enumerate(valid_queries, start=1):
            result = self.request("/random-img", query=query, follow_redirects=True)
            self.assert_true(
                result.status == 200,
                f"valid query #{idx} status",
                f"query={query}, status={result.status}",
            )

        if REDIRECT_ENABLED:
            valid_redirect_queries = [{"m": "redirect"}]
            if pc_has_images:
                valid_redirect_queries.append({"d": "pc", "m": "redirect"})
            if mb_has_images:
                valid_redirect_queries.append({"d": "mb", "m": "redirect"})
            valid_redirect_queries.append(
                {"d": "r", "b": strict_random_brightness, "m": "redirect"}
            )
            for idx, query in enumerate(valid_redirect_queries, start=1):
                result = self.request(
                    "/random-img", query=query, follow_redirects=False
                )
                self.assert_true(
                    result.status == 302,
                    f"valid redirect query #{idx} status",
                    f"query={query}, status={result.status}",
                )
        else:
            redirect_as_proxy_queries = [{"m": "redirect"}]
            if pc_has_images:
                redirect_as_proxy_queries.append({"d": "pc", "m": "redirect"})
            if mb_has_images:
                redirect_as_proxy_queries.append({"d": "mb", "m": "redirect"})
            redirect_as_proxy_queries.append(
                {"d": "r", "b": strict_random_brightness, "m": "redirect"}
            )
            for idx, query in enumerate(redirect_as_proxy_queries, start=1):
                result = self.request(
                    "/random-img", query=query, follow_redirects=False
                )
                self.assert_true(
                    result.status == 200,
                    f"redirect-disabled query #{idx} fallback status",
                    f"query={query}, status={result.status}",
                )

        # 8) 多主题参数覆盖（使用统计结果中同组多个可用主题）：测试 CSV 与重复 t 参数两种形式。
        themes_by_group: dict[tuple[str, str], list[str]] = {}
        for row in nonzero_details:
            device = str(row["device"])
            brightness = str(row["brightness"])
            theme = str(row["theme"])
            themes_by_group.setdefault((device, brightness), []).append(theme)

        multi_theme_group = next(
            (
                (d, b, sorted(set(themes)))
                for (d, b), themes in themes_by_group.items()
                if len(set(themes)) >= 2
            ),
            None,
        )

        if multi_theme_group:
            device, brightness, themes = multi_theme_group
            first_theme, second_theme = themes[0], themes[1]

            multi_csv_proxy = self.request(
                "/random-img",
                query={
                    "d": device,
                    "b": brightness,
                    "t": f"{first_theme},{second_theme}",
                    "m": "proxy",
                },
                follow_redirects=True,
            )
            self.assert_true(
                multi_csv_proxy.status == 200,
                "multi-theme csv proxy status",
                f"status={multi_csv_proxy.status}",
            )

            multi_csv_redirect = self.request(
                "/random-img",
                query={
                    "d": device,
                    "b": brightness,
                    "t": f"{first_theme},{second_theme}",
                    "m": "redirect",
                },
                follow_redirects=False,
            )
            if REDIRECT_ENABLED:
                self.assert_true(
                    multi_csv_redirect.status == 302,
                    "multi-theme csv redirect status",
                    f"status={multi_csv_redirect.status}",
                )
            else:
                self.assert_true(
                    multi_csv_redirect.status == 200,
                    "multi-theme csv redirect fallback-to-proxy status",
                    f"status={multi_csv_redirect.status}",
                )

            self.expect_json_error(
                "/random-img",
                {
                    "d": device,
                    "b": brightness,
                    "t": f"{first_theme},__nonexistent_theme__",
                },
                400,
                "Invalid theme",
                "multi-theme csv with invalid theme",
            )

            multi_repeat_proxy = self.request_query_items(
                "/random-img",
                query_items=[
                    ("d", device),
                    ("b", brightness),
                    ("t", first_theme),
                    ("t", second_theme),
                    ("m", "proxy"),
                ],
                follow_redirects=True,
            )
            self.assert_true(
                multi_repeat_proxy.status == 200,
                "multi-theme repeated-t proxy status",
                f"status={multi_repeat_proxy.status}",
            )

            multi_repeat_redirect = self.request_query_items(
                "/random-img",
                query_items=[
                    ("d", device),
                    ("b", brightness),
                    ("t", first_theme),
                    ("t", second_theme),
                    ("m", "redirect"),
                ],
                follow_redirects=False,
            )
            if REDIRECT_ENABLED:
                self.assert_true(
                    multi_repeat_redirect.status == 302,
                    "multi-theme repeated-t redirect status",
                    f"status={multi_repeat_redirect.status}",
                )
            else:
                self.assert_true(
                    multi_repeat_redirect.status == 200,
                    "multi-theme repeated-t redirect fallback-to-proxy status",
                    f"status={multi_repeat_redirect.status}",
                )

            multi_repeat_invalid = self.request_query_items(
                "/random-img",
                query_items=[
                    ("d", device),
                    ("b", brightness),
                    ("t", first_theme),
                    ("t", "__nonexistent_theme__"),
                    ("m", "proxy"),
                ],
                follow_redirects=True,
            )
            self.assert_true(
                multi_repeat_invalid.status == 400,
                "multi-theme repeated-t with invalid theme",
                f"status={multi_repeat_invalid.status}, expected=400",
            )
            repeat_invalid_payload = self._assert_error_json_payload(
                multi_repeat_invalid,
                400,
                "multi-theme repeated-t with invalid theme",
            )
            if isinstance(repeat_invalid_payload, dict):
                repeat_invalid_message = str(repeat_invalid_payload.get("message", ""))
                self.assert_true(
                    "Invalid theme" in repeat_invalid_message,
                    "multi-theme repeated-t invalid theme message",
                    f"message={repeat_invalid_message}",
                )
        else:
            print(
                "[SKIP] 不存在同 device+brightness 下至少 2 个可用主题，跳过多主题断言"
            )

        # 8.5) 主题排除（t=!theme）功能覆盖：测试混用冲突、无效主题、单/多主题排除、全部排除。
        all_themes = sorted(theme_details.keys())
        self.register_theme_tokens(all_themes)

        # 8.5.1) 包含与排除混用 → 400 THEME_INCLUDE_EXCLUDE_CONFLICT
        if len(all_themes) >= 2:
            mix_include = all_themes[0]
            mix_exclude = all_themes[1]
            self.expect_json_error(
                "/random-img",
                {"t": f"{mix_include},!{mix_exclude}"},
                400,
                "Cannot mix include and exclude",
                "theme include-exclude conflict (csv)",
                expected_detail_keys=["include", "exclude", "hint"],
            )

            # 重复参数形式混用
            conflict_repeat = self.request_query_items(
                "/random-img",
                query_items=[
                    ("t", mix_include),
                    ("t", f"!{mix_exclude}"),
                ],
                follow_redirects=True,
            )
            self.assert_true(
                conflict_repeat.status == 400,
                "theme include-exclude conflict (repeated-t)",
                f"status={conflict_repeat.status}, expected=400",
            )
        else:
            print("[SKIP] 不足 2 个主题，跳过主题包含排除混用断言")

        # 8.5.2) 排除不存在的主题 → 400 INVALID_THEME
        self.expect_json_error(
            "/random-img",
            {"t": "!__nonexistent_theme__"},
            400,
            "Invalid theme",
            "exclude invalid theme",
            expected_field="t",
            forbidden_detail_keys=["allowed"],
        )

        # 8.5.3) 排除单个主题，其他主题有图 → 200
        if multi_theme_group:
            device, brightness, themes = multi_theme_group
            exclude_one = themes[0]

            exclude_proxy = self.request(
                "/random-img",
                query={"d": device, "b": brightness, "t": f"!{exclude_one}", "m": "proxy"},
                follow_redirects=True,
            )
            self.assert_true(
                exclude_proxy.status == 200,
                "theme exclude single proxy status",
                f"status={exclude_proxy.status}",
            )

            exclude_redirect = self.request(
                "/random-img",
                query={"d": device, "b": brightness, "t": f"!{exclude_one}", "m": "redirect"},
                follow_redirects=False,
            )
            if REDIRECT_ENABLED:
                self.assert_true(
                    exclude_redirect.status == 302,
                    "theme exclude single redirect status",
                    f"status={exclude_redirect.status}",
                )
            else:
                self.assert_true(
                    exclude_redirect.status == 200,
                    "theme exclude single redirect fallback-to-proxy status",
                    f"status={exclude_redirect.status}",
                )

            # 8.5.4) csv 排除多个主题
            if len(themes) >= 3:
                exclude_csv = f"!{themes[0]},!{themes[1]}"
                exclude_csv_result = self.request(
                    "/random-img",
                    query={"d": device, "b": brightness, "t": exclude_csv, "m": "proxy"},
                    follow_redirects=True,
                )
                self.assert_true(
                    exclude_csv_result.status == 200,
                    "theme exclude csv proxy status",
                    f"status={exclude_csv_result.status}",
                )
            else:
                print("[SKIP] 不足 3 个可用主题，跳过 csv 多主题排除断言")

            # 8.5.5) 重复参数排除多个主题
            if len(themes) >= 3:
                exclude_repeat_result = self.request_query_items(
                    "/random-img",
                    query_items=[
                        ("d", device),
                        ("b", brightness),
                        ("t", f"!{themes[0]}"),
                        ("t", f"!{themes[1]}"),
                        ("m", "proxy"),
                    ],
                    follow_redirects=True,
                )
                self.assert_true(
                    exclude_repeat_result.status == 200,
                    "theme exclude repeated-t proxy status",
                    f"status={exclude_repeat_result.status}",
                )
            else:
                print("[SKIP] 不足 3 个可用主题，跳过重复参数多主题排除断言")

            # 8.5.6) 排除全部主题 → 404 NO_IMAGES_FOR_COMBINATION
            all_exclude_csv = ",".join(f"!{t}" for t in themes)
            self.expect_json_error(
                "/random-img",
                {"d": device, "b": brightness, "t": all_exclude_csv},
                404,
                "No available images for the selected filters",
                "theme exclude all → no images",
            )
        else:
            print("[SKIP] 不存在多主题组合，跳过主题排除功能断言")

        # 9) 每个有图组合至少测一次：遍历所有 count>0 的 device+brightness+theme，分别验证 proxy 和 redirect。
        for row in nonzero_details:
            device = str(row["device"])
            brightness = str(row["brightness"])
            theme = str(row["theme"])
            label_prefix = f"combo {device}-{brightness}-{theme}"

            proxy_result = self.request(
                "/random-img",
                query={"d": device, "b": brightness, "t": theme, "m": "proxy"},
                follow_redirects=True,
            )
            self.assert_true(
                proxy_result.status == 200,
                f"{label_prefix} proxy status",
                f"status={proxy_result.status}",
            )

            redirect_result = self.request(
                "/random-img",
                query={
                    "d": device,
                    "b": brightness,
                    "t": theme,
                    "m": "redirect",
                },
                follow_redirects=False,
            )
            if REDIRECT_ENABLED:
                self.assert_true(
                    redirect_result.status == 302,
                    f"{label_prefix} redirect status",
                    f"status={redirect_result.status}",
                )
            else:
                self.assert_true(
                    redirect_result.status == 200,
                    f"{label_prefix} redirect fallback-to-proxy status",
                    f"status={redirect_result.status}",
                )

        # count=0 的组合应返回 404。
        if zero_details:
            row = zero_details[0]
            device = str(row["device"])
            brightness = str(row["brightness"])
            theme = str(row["theme"])
            self.expect_json_error(
                "/random-img",
                {"d": device, "b": brightness, "t": theme},
                404,
                "No available images for the selected filters",
                f"no images for combination {device}-{brightness}-{theme}",
            )

        # 10) 方法模式行为：测试 proxy 返回 200，redirect 按开关断言 302 或回退 200，并校验 Location 格式。
        proxy_any = self.request(
            "/random-img", query={"m": "proxy"}, follow_redirects=True
        )
        self.assert_true(
            proxy_any.status == 200,
            "GET /random-img?m=proxy status",
            f"status={proxy_any.status}",
        )
        if IMAGE_INFO_HEADER_ENABLED:
            info_val = proxy_any.headers.get(IMAGE_INFO_HEADER_NAME.lower(), "")
            self.assert_true(
                bool(IMAGE_INFO_HEADER_PATTERN.match(info_val)),
                f"GET /random-img?m=proxy {IMAGE_INFO_HEADER_NAME} format",
                f"value={info_val}",
            )
        else:
            self.assert_true(
                IMAGE_INFO_HEADER_NAME.lower() not in proxy_any.headers,
                f"GET /random-img?m=proxy {IMAGE_INFO_HEADER_NAME} absent",
            )

        if REDIRECT_ENABLED:
            redirect_any = self.expect_empty_status(
                "/random-img",
                query={"m": "redirect"},
                expected_status=302,
                label="GET /random-img?m=redirect status",
                follow_redirects=False,
            )
            location = redirect_any.headers.get("location", "")
            self.assert_true(
                bool(location), "GET /random-img?m=redirect location present"
            )
            self.assert_redirect_asset_base(
                location, "GET /random-img?m=redirect asset base match"
            )
            self.assert_true(
                bool(re.search(REDIRECT_LOCATION_PATTERN, location)),
                "GET /random-img?m=redirect location format",
                location,
            )
        else:
            redirect_any = self.request(
                "/random-img", query={"m": "redirect"}, follow_redirects=False
            )
            self.assert_true(
                redirect_any.status == 200,
                "GET /random-img?m=redirect fallback proxy status",
                f"status={redirect_any.status}",
            )

        # 带筛选条件的 redirect 请求也应正常返回。
        redirect_with_filters = self.request(
            "/random-img",
            query={"d": "r", "b": strict_random_brightness, "m": "redirect"},
            follow_redirects=False,
        )
        if REDIRECT_ENABLED:
            self.assert_true(
                redirect_with_filters.status == 302,
                "GET /random-img?d=r&b=<available>&m=redirect status",
                f"status={redirect_with_filters.status}",
            )
        else:
            self.assert_true(
                redirect_with_filters.status == 200,
                "GET /random-img?d=r&b=<available>&m=redirect fallback status",
                f"status={redirect_with_filters.status}",
            )

        # 11) 稳定性抽样：多次随机请求验证返回状态一致性，确保不会偶发失败。
        for i in range(self.random_runs):
            proxy_sample = self.request(
                "/random-img", query={"m": "proxy"}, follow_redirects=True
            )
            self.assert_true(
                proxy_sample.status == 200,
                f"random stability proxy #{i + 1}",
                f"status={proxy_sample.status}",
            )

        for i in range(self.random_runs):
            redirect_sample = self.request(
                "/random-img", query={"m": "redirect"}, follow_redirects=False
            )
            if REDIRECT_ENABLED:
                self.assert_true(
                    redirect_sample.status == 302,
                    f"random stability redirect #{i + 1}",
                    f"status={redirect_sample.status}",
                )
            else:
                self.assert_true(
                    redirect_sample.status == 200,
                    f"random stability redirect-fallback #{i + 1}",
                    f"status={redirect_sample.status}",
                )

        # 最终覆盖率检查：确保必须覆盖的错误类型均已触发。
        missing_hard = sorted(
            k
            for k in REQUIRED_ERROR_COVERAGE_KEYS
            if not self.error_coverage.get(k, False)
        )
        missing_optional = sorted(
            k
            for k in OPTIONAL_ERROR_COVERAGE_KEYS
            if not self.error_coverage.get(k, False)
        )

        self.assert_true(
            len(missing_hard) == 0,
            "hard error coverage complete",
            f"missing={missing_hard}",
        )
        if missing_optional:
            print(
                f"[INFO] optional error coverage missing (data-dependent): {', '.join(missing_optional)}"
            )

        elapsed = time.time() - started
        print("\n========== 测试结果 ==========")
        print(f"Passed: {self.passed}")
        print(f"Failed: {self.failed}")
        print(f"Elapsed: {elapsed:.2f}s")

        if self.failures:
            print("\n失败详情：")
            for item in self.failures:
                print(item)
            return 1

        print("全部通过 ✅")
        return 0


# 入口：初始化 ApiTester 并执行全部测试，以退出码反映测试结果。
def main() -> None:
    tester = ApiTester(
        api_base_url=API_BASE_URL,
        asset_base_url=ASSET_BASE_URL,
        timeout=TIMEOUT_SECONDS,
        random_runs=RANDOM_RUNS,
    )
    code = tester.run()
    raise SystemExit(code)


if __name__ == "__main__":
    main()
