// 节点描述的校验与转换：WS 的 open 与 HTTP 的两条入口共用同一套规则，
// 免得几条入口对「什么算合法节点」各执一词。

import type { ApiNode } from './protocol';
import type { SSHConnectionConfig } from './types';
import { clampInt } from './util';

/** PTY 的逻辑尺寸区间。太小会让远端程序排版崩掉，太大是有人在拿内存试探。 */
export const COLS = { min: 10, max: 1000, fallback: 80 } as const;
export const ROWS = { min: 5, max: 1000, fallback: 24 } as const;

export function clampCols(value: unknown): number {
  return clampInt(value, COLS.min, COLS.max, COLS.fallback);
}

export function clampRows(value: unknown): number {
  return clampInt(value, ROWS.min, ROWS.max, ROWS.fallback);
}

const PRIVATE_KEY_MARKER = 'BEGIN OPENSSH PRIVATE KEY';

/** validateNode 校验一个来自前端的节点描述；不合法就抛带原因的错误。 */
export function validateNode(node: ApiNode | undefined): void {
  if (!node || typeof node !== 'object') throw new Error('缺少 node');
  if (typeof node.host !== 'string' || node.host.trim() === '') throw new Error('节点地址(host)为空');
  if (typeof node.port !== 'number' || !Number.isInteger(node.port) || node.port < 1 || node.port > 65535) {
    throw new Error(`端口 ${String(node.port)} 非法（应为 1-65535）`);
  }
  if (typeof node.username !== 'string' || node.username === '') throw new Error('登录用户名(username)为空');
  if (typeof node.auth_value !== 'string' || node.auth_value === '') {
    throw new Error('认证内容为空：请填写密码或粘贴私钥');
  }
  if (node.auth_type !== undefined && node.auth_type !== 'password' && node.auth_type !== 'key') {
    throw new Error(`不支持的认证方式 ${String(node.auth_type)}（仅 password / key）`);
  }
  if (node.auth_type === 'key' && !node.auth_value.includes(PRIVATE_KEY_MARKER)) {
    throw new Error(`仅支持未加密的 OpenSSH 格式私钥（以 -----${PRIVATE_KEY_MARKER}----- 开头）。`
      + '可先执行 ssh-keygen -p -m OPENSSH -f <私钥文件> 转换格式，并去掉口令。');
  }
}

/** buildNodeConfig 把校验过的节点转成协议栈要的连接配置。 */
export function buildNodeConfig(node: ApiNode, cols: unknown, rows: unknown): SSHConnectionConfig {
  const useKey = node.auth_type === 'key';
  return {
    host: node.host.trim(),
    port: node.port,
    username: node.username,
    authMethod: useKey ? 'publickey' : 'password',
    password: useKey ? undefined : node.auth_value,
    privateKey: useKey ? node.auth_value : undefined,
    cols: clampCols(cols),
    rows: clampRows(rows),
    term: 'xterm-256color',
  };
}

/** maskNode 脱敏后的节点副本：返回给前端的执行结果里不该带凭据。 */
export function maskNode(node: ApiNode): ApiNode {
  return { ...node, auth_value: '***' };
}
