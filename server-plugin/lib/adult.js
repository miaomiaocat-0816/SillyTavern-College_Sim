/**
 * 成人内容模块（M6-1）
 *
 * 铁律 R5：本模块由 enable_adult_events 单一开关控制，
 *          关闭时本模块不应被 require（由调用方用 isAdultEnabled() 门控）。
 *
 * 设计：本模块本身是「内容元数据 + 过滤器」，不包含任何露骨文本。
 *  - ADULT_ITEM_TAGS：打上这些标签的物品在开关关闭时不出现在商品列表
 *  - ADULT_EVENT_TYPES：这些事件类型在开关关闭时不在事件池
 *  - adultItemFilter(items)：过滤函数，供物品列表路由调用
 *  - adultEventFilter(events)：过滤函数，供事件池调用
 *
 * 注意：实际「内容」由使用者在物品模板/世界书/角色卡中自行配置，
 *       本框架只提供「开关 + 过滤」这一层机制，不含任何内置成人内容。
 */

/** 成人相关物品标签（物品模板可带 tag 字段，命中则视为成人向） */
export const ADULT_ITEM_TAGS = ['adult'];

/** 成人相关事件类型前缀（事件 type 命中前缀则视为成人向） */
export const ADULT_EVENT_PREFIXES = ['adult_'];

/**
 * 过滤物品模板列表：开关关闭时剔除带成人标签的物品。
 * @param {Array} items 物品模板数组
 * @param {boolean} adultEnabled 开关状态
 * @returns {Array}
 */
export function adultItemFilter(items, adultEnabled) {
    if (adultEnabled) return items;
    return items.filter(it => {
        const tags = it?.tags;
        if (!Array.isArray(tags)) return true;
        return !tags.some(t => ADULT_ITEM_TAGS.includes(t));
    });
}

/**
 * 过滤事件队列：开关关闭时剔除成人向事件。
 * @param {Array} events 事件数组
 * @param {boolean} adultEnabled 开关状态
 * @returns {Array}
 */
export function adultEventFilter(events, adultEnabled) {
    if (adultEnabled) return events;
    return events.filter(e => {
        const type = e?.type || '';
        return !ADULT_EVENT_PREFIXES.some(p => type.startsWith(p));
    });
}
