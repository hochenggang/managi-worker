// 目录项的「值变换」+ 上传残片的命名：把 SFTP 返回的原始属性翻译成前端要的
// filename/size/mode/is_dir/mtime，以及路径拼接。
//
// 纯函数、零 IO —— 单独成层是为了让这部分规则能被逐条验收：
// 权限位少一位、软链接被当成目录递归删，都是会静默删错东西的错误。
//
// 类型渲染不自己实现：`ssh/sftp-types.ts` 里已有 getSFTPFileKind / formatSFTPPermissions，
// 且比手写版更全（设备/管道文件渲染成 b/c/p 而不是 ?）。重复实现只会两处慢慢分叉。

import { formatSFTPPermissions, getSFTPFileKind, type SFTPAttrs } from './ssh/sftp';

/** 目录项：字段名与前端 protocol/types.ts 的 FileItem 一致，不能改名。 */
export interface FileItemOut {
  filename: string;
  size: number;
  mode: string;
  is_dir: boolean;
  mtime: number;
}

/** sizeOf 取文件大小；超出安全整数范围或缺失时返回 null（= 不知道，别当 0 用）。 */
export function sizeOf(attrs: SFTPAttrs): number | null {
  const raw = attrs.size;
  if (raw === undefined) return null;
  const value = typeof raw === 'string' ? Number(raw) : raw;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function toFileItem(filename: string, attrs: SFTPAttrs): FileItemOut {
  return {
    filename,
    size: sizeOf(attrs) ?? 0,
    mode: formatSFTPPermissions(attrs),
    is_dir: getSFTPFileKind(attrs) === 'directory',
    mtime: attrs.mtime ?? 0,
  };
}

/** isDirectory 判目录：递归删除、mkdir -p 都靠它决定「继续往下走」还是「停在这一层」。 */
export function isDirectory(attrs: SFTPAttrs | undefined): boolean {
  return getSFTPFileKind(attrs) === 'directory';
}

/** joinPath 拼远程路径：只处理 POSIX 斜杠（SSH 目标基本都是 POSIX）。 */
export function joinPath(dir: string, name: string): string {
  if (!dir || dir === '.') return name;
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

/**
 * partFilePath 给上传残片编上身份：`<final>.<size>-<mtime>.part`。
 * 身份进文件名，续传只在「大小与修改时间都吻合」时发生 —— 否则新旧字节会拼出
 * 一个大小正确、内容错乱的文件，静默损坏比传失败更难查。
 */
export function partFilePath(finalPath: string, size: number, mtime: number): string {
  const safeSize = Number.isFinite(size) && size > 0 ? Math.floor(size) : 0;
  const safeMtime = Number.isFinite(mtime) && mtime > 0 ? Math.floor(mtime) : 0;
  return `${finalPath}.${safeSize}-${safeMtime}.part`;
}

/** isIdentityPart 判断一个 `.part` 文件名中段是不是本模块生成的 `<数字>-<数字>`。 */
export function isIdentityPart(mid: string): boolean {
  const index = mid.indexOf('-');
  return index > 0 && index < mid.length - 1
    && /^[0-9]+$/.test(mid.slice(0, index))
    && /^[0-9]+$/.test(mid.slice(index + 1));
}
