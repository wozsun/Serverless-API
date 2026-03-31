#!/usr/bin/env python3
"""
主路由端到端集成测试。

测试流程：
    1) / — 根路径应返回 404 及对应错误消息
    2) /hello — 应返回 200 及 Hello 消息
    3) /healthcheck — 应返回 200 及健康确认消息
"""
from __future__ import annotations

import json
import os
import socket
import ssl
import time
import http.client
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any


# ===========================
# 配置区
# ===========================

# 统一配置环境变量名（JSON 字符串）。
CONFIG_ENV_NAME = "CONFIG"
# 单次 HTTP 请求超时时间（秒）。
TIMEOUT_SECONDS = 30
# 瞬时网络/读取失败时的最大重试次数（不含首次请求）。
MAX_NETWORK_RETRIES = 5
# 线性退避基数（sleep = base * attempt）。
RETRY_BACKOFF_BASE_SECONDS = 1


# ===========================
# 工具函数
# ===========================


# 期望路由的结构化描述：路径、HTTP 状态码、payload 内 status 字段和 message。
@dataclass
class ExpectedRoute:
    path: str
    expected_status: int
    expected_payload_status: int | None
    expected_message: str


# 打印失败信息并立即终止测试。
def fail(message: str) -> None:
    print(f"[FAIL] {message}")
    raise SystemExit(1)


# 打印通过信息。
def pass_log(message: str) -> None:
    print(f"[PASS] {message}")


# 读取必需的环境变量，缺失时终止。
def required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        fail(f"Missing required environment variable: {name}")
    return value


# 从 CONFIG JSON 中提取 API_BASE_URL。
def load_api_base_url_from_config() -> str:
    raw_config = required_env(CONFIG_ENV_NAME)
    try:
        parsed = json.loads(raw_config)
    except json.JSONDecodeError as exc:
        fail(f"Invalid CONFIG JSON: {exc}")

    if not isinstance(parsed, dict):
        fail("Invalid CONFIG JSON: root must be an object")

    base_url = parsed.get("API_BASE_URL")
    if not isinstance(base_url, str) or not base_url.strip():
        fail("Missing or invalid CONFIG.API_BASE_URL")

    return base_url.rstrip("/")


# ===========================
# 请求与断言
# ===========================


# 发送 GET 请求并解析 JSON 响应，网络异常时按次数重试。
def request_json(base_url: str, path: str) -> tuple[int, Any]:
    url = f"{base_url}{path}"
    req = urllib.request.Request(url, method="GET")

    network_retries = 0
    while True:
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
                status = resp.getcode()
                headers = {k.lower(): v for k, v in resp.headers.items()}
                body = resp.read().decode("utf-8", errors="replace")
                break
        except urllib.error.HTTPError as exc:
            status = exc.code
            headers = {k.lower(): v for k, v in exc.headers.items()}
            body = exc.read().decode("utf-8", errors="replace")
            break
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
                fail(
                    f"{path} request failed after retries: {exc} "
                    f"(retries={network_retries})"
                )
            network_retries += 1
            time.sleep(RETRY_BACKOFF_BASE_SECONDS * network_retries)

    content_type = headers.get("content-type", "")
    if "application/json" not in content_type:
        fail(f"{path} content-type is not JSON: {content_type}")

    try:
        payload = json.loads(body)
    except json.JSONDecodeError as exc:
        fail(f"{path} response is not valid JSON: {exc}; body={body[:200]}")

    return status, payload


# 对单条路由执行完整断言：HTTP 状态码、payload.status、payload.message。
def assert_route(base_url: str, route: ExpectedRoute) -> None:
    status, payload = request_json(base_url, route.path)

    if status != route.expected_status:
        fail(f"{route.path} status={status}, expected={route.expected_status}")
    pass_log(f"{route.path} status")

    if not isinstance(payload, dict):
        fail(f"{route.path} payload must be JSON object: {payload}")

    if route.expected_payload_status is not None:
        payload_status = payload.get("status")
        if payload_status != route.expected_payload_status:
            fail(
                f"{route.path} payload.status={payload_status}, "
                f"expected={route.expected_payload_status}"
            )
        pass_log(f"{route.path} payload.status")

    message = payload.get("message")
    if message != route.expected_message:
        fail(f"{route.path} payload.message={message!r}, expected={route.expected_message!r}")
    pass_log(f"{route.path} payload.message")


# ===========================
# 入口
# ===========================


# 初始化配置并依次断言所有主路由。
def main() -> None:
    base_url = load_api_base_url_from_config()
    print("Testing main routes with CONFIG.API_BASE_URL")

    routes = [
        ExpectedRoute(path="/", expected_status=404, expected_payload_status=404, expected_message="No API route specified"),
        ExpectedRoute(path="/hello", expected_status=200, expected_payload_status=None, expected_message="Hello, World!"),
        ExpectedRoute(
            path="/healthcheck",
            expected_status=200,
            expected_payload_status=None,
            expected_message="API on EdgeFunction is healthy",
        ),
    ]

    for route in routes:
        assert_route(base_url, route)

    print("All main route checks passed.")


if __name__ == "__main__":
    main()
