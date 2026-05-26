// Tencent Cloud EdgeOne /* 专用入口

import { handleEdgeOneRequest } from "../commons/edgeone-entry.js";

export default function onRequest(context) {
	return handleEdgeOneRequest(context);
}
