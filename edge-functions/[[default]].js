// Tencent Cloud EdgeOne catch-all路由

import { handleEdgeOneRequest } from "../commons/edgeone-entry.js";

export default function onRequest(context) {
    return handleEdgeOneRequest(context);
}
