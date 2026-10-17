import { describe, expect, it } from 'vitest';

import { SSHConnection, type ConnectionHooks } from '../src/session';
import { KEXInitBuilder } from '../src/ssh/kex';

// 服务端发起的重协商（rekey）：OpenSSH 默认在 1GB 流量或 1 小时后触发。
// 以前 Worker 版在这里直接抛错，长会话会毫无征兆地被掐断——而且日志里只有
// 一句「不支持」看不出是 rekey。这些用例钉住状态机的入口与出口。

const hooks: ConnectionHooks = {
  ended: () => undefined,
  verifyHostKey: async () => ({ ok: true }),
};

interface Wiring {
  conn: SSHConnection;
  written: Uint8Array[];
  /** 直接改内部阶段（真实值由握手推进，这里只验 rekey 这一段）。 */
  setPhase: (phase: string) => void;
  deliver: (payload: Uint8Array) => Promise<void>;
  state: () => { rekeying: boolean; phase: string; sessionId: string | null };
}

function wire(): Wiring {
  const written: Uint8Array[] = [];
  const socket = {
    readable: new ReadableStream<Uint8Array>(),
    writable: new WritableStream<Uint8Array>({ write: (chunk) => { written.push(chunk); } }),
  } as unknown as Socket;
  const conn = new SSHConnection(socket, {
    host: 'example.com', port: 22, username: 'root', authMethod: 'password', password: 'pw',
    cols: 80, rows: 24, term: 'xterm-256color',
  }, hooks);
  const internals = conn as unknown as {
    phase: string;
    rekeying: boolean;
    sessionId: Uint8Array | null;
    handlePacket: (packet: { payload: Uint8Array }) => Promise<void>;
  };
  return {
    conn,
    written,
    setPhase: (phase) => { internals.phase = phase; },
    deliver: (payload) => internals.handlePacket({ payload }),
    state: () => ({
      rekeying: internals.rekeying,
      phase: internals.phase,
      sessionId: internals.sessionId ? 'kept' : null,
    }),
  };
}

/** kexInit 造一份「服务器」的 KEXINIT（内容与客户端列表兼容即可，这里直接用同一份）。 */
function kexInit(): Uint8Array {
  return KEXInitBuilder.build();
}

describe('服务端发起的 rekey', () => {
  it('ready 阶段收到 KEXINIT → 进入重协商并回自己那份，不再抛「不支持」', async () => {
    const w = wire();
    w.setPhase('ready');
    await w.deliver(kexInit());
    expect(w.state().rekeying).toBe(true);
    // 回了一份 KEXINIT + 一份 ECDH_INIT（都是加密报文，但此时还没有密钥 → 明文写出）
    expect(w.written.length).toBeGreaterThanOrEqual(2);
    expect(w.written[0][5]).toBe(20); // SSH_MSG_KEXINIT
  });

  it('重协商期间也不把 phase 从 ready 打回 auth（会话不该因此重认证）', async () => {
    const w = wire();
    w.setPhase('ready');
    await w.deliver(kexInit());
    expect(w.state().phase).toBe('ready');
  });
});
