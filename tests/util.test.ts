import { describe, expect, it } from 'vitest';
import { clampInt, deferred, messageOf, toError, withTimeout } from '../src/util';

describe('messageOf', () => {
  it('取 Error 的 message', () => {
    expect(messageOf(new Error('炸了'))).toBe('炸了');
    expect(messageOf(new TypeError('类型不对'))).toBe('类型不对');
  });

  it('其余一律 String 化，不抛异常', () => {
    expect(messageOf('字符串')).toBe('字符串');
    expect(messageOf(42)).toBe('42');
    expect(messageOf(undefined)).toBe('undefined');
    expect(messageOf(null)).toBe('null');
    expect(messageOf({ a: 1 })).toBe('[object Object]');
  });

  it('自定义 Error 子类保留自己的文案', () => {
    class My extends Error {}
    expect(messageOf(new My('自定义'))).toBe('自定义');
  });
});

describe('toError', () => {
  it('Error 原样返回（不能洗掉栈）', () => {
    const original = new Error('原样');
    expect(toError(original)).toBe(original);
  });

  it('非 Error 包一层', () => {
    const wrapped = toError('纯字符串');
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.message).toBe('纯字符串');
  });

  it('undefined 也能包出来', () => {
    expect(toError(undefined).message).toBe('undefined');
  });
});

describe('deferred', () => {
  it('resolve 之后能 await 到值', async () => {
    const d = deferred<number>();
    d.resolve(7);
    await expect(d.promise).resolves.toBe(7);
  });

  it('reject 之后能 await 到错误', async () => {
    const d = deferred<string>();
    d.reject(new Error('失败'));
    await expect(d.promise).rejects.toThrow('失败');
  });

  it('先了结、后 reject 不产生未处理拒绝', async () => {
    const d = deferred<void>();
    d.resolve();
    // 模拟「Promise.race 已经赢过一次，底层又补一发 reject」的真实场景。
    expect(() => d.reject(new Error('迟到'))).not.toThrow();
    await d.promise;
    // 给微任务队列一个机会把未处理的 rejection 暴露出来。
    await Promise.resolve();
  });

  it('值是 undefined 的 deferred 也适用（PTY 就绪用它）', async () => {
    const d = deferred<undefined>();
    d.resolve(undefined);
    await expect(d.promise).resolves.toBeUndefined();
  });
});

describe('clampInt', () => {
  it('区间内原样返回', () => {
    expect(clampInt(50, 10, 100, 80)).toBe(50);
    expect(clampInt(10, 10, 100, 80)).toBe(10);
    expect(clampInt(100, 10, 100, 80)).toBe(100);
  });

  it('越界回退', () => {
    expect(clampInt(9, 10, 100, 80)).toBe(80);
    expect(clampInt(101, 10, 100, 80)).toBe(80);
    expect(clampInt(-1, 10, 100, 80)).toBe(80);
  });

  it('非整数回退（1.5 / NaN / Infinity 都不算合法尺寸）', () => {
    expect(clampInt(1.5, 1, 10, 3)).toBe(3);
    expect(clampInt(Number.NaN, 1, 10, 3)).toBe(3);
    expect(clampInt(Number.POSITIVE_INFINITY, 1, 10, 3)).toBe(3);
  });

  it('非数字类型回退（前端送来的可能是字符串或 null）', () => {
    expect(clampInt('50', 10, 100, 80)).toBe(80);
    expect(clampInt(null, 10, 100, 80)).toBe(80);
    expect(clampInt(undefined, 10, 100, 80)).toBe(80);
    expect(clampInt({}, 10, 100, 80)).toBe(80);
  });

  it('超出区间的大整数回退', () => {
    expect(clampInt(2 ** 40, 0, 10, 5)).toBe(5);
    expect(clampInt(2 ** 53, 0, 10, 5)).toBe(5);
  });

  it('-0 在区间内被接受，数值上就是 0（不会掉进兜底值）', () => {
    // 用 === 而不是 toBe：Object.is(-0, 0) 为 false，但 PTY 尺寸只关心数值。
    expect(clampInt(-0, 0, 10, 5) === 0).toBe(true);
  });
});

describe('withTimeout', () => {
  it('按时完成时原样透传结果', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, '不该超时')).resolves.toBe('ok');
  });

  it('超时后以给定文案拒绝', async () => {
    const hanging = new Promise<never>(() => undefined);
    await expect(withTimeout(hanging, 5, 'SSH 握手超时')).rejects.toThrow('SSH 握手超时');
  });

  it('底层先失败时透传原始错误，不换成超时文案', async () => {
    await expect(withTimeout(Promise.reject(new Error('底层炸了')), 1000, '不该超时'))
      .rejects.toThrow('底层炸了');
  });
});
