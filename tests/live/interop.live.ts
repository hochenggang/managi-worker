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
import type { Socket as NetSocket } from 'node:net';
import { connect as netConnect } from 'node:net';
import { describe, expect, it } from 'vitest';

import {
  describeConnectFailure,
  PTYHandler,
  SSHConnection,
  type ChannelCallbacks,
  type ConnectionHooks,
} from '../../src/session';
import type { SSHConnectionConfig } from '../../src/types';
import { adaptSocket } from './socket-adapter';

const HOST = process.env.LIVE_SSH_HOST ?? '';
const PORT = Number(process.env.LIVE_SSH_PORT ?? '22');
const USER = process.env.LIVE_SSH_USER ?? '';
const KEY_PATH = process.env.LIVE_SSH_KEY ?? '';
const READY = HOST !== '' && USER !== '' && KEY_PATH !== '';

function config(): SSHConnectionConfig {
  return {
    host: HOST,
    port: PORT,
    username: USER,
    authMethod: 'publickey',
    privateKey: readFileSync(KEY_PATH, 'utf8'),
    cols: 80,
    rows: 24,
    term: 'xterm-256color',
  };
}

interface Session {
  conn: SSHConnection;
  socket: NetSocket;
  fingerprints: string[];
}

/** 走完整流程的前半段：TCP → 版本交换 → KEX → 认证。 */
async function connect(): Promise<Session> {
  const socket = netConnect({ host: HOST, port: PORT });
  await once(socket, 'connect');

  const fingerprints: string[] = [];
  const hooks: ConnectionHooks = {
    ended: () => undefined,
    verifyHostKey: async (fingerprint) => {
      fingerprints.push(fingerprint);
      return { ok: true };
    },
  };

  // adaptSocket 给的对象结构上就是 SSHConnection 需要的那个 Socket（readable / writable / close）。
  const conn = new SSHConnection(adaptSocket(socket) as never, config(), hooks);
  await conn.handshake();
  return { conn, socket, fingerprints };
}

/** runOn 在已建好的连接上开一路 PTY，敲一条命令，等到 marker 出现。
 *  用 PTY 而不是 exec：这个项目对外只提供终端与文件管理，exec 通道已经删掉了，
 *  真机验证也该验证实际会被用到的路径。
 */
async function runOn(conn: SSHConnection, command: string, marker: string): Promise<string> {
  let output = '';
  const decoder = new TextDecoder();
  let handler: PTYHandler | null = null;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`等待 ${marker} 超时；已收到：${JSON.stringify(output)}`)),
      20_000,
    );
    const settle = (error?: Error): void => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const callbacks: ChannelCallbacks = {
      data: (payload) => {
        output += decoder.decode(payload, { stream: true });
        if (output.includes(marker)) settle();
      },
      control: () => undefined,
      error: (message) => settle(new Error(message)),
      ready: () => {
        handler?.queueInput(new TextEncoder().encode(`${command}; exit\r`));
      },
      failed: (message) => settle(new Error(message)),
    };
    handler = new PTYHandler(conn, 80, 24, callbacks);
    conn.openPTY(handler);
  });
  return output;
}

describe.skipIf(!READY)('真实服务器互通（需 LIVE_SSH_* 环境变量）', () => {
  it('握手 + 公钥认证 + 终端里跑一条命令', async () => {
    const session = await connect();
    try {
      const output = await runOn(session.conn, 'echo interop-ok; id -un', 'interop-ok');
      expect(output).toContain('interop-ok');
      expect(output).toContain(USER);
      // 主机密钥走的是 TOFU 钩子，指纹必须拿到（空指纹说明握手没真走完）。
      expect(session.fingerprints).toHaveLength(1);
      expect(session.fingerprints[0]).toMatch(/^SHA256:/);
    } finally {
      session.conn.close();
      session.socket.destroy();
    }
  });

  it('同一条连接上连续开两路通道，各自收到各自的输出', async () => {
    const session = await connect();
    try {
      for (const marker of ['alpha', 'beta']) {
        const output = await runOn(session.conn, `echo ${marker}`, marker);
        expect(output).toContain(marker);
      }
    } finally {
      session.conn.close();
      session.socket.destroy();
    }
  }, 60_000);
});

// 不论有没有账号，这条都要跑：它钉住「失败文案」这件会被误当成协议问题的事。
describe('describeConnectFailure', () => {
  it('给出带主机与端口的可读文案', () => {
    expect(describeConnectFailure(new Error('No common 客户端 MAC'), 'h', 10010)).toBe(
      'h:10010 — No common 客户端 MAC',
    );
  });
});
