/**
 * university-sim 后端 Server 插件入口
 *
 * 架构（M1 已完成部分）：
 *  - lib/bus.js        状态总线（唯一真值 + JSON 落盘 + 串行化写入）
 *  - lib/time-engine.js 时间引擎（RP 时间推进 + 倍率/暂停）
 *  - routes/index.js   统一路由（GET /state、POST /time、POST /tick）
 *
 * 铁律：
 *  R1 真值只在后端内存 + JSON
 *  R2 所有写操作走 bus.mutate()
 *  R6 不修改 ST 仓库内任何文件（本插件目录被 .gitignore 忽略）
 */

import { registerRoutes } from './routes/index.js';
import { stopAll } from './lib/time-engine.js';

export const info = {
    id: 'university-sim',
    name: 'University Sim',
    description: '大学生活模拟 RP 框架：时间、物品、快递、课程、好感与事件仲裁',
};

/** @param {import('express').Router} router */
export async function init(router) {
    registerRoutes(router);
    console.log(`[university-sim] init() 完成，路由前缀 /api/plugins/${info.id}`);
}

export async function exit() {
    stopAll(); // 清理所有时间引擎定时器（铁律：定时器必须清理，否则 ST 无法正常退出）
    console.log('[university-sim] exit() 调用，定时器已清理');
}
