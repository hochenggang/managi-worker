// SSH 协议常量与连接配置。
// 这些常量与 ssh/ 下的协议栈（来自 EdgeSSH，逐字保留）配套，改动会让报文编号对不上。
// Worker 侧的 Env 也定义在这里，避免再散一份变量清单。

export interface SSHPacket {
  length: number;
  paddingLength: number;
  payload: Uint8Array;
  mac?: Uint8Array;
}

export interface KEXInitMessage {
  kexAlgorithms: string[];
  hostKeyAlgorithms: string[];
  encryptionC2S: string[];
  encryptionS2C: string[];
  macC2S: string[];
  macS2C: string[];
  compressionC2S: string[];
  compressionS2C: string[];
  firstKexPacketFollows: boolean;
}

export interface SessionKeys {
  ivClientToServer: Uint8Array;
  ivServerToClient: Uint8Array;
  encKeyClientToServer: Uint8Array;
  encKeyServerToClient: Uint8Array;
  integrityKeyC2S: Uint8Array;
  integrityKeyS2C: Uint8Array;
  sessionID: Uint8Array;
}

/** 一次 SSH 连接的全部输入。凭据只在这个对象里短暂存在，认证一结束就被抹掉。 */
export interface SSHConnectionConfig {
  host: string;
  port: number;
  username: string;
  authMethod: 'password' | 'publickey';
  password?: string;
  privateKey?: string;
  cols: number;
  rows: number;
  term: string;
}

export interface Env {
  ASSETS?: Fetcher;
  MANAGI_SESSIONS: DurableObjectNamespace;
  MANAGI_KNOWN_HOSTS?: KVNamespace;
  /** Basic Auth 凭据 `user:pass`。非空即启用鉴权。 */
  MANAGI_AUTH?: string;
  CONNECT_TIMEOUT_MS?: string;
  /** tofu（默认）| off */
  HOST_KEY_MODE?: string;
}

export const SSH_MSG_DISCONNECT = 1;
export const SSH_MSG_IGNORE = 2;
export const SSH_MSG_UNIMPLEMENTED = 3;
export const SSH_MSG_DEBUG = 4;
export const SSH_MSG_SERVICE_REQUEST = 5;
export const SSH_MSG_SERVICE_ACCEPT = 6;
export const SSH_MSG_EXT_INFO = 7;
export const SSH_MSG_KEXINIT = 20;
export const SSH_MSG_NEWKEYS = 21;
export const SSH_MSG_KEX_ECDH_INIT = 30;
export const SSH_MSG_KEX_ECDH_REPLY = 31;
export const SSH_MSG_USERAUTH_REQUEST = 50;
export const SSH_MSG_USERAUTH_FAILURE = 51;
export const SSH_MSG_USERAUTH_SUCCESS = 52;
export const SSH_MSG_USERAUTH_INFO_REQUEST = 60;
export const SSH_MSG_GLOBAL_REQUEST = 80;
export const SSH_MSG_REQUEST_SUCCESS = 81;
export const SSH_MSG_REQUEST_FAILURE = 82;
export const SSH_MSG_CHANNEL_OPEN = 90;
export const SSH_MSG_CHANNEL_OPEN_CONFIRMATION = 91;
export const SSH_MSG_CHANNEL_OPEN_FAILURE = 92;
export const SSH_MSG_CHANNEL_WINDOW_ADJUST = 93;
export const SSH_MSG_CHANNEL_DATA = 94;
export const SSH_MSG_CHANNEL_EXTENDED_DATA = 95;
export const SSH_MSG_CHANNEL_EOF = 96;
export const SSH_MSG_CHANNEL_CLOSE = 97;
export const SSH_MSG_CHANNEL_REQUEST = 98;
export const SSH_MSG_CHANNEL_SUCCESS = 99;
export const SSH_MSG_CHANNEL_FAILURE = 100;
