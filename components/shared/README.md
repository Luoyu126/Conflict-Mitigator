# 共享业务组件

放置跨页面复用的状态提示、参与者展示等组件。
页面专属组件放在对应页面的 `_components/`。浏览器请求通过 `lib/api/client.ts`，不能导入 services。
