/**
 * HUD Display Enhancements Plugin (`plugins/hud-enhancements/index.ts`).
 *
 * Isolates non-1.13c HUD display enhancements outside core `src/`:
 * - `showBasePlusBonusStats`: displays character primary attributes (`Str`, `Dex`, `Vit`, `Ene`)
 *   on the Character Sheet as `base+bonus` (`x+y`).
 * - `showBasePlusBonusSkills`: displays learned skill levels in Skill Tree sockets and skill
 *   hover tooltips as `hardPoints+bonusLevels` (`x+y`).
 * - `showStatGainTooltips`: displays a floating tooltip with 1-point attribute gains (e.g.
 *   `+x Life`, `+y Melee Damage`) when hovering over primary attributes on the Character Sheet.
 * - `showWeaponDamageFormula`: displays weapon attack and spell calculation breakdown tooltips.
 *
 * When disabled in the Plugin Menu, `PluginHost` automatically releases the capability claim
 * and reverts all settings to 100% authentic Diablo II v1.13c vanilla display (`false`).
 */

import {
  type D2WebPlugin,
  type HudEnhancementsConfig,
  type PluginContext,
  type PluginInstance,
  type PluginStatus,
} from '../../src/client/plugin-host/api.ts'

export interface HudEnhancementsPluginInstance extends PluginInstance {
  getConfig(): HudEnhancementsConfig
  setConfig(patch: Partial<HudEnhancementsConfig>): void
}

export function createHudEnhancementsPlugin(): D2WebPlugin {
  return {
    id: 'hud-enhancements',
    name: {
      zh: '界面增强显示',
      en: 'HUD Display Enhancements',
    },
    description: {
      zh: '非 1.13c 增强：在角色面板与技能树中以“基础+加成(x+y)”方式显示属性和技能点、鼠标悬停属性时显示单点属性增益提示、悬停伤害时显示计算公式。关闭插件后严格恢复 1.13c 原版显示。',
      en: 'Non-1.13c enhancement: displays character attributes and skill points in base+bonus (x+y) format, shows per-point attribute gain tooltips on hover, and shows damage calculation formulas. Reverts to 1.13c vanilla display when disabled.',
    },
    defaultEnabled: true,
    settings: [
      {
        kind: 'boolean',
        key: 'showBasePlusBonusStats',
        label: {
          zh: '属性显示 基础+加成 (x+y)',
          en: 'Attributes: Base + Bonus (x+y)',
        },
        default: true,
      },
      {
        kind: 'boolean',
        key: 'showStatGainTooltips',
        label: {
          zh: '人物属性悬停显示单点属性增益提示',
          en: 'Hover Attributes: Show +1 Point Gain Tooltip',
        },
        default: true,
      },
      {
        kind: 'boolean',
        key: 'showBasePlusBonusSkills',
        label: {
          zh: '技能点显示 基础+加成 (x+y)',
          en: 'Skill Points: Base + Bonus (x+y)',
        },
        default: true,
      },
      {
        kind: 'boolean',
        key: 'showWeaponDamageFormula',
        label: {
          zh: '武器与人物面板伤害悬停显示计算公式',
          en: 'Weapon & Character Sheet: Show Damage Formula',
        },
        default: true,
      },
    ],
    activate(ctx: PluginContext): HudEnhancementsPluginInstance {
      const readSettingsConfig = (): HudEnhancementsConfig => ({
        showBasePlusBonusStats: ctx.settings.get('showBasePlusBonusStats') === true,
        showBasePlusBonusSkills: ctx.settings.get('showBasePlusBonusSkills') === true,
        showStatGainTooltips: ctx.settings.get('showStatGainTooltips') === true,
        showWeaponDamageFormula: ctx.settings.get('showWeaponDamageFormula') === true,
      })

      ctx.client.setHudEnhancements(readSettingsConfig())

      const unsubClient = ctx.client.subscribeHudEnhancements((clientCfg) => {
        if (ctx.settings.get('showBasePlusBonusStats') !== clientCfg.showBasePlusBonusStats) {
          ctx.settings.set('showBasePlusBonusStats', clientCfg.showBasePlusBonusStats)
        }
        if (ctx.settings.get('showBasePlusBonusSkills') !== clientCfg.showBasePlusBonusSkills) {
          ctx.settings.set('showBasePlusBonusSkills', clientCfg.showBasePlusBonusSkills)
        }
        if (ctx.settings.get('showStatGainTooltips') !== clientCfg.showStatGainTooltips) {
          ctx.settings.set('showStatGainTooltips', clientCfg.showStatGainTooltips)
        }
        if (ctx.settings.get('showWeaponDamageFormula') !== clientCfg.showWeaponDamageFormula) {
          ctx.settings.set('showWeaponDamageFormula', clientCfg.showWeaponDamageFormula)
        }
        ctx.notifyStatusChanged()
      })

      const unsubSettings = ctx.settings.subscribe((key) => {
        if (
          key === 'showBasePlusBonusStats' ||
          key === 'showBasePlusBonusSkills' ||
          key === 'showStatGainTooltips' ||
          key === 'showWeaponDamageFormula'
        ) {
          ctx.client.setHudEnhancements(readSettingsConfig())
          ctx.notifyStatusChanged()
        }
      })

      const getStatus = (): PluginStatus => {
        const cfg = ctx.client.getHudEnhancements()
        const activeZh: string[] = []
        const activeEn: string[] = []
        if (cfg.showBasePlusBonusStats) {
          activeZh.push('属性x+y')
          activeEn.push('Stats x+y')
        }
        if (cfg.showStatGainTooltips) {
          activeZh.push('属性增益提示')
          activeEn.push('Stat Gain Tips')
        }
        if (cfg.showBasePlusBonusSkills) {
          activeZh.push('技能x+y')
          activeEn.push('Skills x+y')
        }
        if (cfg.showWeaponDamageFormula) {
          activeZh.push('武器伤害公式')
          activeEn.push('Weapon Dmg Formula')
        }
        if (activeZh.length === 0) {
          return {
            level: 'ok',
            text: {
              zh: '当前：已全部关闭（原版显示）',
              en: 'Active: None (Vanilla display)',
            },
          }
        }
        return {
          level: 'ok',
          text: {
            zh: `已启用：${activeZh.join(' / ')}`,
            en: `Active: ${activeEn.join(', ')}`,
          },
        }
      }

      return {
        getConfig: () => ctx.client.getHudEnhancements(),
        setConfig: (patch: Partial<HudEnhancementsConfig>) => {
          if (typeof patch.showBasePlusBonusStats === 'boolean') {
            ctx.settings.set('showBasePlusBonusStats', patch.showBasePlusBonusStats)
          }
          if (typeof patch.showBasePlusBonusSkills === 'boolean') {
            ctx.settings.set('showBasePlusBonusSkills', patch.showBasePlusBonusSkills)
          }
          if (typeof patch.showStatGainTooltips === 'boolean') {
            ctx.settings.set('showStatGainTooltips', patch.showStatGainTooltips)
          }
          if (typeof patch.showWeaponDamageFormula === 'boolean') {
            ctx.settings.set('showWeaponDamageFormula', patch.showWeaponDamageFormula)
          }
        },
        getStatus,
        deactivate(): void {
          unsubSettings()
          unsubClient()
        },
      }
    },
  }
}

export const hudEnhancementsPlugin: D2WebPlugin = createHudEnhancementsPlugin()
export default hudEnhancementsPlugin
