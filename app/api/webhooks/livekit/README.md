# LiveKit webhook

后续在 `route.ts` 实现 API-26：用官方 SDK 对原始请求体与 Authorization 签名验签，按事件 ID 去重，成功返回无响应体的 204。
该入口不使用浏览器 Supabase Bearer 认证，也不承载音视频数据。
具体接口尚未实现；API-27 属于独立推理服务。
