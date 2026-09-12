import "client-only";

// 浏览器 HTTP 请求封装入口，随首个业务接口实现。
// 使用 Supabase access token；保留契约响应、状态码与 requestId。
// 重试沿用调用方的逻辑 ID，不自动生成新的幂等键或自动重试。
// 不读取服务端凭证，也不导入 services。
export {};
