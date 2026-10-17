// 最小可观测性：一条事件一行 JSON。
//
// 为什么不直接写 console.log('xxx')：线上只看得到 wrangler tail 的一屏流水，
// 自由文本里认一条失败要靠肉眼。事件名 + 字段可以直接过滤，也能被日志平台解析。
//
// 不设运行时开关：Worker 的日志按调用计费，需要静音时应当删掉打点，
// 而不是留一个读不到 env 的开关（读不到就等于永远关着，出事时才发现没日志）。

type FieldValue = string | number | boolean | null | undefined;
export type Fields = Record<string, FieldValue>;

function line(event: string, fields: Fields): string {
  const payload: Record<string, FieldValue> = { event };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) payload[key] = value;
  }
  return `[managi] ${JSON.stringify(payload)}`;
}

/** logInfo 正常流水：建连、通道打开、耗时。 */
export function logInfo(event: string, fields: Fields = {}): void {
  console.log(line(event, fields));
}

/** logWarn 能继续跑但值得注意：降级、被截断、静默兜底。 */
export function logWarn(event: string, fields: Fields = {}): void {
  console.warn(line(event, fields));
}

/** logError 出错：失败原因必须能从这里读到，而不是只弹给用户。 */
export function logError(event: string, fields: Fields = {}): void {
  console.error(line(event, fields));
}

/** elapsedMs 从 start 到现在过了多少毫秒，用于记录各阶段耗时。 */
export function elapsedMs(start: number): number {
  return Date.now() - start;
}
