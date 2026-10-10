import { useCallback, useEffect, useState } from 'react'
import { listPresets } from '../api/presets.ts'
import type { PresetMeta } from '../../shared/preset.ts'

/**
 * ★ 2026-10-10：「我的预设」的清单。缩略图不在这 —— 那是 `usePresetThumbs` 的活。
 *
 * 形状照着 `useLuts` 的**清单那一半**（加载 / 重拉 / `known`）。存/改/删之后
 * 维护列表的做法也照那边：**成功之后重拉**，不在本地改那份名单 —— 服务端会
 * 动名字（trim），名单的真值只有它那一份（`LutSettings` 的导入 / 改名 / 删除
 * 三处都是 `await loadLuts()`，别新发明一种）。
 */
export function usePresets(): { presets: PresetMeta[]; known: boolean; refresh: () => Promise<void> } {
  const [presets, setPresets] = useState<PresetMeta[]>([])
  /**
   * 清单**真的从服务端拿到过一次**没有（同 `useLuts` 的 `lutsKnown`）。
   *
   * ⚠️ 它和 `presets.length === 0` 是**两件事**：还没到手 / 取不到时，
   *    「还没有存过预设。」是一句**关于用户资产的假话**（他的预设还在服务端上）。
   *    只有拿到过空清单，那句才是事实。
   */
  const [known, setKnown] = useState(false)

  /**
   * 拉一遍清单。失败时**只留一行 console**，`known` 保持原样：
   * 一次"没问出来"（离线 / 5xx / 后端刚重启）不许把已经到手的清单说成"没有"
   * （`lutsKnown` 那段注释里的同一个道理）；从没到手过的话它本来就还是 false，
   * 界面会给"清单还没到手"的说法。
   */
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const { presets: list } = await listPresets()
      setPresets(list)
      setKnown(true)
    } catch (e) {
      console.error('预设清单没取回来：', e)
    }
  }, [])

  // 登录后拉一次清单（App 挂载时）
  useEffect(() => { void refresh() }, [refresh])

  return { presets, known, refresh }
}
