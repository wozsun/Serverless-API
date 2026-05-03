// ESA
const edgeKVClients = new Map();
const getEsaKvClient = ({ namespace }) => {
	if (typeof EdgeKV !== "function") {
		return null;
	}
	if (!edgeKVClients.has(namespace)) {
		edgeKVClients.set(namespace, new EdgeKV({ namespace }));
	}
	return edgeKVClients.get(namespace);
};

// Cloudflare Workers
const getCfKvClient = ({ env, namespace }) => env?.[namespace] ?? null;

// Tencent Cloud EdgeOne
const getEoKvClient = ({ env, namespace }) => env?.[namespace] ?? globalThis?.[namespace] ?? null;

const KV_PROVIDER_CLIENT_RESOLVERS = {
	ESA: getEsaKvClient,
	CF: getCfKvClient,
	EO: getEoKvClient,
};

// 根据运行平台与 namespace 获取对应平台的 KV 客户端。
export const getKvClient = ({ env, namespace }) => {
	const provider = String(env?.KV_PROVIDER || "ESA").toUpperCase();
	const resolver = KV_PROVIDER_CLIENT_RESOLVERS[provider];
	if (!resolver) {
		return null;
	}
	return resolver({ env, namespace });
};
