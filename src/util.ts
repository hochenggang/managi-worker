// Worker 侧的通用小工具：零依赖、纯函数（`ssh/utils.ts` 是报文编解码，与此无关）。
//
// 这三个东西原本在 worker.ts / durable-object.ts / session.ts 里各写了一份，
// 收拢到这里只为了「同一件事只存在一处」——改一处即全站生效。

/** messageOf 把任意抛出物取成可读文案：Error 取 message，其余 String 化。 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** toError 把任意抛出物收成一个 Error。原样保留 Error 实例 —— 重新包一层会把栈洗掉。 */
export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** HttpError 携带要回给客户端的 HTTP 状态码，供顶层统一转成 JSON 响应。 */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

/**
 * deferred 造一个「先拿到把手、后了结」的 Promise。
 * 通道就绪（ready）与失败（failed）是两件从底层异步冒出来的事，而调用方
 * 需要在发起动作**之前**就持有等待点，所以必须能把 resolve/reject 先取出来。
 *
 * 注意：这里挂了一个空的 catch。等待点常常会被 Promise.race 抢先了结，
 * 之后底层再 reject 一次就会变成「无人处理的拒绝」把进程带崩。
 */
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/**
 * clampInt 区间钳制：非整数或越界一律回退到 fallback。
 * 参数是外部（浏览器）送来的，可能是什么都有的 JSON，所以类型先验一遍再比大小。
 */
export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

/** withTimeout 给一次异步操作加个上限：卡在半路的握手不该挂住整条请求。 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * splitLines 按行拆分命令输出：保留中间空行、去掉末尾空行与行尾 \r。
 * CRLF 来自 Windows 上跑的远端命令，行尾留着 \r 会显示成怪符号。
 */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const out = text.replace(/\n$/, '').split('\n').map((line) => line.replace(/\r+$/, ''));
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}
