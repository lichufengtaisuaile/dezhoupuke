// 业务错误：携带给用户看的提示信息，Socket 路由与 REST 路由都会原样返回 message。
export class GameError extends Error {}

export function requireThat(condition, message) {
  if (!condition) throw new GameError(message);
}
