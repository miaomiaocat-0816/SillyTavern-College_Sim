/**
 * host.js —— 宿主依赖探测（借鉴 ILB 的多路径探测 + 全局兜底思路）
 *
 * 为什么要有这一层：SillyTavern 第三方扩展的目录深度、宿主模块的导出结构
 * 都可能随版本变化。把「从哪拿宿主符号」集中到这一个文件，用「候选路径逐个
 * 探测 + 全局兜底」的方式，而不是硬编码一层相对路径（那样换目录结构就会整
 * 个扩展挂掉——之前就踩过 4 层/3 层路径写错的坑）。
 *
 * 约定：
 *  - 本文件是前端唯一 import 宿主模块的地方
 *  - 探测结果缓存在模块级变量，init() 前先 ensureHost()
 *  - 某个符号探测不到时降级为 null，由使用方决定是否跳过，而不是直接崩
 */

/**
 * 候选路径表。第三方扩展在 public/scripts/extensions/third-party/<name>/ 下，
 * 比内置扩展深一层。这里按「最常见正确位置」到「兜底位置」排序，逐个试。
 * 用动态 import 逐条探测，命中哪条用哪条。
 */
const HOST_CANDIDATES = {
    // RossAscends-mods.js 的 dragElement（面板拖动）
    raMods: [
        '../../../RossAscends-mods.js',        // 第三方扩展最常见正确位置
        '../../../../scripts/RossAscends-mods.js',
        '/scripts/RossAscends-mods.js',
    ],
    // script.js 的 prompt 注入 + 系统消息枚举
    script: [
        '../../../../script.js',               // 第三方扩展里的 script.js
        '../../../script.js',
        '/script.js',
    ],
    // 斜杠命令三个模块
    slashParser: [
        '../../../../scripts/slash-commands/SlashCommandParser.js',
        '/scripts/slash-commands/SlashCommandParser.js',
    ],
    slashCommand: [
        '../../../../scripts/slash-commands/SlashCommand.js',
        '/scripts/slash-commands/SlashCommand.js',
    ],
    slashArg: [
        '../../../../scripts/slash-commands/SlashCommandArgument.js',
        '/scripts/slash-commands/SlashCommandArgument.js',
    ],
};

/** 缓存：探测结果（符号引用） */
let cache = null;

/** 从已 import 成功的模块里，挨个 key 找可用的导出 */
function pick(modules, keys) {
    for (const key of keys) {
        for (const mod of modules) {
            const v = mod?.[key] ?? mod?.default?.[key];
            if (v !== undefined && v !== null) return v;
        }
    }
    return null;
}

/**
 * 探测一组候选路径，返回所有成功 import 的模块。
 * 路径不对就试下一个（预期内的探测，不报错）。
 */
async function tryImport(paths) {
    const modules = [];
    for (const p of paths) {
        try {
            const mod = await import(/* @vite-ignore */ p);
            modules.push(mod);
        } catch {
            // 路径不对，试下一个
        }
    }
    return modules;
}

/**
 * 从全局兜底拿宿主符号（有些版本的 ST 或某些安装方式会挂到全局）。
 * 返回命中的键集合。
 */
function pickGlobals() {
    const g = globalThis;
    const out = {};
    if (typeof g.SillyTavern?.getContext === 'function') out.getContext = g.SillyTavern.getContext;
    if (typeof g.dragElement === 'function') out.dragElement = g.dragElement;
    if (g.extension_prompt_types) out.extension_prompt_types = g.extension_prompt_types;
    if (g.extension_prompt_roles) out.extension_prompt_roles = g.extension_prompt_roles;
    if (typeof g.setExtensionPrompt === 'function') out.setExtensionPrompt = g.setExtensionPrompt;
    if (g.system_message_types) out.system_message_types = g.system_message_types;
    if (g.SlashCommandParser) out.SlashCommandParser = g.SlashCommandParser;
    if (g.SlashCommand) out.SlashCommand = g.SlashCommand;
    if (g.SlashCommandArgument) out.SlashCommandArgument = g.SlashCommandArgument;
    return out;
}

/**
 * 确保宿主符号已就绪（幂等，成功一次后不再重复探测）。
 * @returns {Promise<object>} 各符号的引用（探测不到的为 null）
 */
export async function ensureHost() {
    if (cache) return cache;

    const result = {
        // 由 ST 通过 hooks/全局提供（getContext 在 index.js 里已直接用全局）
        getContext: null,
        dragElement: null,
        extension_prompt_types: null,
        extension_prompt_roles: null,
        setExtensionPrompt: null,
        system_message_types: null,
        SlashCommandParser: null,
        SlashCommand: null,
        SlashCommandArgument: null,
        via: [],
    };

    // 1) 模块探测
    const [raMods, script, slashParser, slashCommand, slashArg] = await Promise.all([
        tryImport(HOST_CANDIDATES.raMods),
        tryImport(HOST_CANDIDATES.script),
        tryImport(HOST_CANDIDATES.slashParser),
        tryImport(HOST_CANDIDATES.slashCommand),
        tryImport(HOST_CANDIDATES.slashArg),
    ]);

    result.dragElement = pick(raMods, ['dragElement']);
    result.extension_prompt_types = pick(script, ['extension_prompt_types']);
    result.extension_prompt_roles = pick(script, ['extension_prompt_roles']);
    result.setExtensionPrompt = pick(script, ['setExtensionPrompt']);
    result.system_message_types = pick(script, ['system_message_types']);
    result.SlashCommandParser = pick(slashParser, ['SlashCommandParser']);
    result.SlashCommand = pick(slashCommand, ['SlashCommand']);
    result.SlashCommandArgument = pick(slashArg, ['SlashCommandArgument']);

    // 2) 全局兜底（模块探测没命中的，用全局补）
    const globals = pickGlobals();
    for (const key of Object.keys(result)) {
        if (key === 'via') continue;
        if (!result[key] && globals[key]) {
            result[key] = globals[key];
            result.via.push(`${key}(global)`);
        } else if (result[key]) {
            result.via.push(`${key}(module)`);
        }
    }
    // getContext 也兜底（globals 已由 pickGlobals 修正为 SillyTavern.getContext）
    if (typeof globals.getContext === 'function') {
        result.getContext = globals.getContext;
    }

    cache = result;
    return result;
}

/**
 * 报告探测结果（诊断用）。
 * @returns {string} 形如 "dragElement(module), setExtensionPrompt(module), ..."
 */
export function describeHost() {
    if (!cache) return '未探测';
    return cache.via.join(', ') || '无命中';
}

/** 供测试/热重载清除缓存 */
export function resetHost() {
    cache = null;
}
