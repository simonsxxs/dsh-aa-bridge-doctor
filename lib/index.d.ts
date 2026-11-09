import type { Context } from '@deepseek-ai/cordis';
import { Config, type Config as ConfigType } from './config.js';
import { type AaPaths } from './paths.js';
export { Config };
export declare const name = "dsh-aa-bridge-doctor";
export declare function apply(ctx: Context, config: ConfigType): (() => void) | undefined;
/** 可注入路径的核心启动逻辑（便于测试与复用） */
export declare function startDoctor(config: ConfigType, paths: AaPaths, registerDispose?: (cleanup: () => void) => void): () => void;
/** 纯函数：日志是否需要轮转（超过上限滚动为 .1 单备份） */
export declare function shouldRotateLog(sizeBytes: number): boolean;
export declare function appendLog(file: string, line: string): void;
//# sourceMappingURL=index.d.ts.map