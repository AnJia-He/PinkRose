export type AestheticSkill = {
  id: string
  version: number
  priority: number
  trigger: RegExp
  guidance: string
}

export const AESTHETIC_SKILLS: readonly AestheticSkill[] = [
  {
    id: 'portrait',
    version: 1,
    priority: 100,
    trigger: /人像|人物|自拍|脸|肤色|皮肤|写真|合影|肖像|portrait|selfie/iu,
    guidance:
      '先看人物状态、视线、肤色和背景关系；默认保留身份、五官、骨相和真实皮肤纹理。'
      + '磨皮只处理质感，不自动改变脸型或身体；需要塑形时必须有明确请求。',
  },
  {
    id: 'travel-landscape',
    version: 1,
    priority: 80,
    trigger: /旅行|旅游|风景|风光|山河|海边|日落|日出|天空|landscape|travel/iu,
    guidance:
      '先看空间层次、主景和地平线，再处理天空与远近关系。'
      + '保护现场光色和纵深，不用全局高饱和把所有层次压成一张明信片。',
  },
  {
    id: 'street-night',
    version: 1,
    priority: 90,
    trigger: /街拍|街头|夜景|夜晚|霓虹|灯光|城市|street|night/iu,
    guidance:
      '先保护灯牌和现场高光，再看黑位、色偏和噪点。'
      + '不要为了看清暗部把夜晚提成白天；霓虹可以有色，但肤色和白色光源要可信。',
  },
  {
    id: 'product-food',
    version: 1,
    priority: 95,
    trigger: /产品|商品|美食|食物|菜品|咖啡|甜品|电商|product|food/iu,
    guidance:
      '先看材质、轮廓、高光和色彩准确，再清理背景与瑕疵。'
      + '不改变商品结构、标签和食物真实颜色；白底要干净，但接触阴影和材质细节不能丢。',
  },
  {
    id: 'architecture-interior',
    version: 1,
    priority: 85,
    trigger: /建筑|室内|房间|楼|房屋|空间|architecture|interior/iu,
    guidance:
      '先看直线、透视和窗户高光，再平衡室内外明暗。'
      + '不为了冲击力扭曲结构；垂直边和大面积墙面应保持稳定，冷暖关系服务真实空间。',
  },
  {
    id: 'restoration',
    version: 1,
    priority: 110,
    trigger: /老照片|旧照|修复|划痕|褪色|黑白上色|restore|restoration/iu,
    guidance:
      '先区分自然老化和需要修补的损伤，再决定本地修复还是生成。'
      + '保留人物身份、时代质感和原始光影；只补缺失信息，不把旧照统一磨成现代美颜。',
  },
  {
    id: 'social-output',
    version: 1,
    priority: 60,
    trigger: /小红书|朋友圈|封面|头像|发出去|社交|海报|竖屏|thumbnail|social/iu,
    guidance:
      '先看缩略图可读性、主体占比和安全画幅，再决定裁切与色彩。'
      + '平台风格只能服务照片本身，不把流行模板凌驾于人物关系、现场感和可读性。',
  },
] as const

const MAX_ACTIVE_SKILLS = 2

export function selectAestheticSkills(text: string): AestheticSkill[] {
  return AESTHETIC_SKILLS
    .filter((skill) => skill.trigger.test(text))
    .sort((left, right) => right.priority - left.priority)
    .slice(0, MAX_ACTIVE_SKILLS)
}

export function buildAestheticSkillGuide(text: string): string {
  const skills = selectAestheticSkills(text)
  if (skills.length === 0) return ''
  return [
    '【本轮审美重点】',
    ...skills.map((skill) => `- ${skill.id}@${skill.version}: ${skill.guidance}`),
  ].join('\n')
}
