import { describe, expect, it } from 'vitest'
import { ZERO } from '../../shared/adjustments.ts'
import type { ChatMessage, ModelClient } from '../sn.ts'
import { SerialQueue } from '../queue.ts'
import { handleRoute } from '../route.ts'

const IMG = 'data:image/jpeg;base64,AAAA'
const BODY = { imageDataUrl: IMG, text: '按这张的感觉来', params: ZERO }

function modelReplying(content: string): ModelClient {
  return {
    baseUrl: 'https://example.test',
    apiKey: 'test',
    vlmModel: 'chat',
    imageModel: 'image',
    chatJson: async (_messages: ChatMessage[]) => content,
    edit: async () => 'AA==',
  }
}

describe('审美导演端到端编译', () => {
  const cases = [
    {
      name: '本地调色',
      content: {
        intent: 'edit',
        actions: [{
          capability: 'local.tone_color',
          param_deltas: { exposure: 8, highlights: -6 },
        }],
        reply: '人物提亮一点，天空不跟着灰。',
      },
      route: 'params',
      params: { exposure: 8, highlights: -6 },
      edit: '',
    },
    {
      name: '单次生成',
      content: {
        intent: 'edit',
        actions: [{
          capability: 'generation.photo_edit',
          edit_prompt: 'Remove only the bin from the background.',
        }],
        reply: '把后面的垃圾桶清掉。',
      },
      route: 'generate',
      params: {},
      edit: 'Remove only the bin from the background.',
    },
    {
      name: '本地加生成',
      content: {
        intent: 'hybrid',
        actions: [
          {
            capability: 'local.style_recipe',
            recipe: 'quiet-cinema',
          },
          {
            capability: 'generation.photo_edit',
            edit_prompt: 'Remove only the distant tourists.',
          },
        ],
        direction: { name: '安静电影感', intensity: 'subtle' },
        reply: '人物关系留着，电影感收一点，远处的人清掉。',
      },
      route: 'both',
      params: { contrast: 8, highlights: -8, shadows: 3, temperature: -2, saturation: -5 },
      edit: 'Remove only the distant tourists.',
    },
    {
      name: '只给建议',
      content: {
        intent: 'advise',
        actions: [],
        reply: '可以只提亮人物，或者压暗背景再冷一点。',
      },
      route: 'params',
      params: {},
      edit: '',
    },
  ] as const

  for (const item of cases) {
    it(`${item.name} → ${item.route}`, async () => {
      const result = await handleRoute(
        { ...BODY, text: item.name === '只给建议' ? '不知道该怎么修' : BODY.text },
        {
          client: modelReplying(JSON.stringify(item.content)),
          queue: new SerialQueue({ sleep: async () => {} }),
        },
      )
      expect(result.decision.route).toBe(item.route)
      expect(result.decision.paramDeltas).toEqual(item.params)
      expect(result.decision.editPrompt).toBe(item.edit)
    })
  }

  it('多个人物说不清目标时只请求点选，不执行生成', async () => {
    const result = await handleRoute(
      { ...BODY, text: '把后面那个人去掉' },
      {
        client: modelReplying(JSON.stringify({
          intent: 'edit',
          actions: [{
            capability: 'generation.photo_edit',
            edit_prompt: 'Remove the person in the background.',
          }],
          reply: '后面有两个人，我先确认你说的是哪位。',
          needs_disambiguation: true,
        })),
        queue: new SerialQueue({ sleep: async () => {} }),
      },
    )
    expect(result.decision.needsDisambiguation).toBe(true)
  })
})
