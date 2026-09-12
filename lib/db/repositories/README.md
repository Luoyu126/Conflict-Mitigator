# 数据访问层

按业务封装 SQL 与数据库行映射，由 service 传入连接或事务上下文，支持多个 repository 共用一个事务。
不处理 HTTP 请求或调用外部模型；业务授权由 service 执行，查询仍须显式限定房间、轮次和私聊所有者。
每个实现文件导入 `server-only`。`../postgres.ts` 使用 `postgres` 驱动和 Supabase
pooler-compatible `prepare:false`，提供惰性连接与事务。`membership.ts` 实现认证主体到
房间成员/主持人的最小授权查询；后续业务 repository 继续显式限定 room/session/owner。

保留 `../migrations/001_initial_schema.sql`，后续增量使用新迁移。
身份绑定、mediation_members、版本、幂等记录等契约增量尚未落地，不得假定基础七表已覆盖完整 API。
