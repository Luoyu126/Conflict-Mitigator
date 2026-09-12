# 服务端基础设施

后续放置凭证验证、HTTP 响应与安全错误转换、requestId 和幂等基础设施。
业务响应遵循 `{ data, requestId }` 或 `{ error, requestId }`，设置 `Cache-Control: no-store`；204 无响应体。
用户、Worker、LiveKit webhook 的认证机制分别按契约实现，不以请求中的 participantId 作为身份凭证。
每个实现文件导入 `server-only`。当前入口不提供已实现的鉴权能力。
