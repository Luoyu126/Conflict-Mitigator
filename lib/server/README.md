# 服务端基础设施

本目录实现凭证验证、HTTP 响应与安全错误转换、requestId、请求校验和幂等基础设施。
业务响应遵循 `{ data, requestId }` 或 `{ error, requestId }`，设置 `Cache-Control: no-store`；204 无响应体。
用户、Worker、LiveKit webhook 的认证机制分别按契约实现，不以请求中的 participantId 作为身份凭证。
每个实现文件导入 `server-only`。Supabase bearer token 必须通过 `auth.getUser(token)`
在线验证；Worker/inference/cron bearer 使用常量时间比较。未知异常只返回安全的
`INTERNAL_ERROR`，不向客户端泄露堆栈、SQL、模型 prompt 或环境变量。

`runIdempotent` 在数据库事务内锁定逻辑命令并保存完整响应。API-17 继续使用其独立的
`clientMessageId` 规则，不套用通用 Idempotency-Key。
