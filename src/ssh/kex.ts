import { SSH_MSG_KEXINIT, KEXInitMessage } from '../types';
import {
  SUPPORTED_ENCRYPTION_ALGORITHMS,
  SUPPORTED_KEX_ALGORITHMS,
  SUPPORTED_MAC_ALGORITHMS
} from './algorithms';
import { concat, encodeString, readUint32 } from './utils';

export class KEXInitBuilder {
  static build(): Uint8Array {
    const parts: Uint8Array[] = [];

    parts.push(new Uint8Array([SSH_MSG_KEXINIT]));

    const cookie = new Uint8Array(16);
    crypto.getRandomValues(cookie);
    parts.push(cookie);

    const algorithmLists = [
      ['ext-info-c', ...SUPPORTED_KEX_ALGORITHMS].join(','),
      'ssh-ed25519,ecdsa-sha2-nistp256,ecdsa-sha2-nistp384,ecdsa-sha2-nistp521,rsa-sha2-512,rsa-sha2-256',
      SUPPORTED_ENCRYPTION_ALGORITHMS.join(','),
      SUPPORTED_ENCRYPTION_ALGORITHMS.join(','),
      SUPPORTED_MAC_ALGORITHMS.join(','),
      SUPPORTED_MAC_ALGORITHMS.join(','),
      'none',
      'none',
      '',
      '',
    ];

    // 十个名字列表都是 name-list：uint32 长度 + 字节。直接用 encodeString，
    // 别再手搓一份 setUint32 —— 上游这里就是手搓的，和 utils 里的同名逻辑重复了两套。
    for (const name of algorithmLists) parts.push(encodeString(name));

    parts.push(new Uint8Array([0]));
    parts.push(new Uint8Array(4)); // reserved

    return concat(...parts);
  }
}

export function parseKEXInit(data: Uint8Array): KEXInitMessage {
  if (data.length < 22 || data[0] !== SSH_MSG_KEXINIT) throw new Error('Malformed KEXINIT header');
  let offset = 1;

  offset += 16;

  const lists: string[] = [];
  for (let i = 0; i < 10; i++) {
    if (offset + 4 > data.length) {
      throw new Error(`Malformed KEXINIT: truncated length field at list ${i}, offset=${offset}, dataLen=${data.length}`);
    }
    // readUint32 已按无符号处理，不必再挡负值；越界由下面这条统一兜住。
    const len = readUint32(data, offset);
    offset += 4;
    if (offset + len > data.length) {
      throw new Error(`Malformed KEXINIT: list ${i} length ${len} exceeds packet boundary (offset=${offset}, dataLen=${data.length})`);
    }
    let name: string;
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(offset, offset + len)); }
    catch { throw new Error(`Malformed KEXINIT: invalid UTF-8 in list ${i}`); }
    if (name.includes('\0') || name.split(',').some((entry) => entry.length > 0 && !/^[A-Za-z0-9@._+-]+$/.test(entry))) {
      throw new Error(`Malformed KEXINIT algorithm list ${i}`);
    }
    lists.push(name);
    offset += len;
  }

  if (offset + 5 > data.length) throw new Error('Malformed KEXINIT trailer');
  const firstKexPacketFollows = data[offset] !== 0;
  offset += 5; // boolean first_kex_packet_follows and uint32 reserved
  if (offset !== data.length) throw new Error('Malformed KEXINIT trailing data');

  return {
    kexAlgorithms: lists[0].split(','),
    hostKeyAlgorithms: lists[1].split(','),
    encryptionC2S: lists[2].split(','),
    encryptionS2C: lists[3].split(','),
    macC2S: lists[4].split(','),
    macS2C: lists[5].split(','),
    compressionC2S: lists[6].split(','),
    compressionS2C: lists[7].split(','),
    firstKexPacketFollows,
  };
}

export function negotiate(clientList: string[], serverList: string[], category: string = 'algorithm'): string {
  for (const algo of clientList) {
    if (serverList.includes(algo)) return algo;
  }
  throw new Error(`No common ${category}: client=[${clientList.join(',')}] server=[${serverList.join(',')}]`);
}
export function parseServerSigAlgs(payload: Uint8Array): string[] {
  if (payload[0] !== 7) throw new Error('Malformed EXT_INFO message type');
  let offset = 1; // Skip the message type.

  if (offset + 4 > payload.length) throw new Error('Malformed EXT_INFO extension count');
  const nrExtensions = readUint32(payload, offset);
  offset += 4;

  if (nrExtensions > 1024) throw new Error(`EXT_INFO extension count is too large (${nrExtensions})`);

  let serverSigAlgs: string[] = [];
  for (let i = 0; i < nrExtensions; i++) {
    if (offset + 4 > payload.length) throw new Error('Malformed EXT_INFO extension name length');
    const nameLen = readUint32(payload, offset);
    offset += 4;
    if (offset + nameLen > payload.length) throw new Error('Malformed EXT_INFO extension name');
    let name: string;
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(payload.subarray(offset, offset + nameLen)); }
    catch { throw new Error('Malformed EXT_INFO extension name'); }
    offset += nameLen;

    if (offset + 4 > payload.length) throw new Error('Malformed EXT_INFO extension value length');
    const valueLen = readUint32(payload, offset);
    offset += 4;
    if (offset + valueLen > payload.length) throw new Error('Malformed EXT_INFO extension value');
    const valueBytes = payload.subarray(offset, offset + valueLen);
    offset += valueLen;

    if (name === 'server-sig-algs') {
      let value: string;
      try { value = new TextDecoder('utf-8', { fatal: true }).decode(valueBytes); }
      catch { throw new Error('Malformed server-sig-algs extension'); }
      serverSigAlgs = value.split(',').filter((algorithm) => /^[A-Za-z0-9@._+-]+$/.test(algorithm));
    }
  }
  if (offset !== payload.length) throw new Error('Malformed EXT_INFO trailing data');
  return serverSigAlgs;
}
export function filterExtInfo(list: string[]): string[] {
  return list.filter(a => !a.startsWith('ext-info-'));
}
