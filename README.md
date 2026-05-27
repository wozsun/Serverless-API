# Serverless-API

基于边缘函数的 Serverless API 项目，默认面向阿里云 ESA，同时兼容 Cloudflare Workers 与腾讯云 EdgeOne。

## 特性

- 边缘函数运行，低延迟、免运维
- 统一路由框架：普通路由按命名约定自动解析，隐藏路由路径由 KV 动态控制
- 使用 KV 管理运行时配置，无需每次改配置都重新部署
- 支持 ESA EdgeKV、Cloudflare Workers KV、腾讯云 EdgeOne KV
- 模块化业务函数组织，新增 API 只需添加文件并注册路由

## 快速开始

1. Clone 本项目
2. 在 KV 中配置必需键（见 [KV 配置](#kv-配置)）
3. 按目标平台部署（见[部署指南](#部署指南)）
4. 访问 `GET /healthcheck` 验证服务正常，访问 `GET /random-img` 验证图片 API

## 目录结构

```text
app/                 通用入口与路由分发
commons/             KV、响应、Referer、平台适配等公共能力
edge-functions/      EdgeOne 平台路由适配入口
functions/           业务函数与业务配置
tests/               端到端测试脚本
```

## 路由

### 普通路由

| 路由 | 说明 |
| --- | --- |
| `/` | 返回 404 与 `No API route specified` |
| `/hello` | 示例路由 |
| `/healthcheck` | 健康检查 |
| `/random-img` | 随机图片 API |

普通路由注册在 `app/index.js` 的 `ROUTES` 对象中。若值为函数则直接用作 handler；若值为模块对象，则按命名约定自动匹配：路径 `/random-img` 对应导出 `handleRandomImg`。

普通与隐藏路由匹配前都会标准化路径：多个前导 `/` 会压成一个，尾部 `/` 会被忽略。

普通路由默认不接受实际 query 参数，目前仅 `/random-img` 允许；允许列表由 `app/index.js` 顶部的 `QUERY_ALLOWED_ROUTES` 控制。空 query 标记（如 `?`）按无参数处理。

### 隐藏路由

隐藏路由的路径不在代码中硬编码，而是从 KV 动态读取。当前注册了一个隐藏路由：

| KV Key | 对应 Handler | 说明 |
| --- | --- | --- |
| `RANDOM_IMG_COUNT_PATH` | `handleRandomImgCount` | 随机图片数量统计 API |

新增隐藏路由只需在 `HIDDEN_PATH_KEYS` 数组中追加 KV key，并在已注册的业务模块中导出对应的 `handleXxx` 函数。

隐藏路由不接受实际查询参数，携带 query 参数会返回 403。空 query 标记（如 `?`）按无参数处理。

## API 接口

### `GET /random-img`

随机图片主接口。

#### 查询参数

| 参数 | 含义 | 可选值 | 默认值 |
| --- | --- | --- | --- |
| `d` | 设备类型 | `pc` / `mb` / `r`（强制随机） | 按 User-Agent 自动推断 `pc`/`mb`，无法识别则随机 |
| `b` | 明暗类型 | `dark` / `light` | 随机 |
| `t` | 主题（支持多值） | 任意存在于 `FOLDER_MAP` 中的主题名，或以 `!` 开头排除 | 全部主题中随机 |
| `m` | 响应方式 | `proxy` / `redirect` | `proxy` |

查询参数白名单与单值约束在 `functions/random-img/config.js` 中定义：

```js
const ALLOWED_QUERY = ["d", "b", "t", "m"];
const SINGLE_VALUE_QUERY = ["d", "b", "m"];
```

其中 `t` 不在 `SINGLE_VALUE_QUERY` 中，因此允许多次传入。

`t` 参数支持以下语法：

- 逗号分隔：`?t=theme1,theme2`
- 重复参数：`?t=theme1&t=theme2`
- 排除语法：`?t=!theme1` 从全部主题中排除 `theme1`
- 排除多值：`?t=!theme1,!theme2` 或 `?t=!theme1&t=!theme2`

> ⚠️ 包含与排除不可混用，例如 `?t=theme1,!theme2` 会返回 400 错误。

#### 示例

```text
/random-img
/random-img?d=pc&b=dark
/random-img?t=theme1,theme2&m=redirect
/random-img?t=!theme1
/random-img?d=r&b=light&t=theme1
/random-img?d=mb&b=dark&t=!theme1&m=redirect
```

#### 响应方式

`m=proxy`（默认）：
- 边缘函数回源拉取图片并透传内容
- 响应头会附加 `X-Image-Info`，格式为 `{device}-{brightness}-{theme}-{index}; {耗时ms}`，例如 `pc-dark-nature-000012; 34`
- `X-Image-Info` 可通过 `functions/random-img/config.js` 中的 `IMAGE_INFO_HEADER_ENABLED` 开关

`m=redirect`：
- 返回 302，`Location` 指向目标图片 URL
- 可通过 `functions/random-img/config.js` 中的 `REDIRECT_ENABLED` 全局禁用，设为 `false` 后所有请求强制使用 proxy 模式

> ⚠️ 隐私提示：`redirect` 模式不会隐藏上游图片源地址，客户端可直接看到图片 CDN/存储源 URL。如需隐藏源地址请使用默认的 `proxy` 模式。

#### 错误响应格式

所有接口的错误响应均为 JSON，结构如下：

```json
{
  "status": 400,
  "message": "Bad Request: Invalid query parameters",
  "details": {
    "invalidQuery": ["x"],
    "allowedQuery": ["d", "b", "t", "m"]
  }
}
```

常见状态码：

| 状态码 | 场景 |
| --- | --- |
| 400 | 参数非法、重复、混用包含/排除主题等 |
| 403 | Referer 校验未通过（仅在启用时），或路由不接受实际 query 参数 |
| 404 | 无匹配图片或无匹配路由 |
| 405 | 使用了 GET 以外的方法 |
| 500 | KV 配置缺失或无效 |
| 502 | 上游图片服务请求失败 |

随机图片业务错误定义见 `functions/random-img/config.js` 中的 `ERRORS` 常量；路由层错误由 `app/index.js` 返回。

### `GET /random-img/count`（隐藏路由）

返回 FOLDER_MAP 中所有图片的汇总统计。路径由 KV 中的 `RANDOM_IMG_COUNT_PATH` 动态配置，这里以 `/random-img/count` 为例。

响应示例：

```json
{
  "totalImages": 66,
  "groupTotals": {
    "pc-dark": 25,
    "pc-light": 12,
    "mb-dark": 9,
    "mb-light": 20
  },
  "themeDetails": {
    "theme1": { "total": 16, "pc-dark": 1, "mb-light": 2 },
    "theme2": { "total": 20, "pc-dark": 3, "pc-light": 4, "mb-dark": 3, "mb-light": 10 }
  }
}
```

## KV 配置

### `random_img_config`

随机图片 API 使用的命名空间：

```text
random_img_config
```

#### 必需键

| Key | 类型 | 说明 |
| --- | --- | --- |
| `FOLDER_MAP` | JSON | 图片数量索引 |
| `BASE_IMAGE_URL` | Text | 图片基础 URL，要求单行合法 URL |

`FOLDER_MAP` 示例：

```json
{
  "pc": {
    "dark": { "theme1": 15, "theme2": 13 },
    "light": { "theme1": 12, "theme2": 9 }
  },
  "mb": {
    "dark": { "theme1": 2, "theme2": 6 },
    "light": { "theme1": 4, "theme2": 4 }
  }
}
```

读取规则：

- 仅读取顶层设备键 `pc`、`mb`
- 仅读取明暗键 `dark`、`light`
- 主题计数转为数字后，有限且 `> 0` 的参与随机，`0` 或无效值不进入候选池

#### 可选键

##### `ALLOWED_REFERER`

Referer 白名单（多行文本）。Referer 校验默认关闭，由 `functions/random-img/config.js` 中的 `REFERER_CHECK_ENABLED` 控制。

若启用，需在此键中配置白名单，支持精确 origin 与通配子域名：

```text
https://example.com
https://*.example.com
```

### `hidden_routes`

隐藏路由使用的命名空间：

```text
hidden_routes
```

#### 必需键

| Key | 类型 | 说明 |
| --- | --- | --- |
| `RANDOM_IMG_COUNT_PATH` | Text | 随机图片统计接口路径，例如 `/img-count` |

如需新增隐藏路由，在 `app/index.js` 的 `HIDDEN_PATH_KEYS` 数组中追加 KV key，并在对应业务模块中导出 `handleXxx` 函数。

### 图片存储路径

图片路径由 `BASE_IMAGE_URL`（KV）+ `IMAGE_PATH_PATTERN`（config.js）+ 文件扩展名组成。

默认 `IMAGE_PATH_PATTERN`：

```text
{device}-{brightness}/{theme}/{index}
```

因此默认图片存储结构为：

```text
{device}-{brightness}/{theme}/{index}.webp
```

示例：

```text
pc-dark/theme1/000001.webp
mb-light/theme2/000002.webp
```

`IMAGE_PATH_PATTERN` 支持 `{device}`、`{brightness}`、`{theme}`、`{index}` 四个占位符，可在 `functions/random-img/config.js` 中自由组合：

```text
{device}/{brightness}-{theme}/{index}
{theme}/{device}-{brightness}-{index}
```

## 部署指南

### 阿里云 ESA

使用 [esa.jsonc](./esa.jsonc)：

```jsonc
{
  "name": "api",
  "entry": "./app/index.js",
  "installCommand": null,
  "buildCommand": null
}
```

不需要设置 `KV_PROVIDER`，默认按 ESA EdgeKV 读取。

### Cloudflare Workers

使用 [wrangler.jsonc](./wrangler.jsonc)：

```jsonc
{
  "main": "app/index.js",
  "vars": {
    "KV_PROVIDER": "CF"
  },
  "kv_namespaces": [
    {
      "binding": "hidden_routes",
      "id": "your_hidden_routes_namespace_id"
    },
    {
      "binding": "random_img_config",
      "id": "your_random_img_config_namespace_id"
    }
  ]
}
```

KV binding 名需与代码中的命名空间名一致。

部署命令：

```bash
npx wrangler deploy
```

### 腾讯云 EdgeOne

EdgeOne 识别 `edge-functions` 目录下的文件为函数路由。本项目使用两个极薄的适配入口：

```text
edge-functions/index.js
edge-functions/[[default]].js
```

两者均委托给 `commons/edgeone-entry.js`，后者自动注入 `KV_PROVIDER=EO` 后转交 `app/index.js` 处理。新增普通路由通常无需新增 EdgeOne 入口文件。

EdgeOne KV 命名空间的绑定变量名需与代码一致：

```text
random_img_config
hidden_routes
```

## 多平台 KV 适配

KV 读取统一通过 `commons/kv.js` 的 getter 完成，底层 client 由 `commons/kv-providers.js` 根据 `KV_PROVIDER` 分发。

| 平台 | `KV_PROVIDER` | KV client 来源 |
| --- | --- | --- |
| ESA | 默认或 `ESA` | `new EdgeKV({ namespace })` |
| Cloudflare Workers | `CF` | `env[namespace]` |
| EdgeOne | `EO` | 优先 `env[namespace]`，其次 `globalThis[namespace]` |

可用的 KV getter：

| Getter | 用途 |
| --- | --- |
| `getKvJsonObjectCached` | 读取 JSON 对象，如 `FOLDER_MAP` |
| `getKvUrlCached` | 读取单行 URL，如 `BASE_IMAGE_URL` |
| `getKvTextCached` | 读取单行文本，如隐藏路由路径 |
| `getKvTextLinesCached` | 读取多行文本，如 Referer 白名单 |
| `getKvBooleanCached` | 读取严格布尔值 |
| `getKvNumberCached` | 读取有限数字 |

所有 getter 均带内存缓存、负缓存和 KV 读取重试。

## 开发与测试

语法检查：

```bash
node --check app/index.js
node --check commons/kv.js
node --check commons/kv-providers.js
node --check commons/referer.js
node --check commons/response.js
node --check commons/edgeone-entry.js
node --check functions/random-img/random-img.js
node --check functions/random-img/config.js
node --check edge-functions/index.js
node --check edge-functions/[[default]].js
python -m py_compile tests/main-test.py
python -m py_compile tests/random-img-test.py
```

端到端测试依赖 `CONFIG` 环境变量：

```powershell
$env:CONFIG='{"API_BASE_URL":"https://api.example.com","ASSET_BASE_URL":"https://assets.example.com/images/","RANDOM_IMG_COUNT_PATH":"/img-count"}'
python tests/main-test.py
python tests/random-img-test.py
```

若修改了 `functions/random-img/config.js` 中的 `IMAGE_INDEX_DIGITS`、`IMAGE_PATH_PATTERN` 或 `IMAGE_FILE_EXTENSION`，需同步修改 `tests/random-img-test.py` 顶部的同名常量。

### 关键配置参数

`functions/random-img/config.js` 中的可调参数：

| 参数 | 说明 |
| --- | --- |
| `FETCH_MAX_ATTEMPTS` | 上游请求最大重试次数 |
| `FETCH_TIMEOUT_MS` | 单次上游请求超时（毫秒） |
| `IMAGE_INDEX_DIGITS` | 图片索引补零位数 |
| `IMAGE_FILE_EXTENSION` | 图片文件扩展名 |
| `IMAGE_PATH_PATTERN` | 图片路径模板 |
| `REDIRECT_ENABLED` | 是否允许 redirect 模式 |
| `REFERER_CHECK_ENABLED` | 是否启用 Referer 校验 |
| `IMAGE_INFO_HEADER_ENABLED` | 是否返回 X-Image-Info 响应头 |

## 开源协议

本项目使用 **GNU AGPLv3**，详见 [LICENSE](./LICENSE)。
