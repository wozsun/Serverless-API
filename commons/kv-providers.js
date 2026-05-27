// Aliyun ESA
const edgeKVClients = new Map();
const FAILED_EDGE_KV_CLIENT = Symbol("FAILED_EDGE_KV_CLIENT");
const getEsaKvClient = ({ namespace }) => {
    if (edgeKVClients.has(namespace)) {
        const cachedClient = edgeKVClients.get(namespace);
        return cachedClient === FAILED_EDGE_KV_CLIENT ? null : cachedClient;
    }
    if (typeof EdgeKV !== "function") {
        edgeKVClients.set(namespace, FAILED_EDGE_KV_CLIENT);
        return null;
    }
    try {
        const client = new EdgeKV({ namespace });
        edgeKVClients.set(namespace, client);
        return client;
    } catch {
        edgeKVClients.set(namespace, FAILED_EDGE_KV_CLIENT);
        return null;
    }
};

// Cloudflare Workers
const getCfKvClient = ({ env, namespace }) => env?.[namespace] ?? null;

// Tencent Cloud EdgeOne
const getEoKvClient = ({ env, namespace }) => env?.[namespace] ?? globalThis?.[namespace] ?? null;

// Config
const KV_PROVIDER_CLIENT_RESOLVERS = {
    ESA: getEsaKvClient,
    CF: getCfKvClient,
    EO: getEoKvClient,
};

// 根据运行平台与 namespace 获取对应平台的 KV 客户端
export const getKvClient = ({ env, namespace }) => {
    const provider = String(env?.KV_PROVIDER || "ESA").trim().toUpperCase();
    const resolver = KV_PROVIDER_CLIENT_RESOLVERS[provider];
    if (!resolver) {
        return null;
    }
    return resolver({ env, namespace });
};
