import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { patchPath } from './patch-path'

async function readPatch(packageName: string): Promise<string> {
  return readFile(patchPath(packageName), 'utf8')
}

/**
 * 切换模型后反复出现的三类失败：
 *  1. “Selected model is at capacity. Please try a different model.”（供应商容量/过载）
 *  2. `pi-ai detected context overflow for model "…"`（新模型窗口更小）
 *  3. “DeepSeek request extension preparation failed” / REQUEST_EXTENSION（扩展准备抛错即拒发请求）
 *
 * 修复思路：容量/过载文本归入可重试错误；单个扩展贡献者失败不再拖垮整个请求；
 * 已知的两个抛错源（插件清单解析、会话日志水位线）改为降级跳过。
 */
describe('模型切换健壮性补丁', () => {
  it('把供应商容量/过载文本归类为可重试的 RATE_LIMIT', async () => {
    const piAi = await readPatch('@deepseek-ai/dsh-llm-pi-ai')
    const deepseek = await readPatch('@deepseek-ai/dsh-llm-deepseek')

    // 两个适配器都要命中该规则，且位于 401/403 判定之前、配额判定之后
    for (const patch of [piAi, deepseek]) {
      expect(patch).toContain('at|over')
      expect(patch).toContain('overloaded')
      expect(patch).toContain('return "RATE_LIMIT";')
    }
    expect(piAi.indexOf('isQuotaExceededError(message)')).toBeLessThan(
      piAi.indexOf('at|over')
    )
    expect(piAi.indexOf('at|over')).toBeLessThan(piAi.lastIndexOf('\\b401\\b'))
    expect(deepseek.indexOf('isQuotaExceededError(detail)')).toBeLessThan(
      deepseek.indexOf('at|over')
    )
    expect(deepseek.indexOf('at|over')).toBeLessThan(
      deepseek.lastIndexOf('status === 401')
    )
  })

  it('单个请求扩展贡献者失败时跳过字段而不是拒绝整个请求', async () => {
    const patch = await readPatch('@deepseek-ai/dsh-deepseek-llm-api-extensions')

    expect(patch).toContain('try {')
    expect(patch).toContain('catch (error)')
    expect(patch).toContain('this.ctx?.logger?.warn?.')
    expect(patch).toContain('result: void 0')
    // 仍然保留原有的中止语义与字段冻结
    expect(patch).toContain('request.signal')
    expect(patch).not.toContain('+throw new Error("DeepSeek request extension')
  })

  it('插件清单解析不到包时降级为未知身份', async () => {
    const patch = await readPatch(
      '@deepseek-ai/dsh-plugin-package-inventory-deepseek'
    )

    expect(patch).toContain('-')
    expect(patch).not.toContain(
      '+\t\t\tif (manifest === void 0) throw new Error'
    )
    expect(patch).toContain('barePackageManifest(packageName, anchors)')
  })

  it('会话日志水位线容忍被压缩裁剪的事件与畸变记录', async () => {
    const patch = await readPatch('@deepseek-ai/dsh-session-log-deepseek')

    expect(patch).not.toContain('+\t\tif (event === void 0) throw new Error')
    expect(patch).not.toContain(
      '+\t\t\tthrow new Error(`session-log-deepseek: malformed acceptance watermark'
    )
    expect(patch).toContain('+')
    expect(patch).toContain('continue;')
  })
})
