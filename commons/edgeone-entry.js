import app from "../app/index.js";

const withForcedEoProvider = (env = {}) => ({
	...env,
	KV_PROVIDER: "EO",
});

// EdgeOne 只负责把命中的平台路由转交给通用 app，由 app 继续处理业务路由。
export default async function onRequest(context) {
	const request = context?.request;
	const env = context?.env;

	if (!request) {
		return new Response("Bad Request: Missing request", { status: 400 });
	}

	return app.fetch(request, withForcedEoProvider(env));
}
