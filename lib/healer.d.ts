import type { AaPaths } from './paths.js';
export interface HealerState {
    /** 各类型上次自动恢复的时间戳（ms） */
    lastHealAt: Record<string, number>;
    /** 今天（本地日）已执行的自动恢复次数 */
    restartsToday: number;
    restartsDay: string;
}
export interface HealerOutcome {
    action: 'none' | 'relaunch' | 'restart';
    ok: boolean;
    pid?: number;
    detail: string;
}
/**
 * PID 身份判定·第二因子（四轮强化）：真实可执行文件（ps comm=）必须锚定到**本机安装物**：
 *  - 等于本 Doctor 发现的 uv 二进制（DSH 内置 / ~/.local/bin / PATH 命中的那个），或
 *  - 位于用户 `~/.agents-anywhere/` 树内（Connector venv 的 python 就住在
 *    `connector-venv/bin/…`，含 macOS 的 Python.app 包装路径）。
 * 任意系统的 python3/uv（如 /usr/bin/python3 跑无关脚本、并伪造完整 argv 含真实
 * config 路径）不满足任一条件——评审四轮的"准确路径伪造"样例因此被拒。
 * comm 来自内核，不受 argv 伪装影响；无法获取 → null（Fail Closed）。
 */
export declare function isConnectorExecutable(execPath: string | null, discoveredUv?: string | null, sourceDir?: string | null): boolean | null;
/**
 * PID 身份判定·第一因子（评审三轮强化）：argv 是否与"本机这台 Connector"的启动形态绑定。
 * 关键词匹配（anywhere-cli/rpc/--config）天然可被伪造——评审三轮用
 * `python3 watch-log.py /tmp/report anywhere-cli rpc --config notes.log` 同时骗过
 * argv 与 comm 两因子。因此第一因子改为绑定**本机安装唯一的 config 路径**：
 * --config 的下一个 token 必须逐字符等于本机 connector.json 的真实路径
 * （含随机目录层级，无关进程的 argv 不可能巧合命中），且存在 rpc 与
 * anywhere-cli（裸名或以 /anywhere-cli 结尾的路径形态，兼容 venv 直调）。
 * 切分失败 → null → 调用方 Fail Closed。
 */
export declare function isConnectorCommandLine(commandLine: string | null, configPath: string, sourceDir?: string): boolean | null;
export declare class Healer {
    private readonly paths;
    private readonly log;
    /** 自定义 uv 路径（对齐官方 AA 配置同名项）；留空自动发现 */
    private readonly uvPath;
    /** 评审二轮修复（新 P1）：状态只从磁盘加载一次，此后以内存为准、落盘 best-effort。
     *  此前 canHeal 每轮重读磁盘，状态文件写失败（EACCES 等）会让内存记账被清空，
     *  冷却与每日配额完全失效。内存化后，写失败仅影响跨会话持久化，会话内限流始终有效。 */
    private state;
    constructor(paths: AaPaths, log: (line: string) => void, 
    /** 自定义 uv 路径（对齐官方 AA 配置同名项）；留空自动发现 */
    uvPath?: string);
    private loadStateFromDisk;
    private saveState;
    private todayKey;
    /** 冷却与每日配额判定（wedged/exited 分开计时，共用每日配额；内存态为准） */
    canHeal(kind: string, cooldownMinutes: number, maxPerDay: number): {
        allowed: boolean;
        reason: string;
    };
    /**
     * 场景一：进程已退出且无人拉起（dsh-desktop#1334）。旧进程已死、租约自然空闲，重新拉起无冲突风险。
     * 拉起后做存活验证（等待 VERIFY_WINDOW_MS 再确认），避免"报告成功但进程立即死亡"。
     */
    relaunchExited(envKind?: string): Promise<HealerOutcome>;
    /**
     * 场景二：进程活着但卡死（#381 形态）。
     * 安全顺序：身份校验（Fail Closed）→ 预检启动条件 → SIGTERM → 必要时 SIGKILL → 拉起 → 存活验证。
     * 任何一步不满足即中止，绝不"先杀后发现拉不起来"。
     */
    restartWedged(pid: number, envKind?: string): Promise<HealerOutcome>;
    /** 双因子身份确认：argv 绑定本机安装（config 路径 + sourceDir）+ comm 锚定本机安装物。
     *  任一因子为 false → false（确认不是）；任一为 null（无法获取）→ null（Fail Closed）；
     *  双 true → true。 */
    private confirmConnectorIdentity;
    /**
     * 预检：终止旧进程前确认重新拉起的条件齐备（uv 可发现 + connector-source + connector.json）。
     * 返回 ok=false 时带具体缺失项。
     */
    private preflight;
    /**
     * 拉起后存活验证：等待 VERIFY_WINDOW_MS 再检查。
     * 覆盖两类"假成功"：spawn 的异步 error 事件（如 ENOENT）与进程启动即退出。
     */
    private verifyLaunched;
    /**
     * 拉起 Connector：主路径 = 直接构造 argv（uv + run + --directory …，空格安全）；
     * 兜底 = ps 捕获命令行切分（仅当首个 token 是真实存在的文件）。
     */
    private launch;
    private findConnectorSource;
    /** uv 候选：显式配置 → DSH NEXT 内置 @dataiku/uv → PATH 上的 uv → ~/.local/bin/uv */
    /** 评审修复 #4（三轮补组）：按当前进程的完整身份判定执行位——owner 命中查 0o100；
     *  文件 gid 命中**有效组或任一补充组**（process.getgroups() 首元素即有效 gid）查 0o010；
     *  都不命中才查 other 0o001。二轮版只比 getgid()，文件 gid 在补充组里但不在有效组时
     *  会错误落入 other 分支（如 mode 0741、file gid∈supplementary → 应按 group 的 r-- 拒绝，
     *  却被 other 的 --x 放行），重新造成"先杀后拉不起"。 */
    private isExecutableFile;
    private findUvBinary;
    /** 记账一次恢复尝试（评审修复 #5）：在动手前调用——失败的尝试同样消耗冷却与每日配额，
     *  防止"验证失败→下一轮再试"无限循环绕过限流。 */
    recordAttempt(kind: string): void;
}
//# sourceMappingURL=healer.d.ts.map