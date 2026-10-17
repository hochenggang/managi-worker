// RFC 4253 §4.2 的 identification string；计算 exchange hash 时不含末尾 CRLF。
//
// 上游这里是 `CFWorkersWebSSH_1.0` —— 照搬的直接后果是：目标机器的 sshd 日志、
// `last`、`who` 里看到的都是别人的客户端名，出问题时根本无法确认「是我连的」。
// softwareversion 只允许 [A-Za-z0-9.-_]（不能有 @ 和空格），下面的写法合法。
export const SSH_VERSION = 'SSH-2.0-managi_1.0';

export function isSSH2Identification(value: string): boolean {
  return value.startsWith('SSH-2.0-') || value.startsWith('SSH-1.99-');
}

export class SSHTransport {
  private remoteVersion: string = '';
  private readonly localVersion: string = SSH_VERSION;

  setRemoteVersion(version: string): void {
    this.remoteVersion = version;
  }

  getRemoteVersion(): string {
    return this.remoteVersion;
  }

  getLocalVersion(): string {
    return this.localVersion;
  }

  getLocalIdentification(): Uint8Array {
    return new TextEncoder().encode(`${this.localVersion}\r\n`);
  }
}
