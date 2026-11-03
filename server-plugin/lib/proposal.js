/**
 * 效果提议协议（M3-10）
 *
 * 定义 LLM 返回结构 { narrate, effects[] }，并提供 JSON 解析兜底。
 *
 * 铁律 R3：LLM 只能提交「效果提议」，由裁决器校验后落地。
 *
 * 解析兜底规则（M3-10 验收）：
 *  - 模型返回纯文本（无 JSON）→ 降级为「无 effects 的叙事」
 *  - JSON 被 markdown 代码块包裹 → 正确剥离
 *  - effects 非数组 → 视为空数组并告警
 */

/**
 * 主事件 API 的 prompt 模板（用于强约束 LLM 返回结构化提议）。
 */
export const PROPOSAL_PROMPT_TEMPLATE = `你是一个大学生活模拟游戏的叙事引擎。
请根据玩家输入和当前状态，输出你的叙事与数值提议。

严格按以下 JSON 格式返回（不要输出任何 JSON 以外的文字）：
{
  "narrate": "叙事正文，用模糊表述描述发生的事（不写具体数值）",
  "effects": [
    { "target": "self.health", "delta": 5, "reason": "运动" }
  ]
}

规则：
1. narrate 中禁止出现具体金额、数量、时间等精确数值，用"感觉好些了""花了一点钱"这类模糊表述。
2. effects 可留空数组 []，表示本回合不修改任何数值。
3. 每个 effect 的 target 用点分路径（如 self.health、self.stamina），delta 是数值变化量，reason 说明原因。
4. 不要修改金钱（money）、怀孕（pregnant）、背包（inventory）、上课状态（inClass）这类保留字段。
5. 数值改动幅度要克制、合理。`;

/**
 * 解析 LLM 返回，稳定得到 { narrate, effects } 结构。
 *
 * @param {string} raw LLM 原始返回文本
 * @returns {{ narrate: string, effects: Array, warnings: Array }}
 */
export function parseProposal(raw) {
    const warnings = [];
    let narrate = '';
    let effects = [];

    if (typeof raw !== 'string') {
        // 非字符串输入
        if (raw && typeof raw === 'object') {
            // 已经是对象（可能模型直接返回了结构化结果）
            narrate = String(raw.narrate ?? raw.text ?? '');
            effects = raw.effects;
            if (!Array.isArray(effects)) {
                warnings.push('effects 非数组，已视为空数组');
                effects = [];
            }
            return { narrate, effects, warnings };
        }
        return { narrate: '', effects: [], warnings: ['输入非字符串'] };
    }

    let text = raw.trim();

    // 1. 剥离 markdown 代码块（```json ... ``` 或 ``` ... ```）
    const codeBlockMatch = text.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
        text = codeBlockMatch[1].trim();
    }

    // 2. 尝试直接 JSON.parse
    try {
        const obj = JSON.parse(text);
        narrate = String(obj.narrate ?? '');
        effects = obj.effects;
        if (!Array.isArray(effects)) {
            warnings.push('effects 非数组，已视为空数组');
            effects = [];
        }
        return { narrate, effects, warnings };
    } catch (e) {
        // 直接解析失败，尝试提取 JSON 子串
    }

    // 3. 尝试提取第一个 { ... } 块
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
        const candidate = text.slice(start, end + 1);
        try {
            const obj = JSON.parse(candidate);
            narrate = String(obj.narrate ?? '');
            effects = obj.effects;
            if (!Array.isArray(effects)) {
                warnings.push('effects 非数组，已视为空数组');
                effects = [];
            }
            return { narrate, effects, warnings };
        } catch (e) {
            // 提取的子串也不是合法 JSON
        }
    }

    // 4. 兜底：纯文本 → 降级为「无 effects 的叙事」
    warnings.push('模型返回纯文本（无 JSON），降级为无 effects 的叙事');
    narrate = raw.trim();
    effects = [];
    return { narrate, effects, warnings };
}

/**
 * 规范化单个 effect 提议（补默认字段、校验类型）。
 * @returns {{ ok: boolean, effect?: object, error?: string }}
 */
export function normalizeEffect(eff) {
    if (!eff || typeof eff !== 'object') {
        return { ok: false, error: 'effect 不是对象' };
    }
    if (typeof eff.target !== 'string' || !eff.target) {
        return { ok: false, error: 'effect.target 缺失' };
    }
    const hasDelta = eff.delta !== undefined;
    const hasSet = eff.set !== undefined;
    if (hasDelta === hasSet) {
        return { ok: false, error: 'effect 必须且只能有 delta 或 set 之一' };
    }
    return {
        ok: true,
        effect: {
            target: eff.target,
            delta: hasDelta ? eff.delta : undefined,
            set: hasSet ? eff.set : undefined,
            reason: eff.reason ?? '',
        },
    };
}
