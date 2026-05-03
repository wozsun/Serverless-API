# Serverless-API

基于边缘函数的 Serverless API 项目，默认面向阿里云 ESA，同时已适配 Cloudflare Workers 与腾讯云 EdgeOne。

当前主要提供随机图片 API，并带有一个隐藏统计路由。

## 特性

- 边缘函数运行，低延迟、免运维
- 使用 KV 管理运行时配置，无需每次改配置都重新部署
- 支持 ESA EdgeKV、Cloudflare Workers KV、腾讯云 EdgeOne KV
- 支持 `proxy` 代理图片内容或 `redirect` 返回图片地址
- 支持按设备、亮度、主题筛选随机图片
- 支持隐藏路由，路由路径可由 KV 动态控制

## 路由

| 路由 | 说明 |
| --- | --- |
| `/` | 返回 404 与 `No API route specified` |
| `/hello` | 示例路由 |
| `/healthcheck` | 健康检查 |
| `/random-img` | 随机图片 API |
| KV 配置的隐藏路径 | 随机图片数量统计 API，对应 `RANDOM_IMG_COUNT_PATH` |

隐藏统计路由不接受查询参数；如果访问时携带 query，会返回 403。

## 随机图片 API

请求：

```text
GET /random-img
```

支持的查询参数：

| 参数 | 可选值 | 说明 |
| --- | --- | --- |
| `d` | `pc` / `mb` / `r` | 设备类型。`pc` 为桌面端，`mb` 为移动端，`r` 为随机设备。不传时按 `User-Agent` 自动推断，无法识别则随机 |
| `b` | `dark` / `light` | 亮度类型。不传时随机 |
| `t` | 主题名或 `!主题名` | 主题筛选。支持逗号分隔和重复参数，例如 `t=a,b` 或 `t=a&t=b`。以 `!` 开头表示排除主题，包含与排除不能混用 |
| `m` | `proxy` / `redirect` | 响应方式。默认 `proxy` |

示例：

```text
/random-img
/random-img?d=pc&b=dark
/random-img?t=nature,city&m=redirect
/random-img?t=!city
```

`proxy` 模式会请求上游图片并转发内容。当前开启 `X-Image-Info` 响应头，格式类似：

```text
pc-dark-nature-12; 34
```

`redirect` 模式返回 302，并把图片 URL 放在 `Location` 头中。

## KV 配置

### `random_img_config`

随机图片 API 使用 namespace：

```text
random_img_config
```

必需键：

| Key | 类型 | 说明 |
| --- | --- | --- |
| `FOLDER_MAP` | JSON | 图片数量索引 |
| `BASE_IMAGE_URL` | Text | 图片基础 URL，要求单行合法 URL |

`FOLDER_MAP` 示例：

```json
{
  "pc": {
    "dark": {
      "nature": 10,
      "city": 8
    },
    "light": {
      "nature": 6
    }
  },
  "mb": {
    "dark": {
      "nature": 12
    },
    "light": {
      "city": 5
    }
  }
}
```

图片最终路径格式：

```text
{BASE_IMAGE_URL}{device}-{brightness}/{theme}/{number}.webp
```

例如：

```text
https://assets.example.com/images/pc-dark/nature/000001.webp
```

### `hidden_routes`

隐藏统计路由使用 namespace：

```text
hidden_routes
```

必需键：

| Key | 类型 | 说明 |
| --- | --- | --- |
| `RANDOM_IMG_COUNT_PATH` | Text | 随机图片统计接口路径，例如 `/img-count` |

### Referer 白名单

Referer 校验当前在代码中默认关闭：

```js
const REFERER_CHECK_ENABLED = false;
```

如果开启，需要在 `random_img_config` 中配置：

```text
ALLOWED_REFERER
```

该值是多行文本，支持精确 origin 与通配子域名：

```text
https://example.com
https://*.example.com
```

## 多平台 KV 适配

KV 读取统一通过 `commons/kv.js` 的 getter 完成，底层 client 由 `commons/kv-providers.js` 根据 `KV_PROVIDER` 分发。

| 平台 | `KV_PROVIDER` | KV client 来源 |
| --- | --- | --- |
| ESA | 默认或 `ESA` | `new EdgeKV({ namespace })` |
| Cloudflare Workers | `CF` | `env[namespace]` |
| EdgeOne | `EO` | 优先 `env[namespace]`，其次 `globalThis[namespace]` |

现有 getter：

| Getter | 用途 |
| --- | --- |
| `getKvJsonObjectCached` | 读取 JSON 配置，例如 `FOLDER_MAP` |
| `getKvUrlCached` | 读取单行 URL，例如 `BASE_IMAGE_URL` |
| `getKvTextCached` | 读取单行文本，例如隐藏路由路径 |
| `getKvTextLinesCached` | 读取多行文本，例如 Referer 白名单 |
| `getKvBooleanCached` | 读取严格布尔值 |
| `getKvNumberCached` | 读取有限数字 |

所有 getter 都带内存缓存、负缓存和 KV 读取重试。

## 部署说明

### 阿里云 ESA

ESA 使用 [esa.jsonc](./esa.jsonc)：

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

Cloudflare 使用 [wrangler.jsonc](./wrangler.jsonc)：

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

KV binding 名需要与代码中的 namespace 名一致。

### 腾讯云 EdgeOne

EdgeOne 只把 `edge-functions` 下的文件识别成函数路由。本项目使用两个极薄的适配入口：

```text
edge-functions/index.js
edge-functions/[[default]].js
```

它们都会转发到：

```text
commons/edgeone-entry.js
```

适配器会自动注入：

```js
KV_PROVIDER: "EO"
```

然后继续调用统一的 `app.fetch()`。因此业务路由仍然只需要维护在 `app/index.js`，以后新增普通路由通常不需要新增 EdgeOne 入口文件。

EdgeOne KV namespace 的绑定变量名建议与代码 namespace 一致：

```text
random_img_config
hidden_routes
```

## 开发与测试

全仓语法检查可参考：

```powershell
node --check app/index.js
node --check commons/kv.js
node --check functions/random-img.js
python -m py_compile tests/main-test.py
python -m py_compile tests/random-img-test.py
```

端到端测试依赖 `CONFIG` 环境变量：

```powershell
$env:CONFIG='{"API_BASE_URL":"https://api.example.com","ASSET_BASE_URL":"https://assets.example.com/images/","RANDOM_IMG_COUNT_PATH":"/img-count"}'
python tests/main-test.py
python tests/random-img-test.py
```

## 目录结构

```text
app/                 通用入口与路由分发
commons/             KV、响应、Referer、平台适配等公共能力
edge-functions/      EdgeOne 平台路由适配入口
functions/           业务函数
tests/               端到端测试脚本
```

## 开源协议

本项目使用 **GNU AGPLv3**，详见 [LICENSE](./LICENSE)。
