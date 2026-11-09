export declare function isAlive(pid: number): Promise<boolean>;
/** 捕获进程的真实可执行文件路径（macOS `ps -o comm=`）——不受 argv 伪装影响，
 *  是身份校验的第二因子（argv 可被带空格的文件名伪造，comm 不行）。 */
export declare function getExecutablePath(pid: number): Promise<string | null>;
/** 捕获进程的完整启动命令行（macOS `ps -ww -o command=`）。注意：仅用于日志诊断，
 *  输出不还原引号，路径含空格时不可安全切分 —— 重启请用 spawnDetached 构造 argv。 */
export declare function getCommandLine(pid: number): Promise<string | null>;
/** 极简 shell 词法切分（支持成对单/双引号）。仅作 ps 命令行的兜底解析，且必须校验 args[0] 存在 */
export declare function splitCommandLine(line: string): string[] | null;
export interface RelaunchResult {
    ok: boolean;
    pid?: number;
    error?: string;
}
/**
 * 以分离进程方式直接 spawn（argv 数组，不经 shell —— 路径含空格也安全）。
 * 必须挂 error 监听：spawn 的失败（如 ENOENT）以异步 error 事件到达，
 * 不监听会导致未捕获异常崩溃宿主；进程死亡本身由调用方的存活验证兜底。
 */
export declare function spawnDetached(prog: string, args: string[], env: Record<string, string>): RelaunchResult;
/** ps 命令行兜底路径：切分后校验 args[0] 真实存在才返回（防空格切坏） */
export declare function safeArgsFromCommandLine(commandLine: string): string[] | null;
/**
 * 优雅终止：先 SIGTERM，等待最多 10 秒，仍存活则 SIGKILL。
 * 评审修复 #3：传入 verify 时，SIGKILL 前复核进程身份——SIGTERM 后 PID 若被
 * 复用为无关进程，绝不升级到 SIGKILL（返回 'identity-lost'）。
 */
export declare function terminate(pid: number, verify?: (pid: number) => Promise<boolean>): Promise<'exited' | 'killed' | 'not-running' | 'identity-lost'>;
//# sourceMappingURL=process.d.ts.map