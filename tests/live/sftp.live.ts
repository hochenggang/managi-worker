// 真服务器上的 SFTP 通道验证。
//
// 握手能过、终端能开，不代表 SFTP 能开：子系统请求、SFTP 协议握手（INIT/VERSION）、
// realpath 都会各自出错，而它们在单测里全是被 mock 掉的那部分。所以单独验一遍。
//
// 用法同 interop.live.ts（LIVE_SSH_* 环境变量），另外可用 LIVE_SSH_DIR 指定要列的目录。
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { describe, expect, it } from 'vitest';

import { SFTPHandler, SSHConnection, type ChannelCallbacks, type ConnectionHooks } from '../../src/session';
import type { FileItemOut } from '../../src/file-meta';
import type { SSHConnectionConfig } from '../../src/types';
import { adaptSocket } from './socket-adapter';

const HOST = process.env.LIVE_SSH_HOST ?? '';
const PORT = Number(process.env.LIVE_SSH_PORT ?? '22');
const USER = process.env.LIVE_SSH_USER ?? '';
const KEY_PATH = process.env.LIVE_SSH_KEY ?? '';
const READY = HOST !== '' && USER !== '' && KEY_PATH !== '';

interface SftpSession {
  conn: SSHConnection;
  handler: SFTPHandler;
  home: string;
}

/** 建连 + 认证 + 开 SFTP 子系统。失败时把原因原样抛出来（这就是要看的报错）。 */
async function openSftp(): Promise<SftpSession> {
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

  let handler: SFTPHandler;
  // 子系统就绪（或失败）是一个回调，用 Promise 把它接回来。
  const opened = new Promise<string>((resolve, reject) => {
    const callbacks: ChannelCallbacks = {
      data: () => undefined,
      control: () => undefined,
      error: (message) => reject(new Error(`通道错误：${message}`)),
      ready: (info) => resolve(info ?? '/'),
      failed: (message) => reject(new Error(`通道失败：${message}`)),
    };
    handler = new SFTPHandler(conn, callbacks);
  });

  await conn.handshake();
  conn.openSFTP(handler!);
  const home = await opened;
  return { conn, handler: handler!, home };
}

describe.skipIf(!READY)('真实服务器 SFTP（需 LIVE_SSH_* 环境变量）', () => {
  it('开子系统、取 home、列目录', async () => {
    const session = await openSftp();
    try {
      expect(session.home).toMatch(/^\//);
      const listing = await session.handler.list(process.env.LIVE_SSH_DIR ?? session.home);
      expect(listing.path).toMatch(/^\//);
      expect(Array.isArray(listing.files)).toBe(true);
      for (const file of listing.files as FileItemOut[]) {
        expect(typeof file.filename).toBe('string');
        expect(file.filename).not.toBe('.');
      }
    } finally {
      session.conn.close();
    }
  }, 45_000);
});
