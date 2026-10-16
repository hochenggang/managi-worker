import { describe, expect, it } from 'vitest';
import { isDirectory, isIdentityPart, joinPath, partFilePath, sizeOf, toFileItem } from '../src/file-meta';
import { DIR_MODE, FILE_MODE, SYMLINK_MODE, attrs } from './fakes';

describe('sizeOf', () => {
  it('数字原样返回', () => {
    expect(sizeOf(attrs({ size: 0 }))).toBe(0);
    expect(sizeOf(attrs({ size: 12345 }))).toBe(12345);
  });

  it('数字字符串转成数字（SFTP 的 uint64 是字符串）', () => {
    expect(sizeOf(attrs({ size: '9876543210' }))).toBe(9876543210);
  });

  it('缺失返回 null（不知道 ≠ 0，断点续传靠这个区别活着）', () => {
    expect(sizeOf(attrs())).toBeNull();
  });

  it('负数、小数、超安全整数都返回 null', () => {
    expect(sizeOf(attrs({ size: -1 }))).toBeNull();
    expect(sizeOf(attrs({ size: 1.5 }))).toBeNull();
    expect(sizeOf(attrs({ size: Number.MAX_SAFE_INTEGER + 2 }))).toBeNull();
    expect(sizeOf(attrs({ size: '99999999999999999999' }))).toBeNull();
    expect(sizeOf(attrs({ size: 'abc' }))).toBeNull();
  });

  it('恰好等于安全整数上界时仍可用', () => {
    expect(sizeOf(attrs({ size: Number.MAX_SAFE_INTEGER }))).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('toFileItem', () => {
  it('普通文件', () => {
    expect(toFileItem('a.txt', attrs({ size: '11', permissions: FILE_MODE, mtime: 1700000000 })))
      .toEqual({ filename: 'a.txt', size: 11, mode: '-rw-r--r--', is_dir: false, mtime: 1700000000 });
  });

  it('目录', () => {
    expect(toFileItem('docs', attrs({ permissions: DIR_MODE })))
      .toEqual({ filename: 'docs', size: 0, mode: 'drwxr-xr-x', is_dir: true, mtime: 0 });
  });

  it('软链接不是目录 —— 判错会让递归删除删到链接目标上', () => {
    const item = toFileItem('link', attrs({ permissions: SYMLINK_MODE }));
    expect(item.is_dir).toBe(false);
    expect(item.mode).toBe('lrwxrwxrwx');
  });

  it('取不到权限位时渲染成 10 个问号，不假装成 000', () => {
    expect(toFileItem('x', attrs({ size: 1 })).mode).toBe('??????????');
  });

  it('取不到大小时按 0 呈现（前端列表需要一个数字）', () => {
    expect(toFileItem('x', attrs({ permissions: FILE_MODE })).size).toBe(0);
  });

  it('setuid / setgid / sticky 位按 ls 的写法渲染', () => {
    expect(toFileItem('suid', attrs({ permissions: 0o104755 })).mode).toBe('-rwsr-xr-x');
    expect(toFileItem('suid-no-x', attrs({ permissions: 0o104644 })).mode).toBe('-rwSr--r--');
    expect(toFileItem('sgid', attrs({ permissions: 0o102755 })).mode).toBe('-rwxr-sr-x');
    expect(toFileItem('sticky', attrs({ permissions: 0o041777 })).mode).toBe('drwxrwxrwt');
    expect(toFileItem('sticky-no-x', attrs({ permissions: 0o041776 })).mode).toBe('drwxrwxrwT');
  });

  it('设备 / 管道文件有各自的类型字符（复用 sftp-types 的渲染）', () => {
    expect(toFileItem('sock', attrs({ permissions: 0o140755 })).mode).toBe('srwxr-xr-x');
    expect(toFileItem('fifo', attrs({ permissions: 0o010644 })).mode).toBe('prw-r--r--');
  });
});

describe('isDirectory', () => {
  it('只有真的是目录才为 true', () => {
    expect(isDirectory(attrs({ permissions: DIR_MODE }))).toBe(true);
    expect(isDirectory(attrs({ permissions: FILE_MODE }))).toBe(false);
    expect(isDirectory(attrs({ permissions: SYMLINK_MODE }))).toBe(false);
  });

  it('属性缺失或没有权限位时保守判否', () => {
    expect(isDirectory(undefined)).toBe(false);
    expect(isDirectory(attrs({ size: 10 }))).toBe(false);
  });
});

describe('joinPath', () => {
  it('绝对路径拼接', () => {
    expect(joinPath('/home/u', 'a.txt')).toBe('/home/u/a.txt');
  });

  it('目录已带斜杠时不重复', () => {
    expect(joinPath('/home/u/', 'a.txt')).toBe('/home/u/a.txt');
    expect(joinPath('/', 'a.txt')).toBe('/a.txt');
  });

  it('空目录或 . 直接返回名字（上传到当前目录的场景）', () => {
    expect(joinPath('', 'a.txt')).toBe('a.txt');
    expect(joinPath('.', 'a.txt')).toBe('a.txt');
  });
});

describe('partFilePath', () => {
  it('身份编进文件名：<final>.<size>-<mtime>.part', () => {
    expect(partFilePath('/d/big.iso', 1024, 1700000000)).toBe('/d/big.iso.1024-1700000000.part');
  });

  it('非法大小/时间归零，仍然生成一个稳定可识别的名字', () => {
    expect(partFilePath('/d/f', -5, 0)).toBe('/d/f.0-0.part');
    expect(partFilePath('/d/f', Number.NaN, Number.POSITIVE_INFINITY)).toBe('/d/f.0-0.part');
  });

  it('小数向下取整（同一文件两次上传必须得到同一个名字，否则续不上）', () => {
    expect(partFilePath('/d/f', 10.9, 20.9)).toBe(partFilePath('/d/f', 10, 20));
  });

  it('生成的名字能被 isIdentityPart 认出来（两处规则必须一致）', () => {
    const part = partFilePath('/d/f', 1024, 1700000000);
    const mid = part.slice('/d/f.'.length, part.length - '.part'.length);
    expect(isIdentityPart(mid)).toBe(true);
  });
});

describe('isIdentityPart', () => {
  it('认 <数字>-<数字>', () => {
    expect(isIdentityPart('1-2')).toBe(true);
    expect(isIdentityPart('0-0')).toBe(true);
    expect(isIdentityPart('1234567890-987654321')).toBe(true);
  });

  it('不认其它任何形状', () => {
    expect(isIdentityPart('')).toBe(false);
    expect(isIdentityPart('1')).toBe(false);
    expect(isIdentityPart('-1')).toBe(false);
    expect(isIdentityPart('1-')).toBe(false);
    expect(isIdentityPart('a-1')).toBe(false);
    expect(isIdentityPart('1-b')).toBe(false);
    expect(isIdentityPart('1.5-2')).toBe(false);
    expect(isIdentityPart('1-2-3')).toBe(false);
    expect(isIdentityPart(' 1-2')).toBe(false);
  });
});
