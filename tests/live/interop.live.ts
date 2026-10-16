// 拿真 SSH 服务器验证整套协议栈 —— 这是单测替代不了的那一层。
//
// 单测把编排逻辑钉住了，但 KEX 别名、报文分帧、密钥派生、认证签名这些**只能在真握手里出错**：
// 单测里 `vi.mock` 掉的那个连接对象，恰恰是最可能有问题的那部分。所以在真服务端上跑一遍。
//
// 默认跳过，因为它要出网、要有账号。用法：
//
//   LIVE_SSH_HOST=1.2.3.4 LIVE_SSH_PORT=22 LIVE_SSH_USER=me \
//   LIVE_SSH_KEY=/path/to/id_ed25519 npm run test:live
//
// 私钥只从文件读、只进内存，不落仓库。
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { describe, expect, it } from 'vitest';

import { describeConnectFailure, ExecHandler, SSHConnection, type ConnectionHooks, type ExecResult } from '../../src/session';
import type { SSHConnectionConfig } from '../../src/types';
import { adaptSocket } from './socket-adapter';

const HOST = process.env.LIVE_SSH_HOST ?? '';
const PORT = Number(process.env.LIVE_SSH_PORT ?? '22');
const USER = process.env.LIVE_SSH_USER ?? '';
const KEY_PATH = process.env.LIVE_SSH_KEY ?? '';
const READY = HOST !== '' && USER !== '' && KEY_PATH !== '';

interface Outcome {
  result: ExecResult;
  fingerprints: string[];
}

/** 走完整流程：TCP → 版本交换 → KEX → 认证 → 跑一条命令 → 收尾。 */
async function runCommand(command: string): Promise<Outcome> {
  const socket = netConnect({ host: HOST, port: PORT });
  await once(socket, 'connect');

  const config: SSHConnectionConfig = {
    host: HOST,
    port: PORT,
    username: USER,
    authMethod: 'publickey',
    privateKey: readFileSync(KEY_PATH, 'utf8'),
    cols: 80,
    rows: 24,
    term: 'xterm-256color',
  };

  const fingerprints: string[] = [];
  const hooks: ConnectionHooks = {
    ended: () => undefined,
    verifyHostKey: async (fingerprint) => {
      fingerprints.push(fingerprint);
      return { ok: true };
    },
  };

  // adaptSocket 给的对象结构上就是 SSHConnection 需要的那个 Socket（readable / writable / close）。
  const conn = new SSHConnection(adaptSocket(socket) as never, config, hooks);
  try {
    await conn.handshake();
    const result = await new Promise<ExecResult>((resolve) => {
      conn.openExec(new ExecHandler(conn, command, 4 << 20, resolve));
    });
    return { result, fingerprints };
  } finally {
    conn.close();
    socket.destroy();
  }
}

describe.skipIf(!READY)('真实服务器互通（需 LIVE_SSH_* 环境变量）', () => {
  it('握手 + 公钥认证 + 执行命令', async () => {
    const { result, fingerprints } = await runCommand('echo interop-ok; id -un');

    if (result.exitStatus !== 0) {
      throw new Error(`命令退出码 ${result.exitStatus}；stderr=${result.stderr}`);
    }
    expect(result.stdout).toContain('interop-ok');
    expect(result.stdout).toContain(USER);
    // 主机密钥走的是 TOFU 钩子，指纹必须拿到（空指纹说明握手没真走完）。
    expect(fingerprints).toHaveLength(1);
    expect(fingerprints[0]).toMatch(/^SHA256:/);
  });

  it('连续多条命令复用同一条连接', async () => {
    const socket = netConnect({ host: HOST, port: PORT });
    await once(socket, 'connect');
    const config: SSHConnectionConfig = {
      host: HOST,
      port: PORT,
      username: USER,
      authMethod: 'publickey',
      privateKey: readFileSync(KEY_PATH, 'utf8'),
      cols: 80,
      rows: 24,
      term: 'xterm-256color',
    };
    const hooks: ConnectionHooks = { ended: () => undefined, verifyHostKey: async () => ({ ok: true }) };
    const conn = new SSHConnection(adaptSocket(socket) as never, config, hooks);
    try {
      await conn.handshake();
      for (const expected of ['alpha', 'beta', 'gamma']) {
        const result = await new Promise<ExecResult>((resolve) => {
          conn.openExec(new ExecHandler(conn, `echo ${expected}`, 1 << 20, resolve));
        });
        expect(result.stdout.trim()).toBe(expected);
      }
    } finally {
      conn.close();
      socket.destroy();
    }
  }, 45_000);
});

// 不论有没有账号，这条都要跑：它钉住「失败文案」这件会被误当成协议问题的事。
describe('describeConnectFailure', () => {
  it('给出带主机与端口的可读文案', () => {
    expect(describeConnectFailure(new Error('No common 客户端 MAC'), 'h', 10010)).toBe(
      'h:10010 — No common 客户端 MAC',
    );
  });
});
