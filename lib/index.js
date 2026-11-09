import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Config } from './config.js';
import { aaPaths } from './paths.js';
import { classify } from './detector.js';
import { scanRecentFailures } from './logscan.js';
import { isAlive } from './process.js';
import { notify } from './notifier.js';
import { Healer } from './healer.js';
import { readAccount, readConnectorId, fetchDeviceStatus, fetchDshRuntime, findStuckDshRuntime } from './device.js';
import { readLastProcessExit, shouldAutoRelaunchExited } from './exitlog.js';
export { Config };
export const name = 'dsh-aa-bridge-doctor';
const DEFAULTS = {
    failureThreshold: 4,
    windowMinutes: 10,
    logSilenceMinutes: 15,
    cooldownMinutes: 60,
    maxRestartsPerDay: 6,
    pollSeconds: 30,
    stuckStartingMinutes: 15,
    deviceOfflineStreak: 3,
    deviceOfflineNotifyCooldownMs: 10 * 60_000,
    healthyHeartbeatMs: 60 * 60_000,
};
export function apply(ctx, config) {
    if (!config.enabled)
        return;
    return startDoctor(config, aaPaths(), (cleanup) => {
        // 兜底：fork 的 typed 事件 internal/status —— fiber 进入 DISPOSED(4) 时触发清理
        ctx.on('internal/status', ((fiber) => {
            if (fiber?.state === 4)
                cleanup();
        }));
    });
}
/** 可注入路径的核心启动逻辑（便于测试与复用） */
export function startDoctor(config, paths, registerDispose) {
    const healer = new Healer(paths, (line) => appendLog(paths.doctorLog, line), config.uvPath ?? '');
    const settings = {
        failureThreshold: config.failureThreshold ?? DEFAULTS.failureThreshold,
        windowMinutes: config.windowMinutes ?? DEFAULTS.windowMinutes,
        logSilenceMinutes: config.logSilenceMinutes ?? DEFAULTS.logSilenceMinutes,
        cooldownMinutes: config.cooldownMinutes ?? DEFAULTS.cooldownMinutes,
        maxRestartsPerDay: config.maxRestartsPerDay ?? DEFAULTS.maxRestartsPerDay,
        pollSeconds: Math.max(10, config.pollSeconds ?? DEFAULTS.pollSeconds),
        checkDeviceApi: config.checkDeviceApi ?? false,
        stuckStartingMinutes: DEFAULTS.stuckStartingMinutes,
    };
    // DSH Runtime 卡「正在同步」的首次观测时间（会话内存即可）
    const startingSeen = new Map();
    const stuckNotified = new Set();
    // 云端交叉验证的连续离线计数与提醒冷却（会话内存）
    const offlineTracker = { streak: 0, lastNotifyAt: 0 };
    // healthy 日志降噪：仅状态变化 + 每小时心跳
    const healthLog = { lastState: 'not-installed', lastHealthyLogAt: 0 };
    appendLog(paths.doctorLog, `Bridge Doctor 启动 exited=${config.autoRestartExited ? 'auto' : 'notify'} wedged=${config.autoRestartWedged ? 'auto' : 'notify'} poll=${settings.pollSeconds}s window=${settings.windowMinutes}m threshold=${settings.failureThreshold}`);
    let busy = false;
    let cleaned = false;
    const cleanup = () => {
        if (cleaned)
            return;
        cleaned = true;
        clearInterval(timer);
        clearTimeout(firstRun);
        appendLog(paths.doctorLog, 'Bridge Doctor 停止');
    };
    // 卸载兜底注册（幂等）：apply 传入 ctx.on('internal/status') 实现
    registerDispose?.(cleanup);
    // 实例标记（newest-wins 自退役）：不依赖 cordis 的卸载语义。
    // 配置更新/重载产生更新实例时，旧实例在下一个检查轮自行退出，避免双跑。
    const instanceId = randomUUID();
    const startedAt = Date.now();
    const instanceMarker = path.join(paths.doctorDir, 'instance.json');
    try {
        fs.mkdirSync(paths.doctorDir, { recursive: true });
        fs.writeFileSync(instanceMarker, JSON.stringify({ instanceId, pid: process.pid, startedAt: Date.now() }));
    }
    catch {
        /* 标记失败不影响主流程 */
    }
    const tick = async () => {
        if (busy)
            return;
        busy = true;
        try {
            // 自退役检查：存在更新的实例 → 让位
            try {
                const m = JSON.parse(fs.readFileSync(instanceMarker, 'utf8'));
                if (m?.instanceId !== instanceId && (m?.startedAt ?? 0) > Date.now() - 5 * 60_000 && (m?.startedAt ?? 0) > startedAt) {
                    appendLog(paths.doctorLog, `检测到更新的 Doctor 实例（${m.instanceId}），本实例自行退出`);
                    cleanup();
                    return;
                }
            }
            catch {
                /* 标记读取失败按无更新处理 */
            }
            await runOnce(config, settings, paths, healer, offlineTracker, healthLog);
            if (settings.checkDeviceApi) {
                await checkDshRuntimeStuck(paths, startingSeen, stuckNotified);
            }
        }
        catch (err) {
            appendLog(paths.doctorLog, `检查轮出错: ${err instanceof Error ? err.stack : String(err)}`);
        }
        finally {
            busy = false;
        }
    };
    const timer = setInterval(() => void tick(), settings.pollSeconds * 1_000);
    const firstRun = setTimeout(() => void tick(), 8_000);
    // cordis 标准机制：apply 返回的 disposer 在 fiber 卸载时执行（幂等，与兜底并存）
    return cleanup;
}
async function runOnce(config, settings, paths, healer, offlineTracker, healthLog) {
    // 1) 共享运行记录（未安装/未授权时不存在）
    let runtimeRecord = null;
    try {
        runtimeRecord = JSON.parse(fs.readFileSync(paths.runtimeRecord, 'utf8'));
    }
    catch {
        /* ignore */
    }
    const recordExists = runtimeRecord !== null;
    const pid = runtimeRecord?.runtime?.pid;
    // 2) 进程存活
    const processAlive = pid !== undefined ? await isAlive(pid) : false;
    // 3) 窗口内失败计数 + 日志新鲜度
    const scan = scanRecentFailures(paths.logsDir, settings.windowMinutes);
    const newestLogAgeMin = scan.newestLogTime !== null ? (Date.now() - Date.parse(scan.newestLogTime)) / 60_000 : null;
    // 4) 判定（纯函数）
    const verdict = classify({
        runtimeRecordExists: recordExists,
        processAlive,
        failuresInWindow: scan.failures,
        failureThreshold: settings.failureThreshold,
        newestLogAgeMin,
        logSilenceMinutes: settings.logSilenceMinutes,
    });
    if (verdict.state === 'not-installed')
        return;
    // 4.1) 云端交叉验证（checkDeviceApi 开启时）：本机判定 healthy 但云端设备离线
    //      连续 N 次（≈N×pollSeconds）→ 提醒"疑似路由/代理问题"（不自动重启——
    //      该形态重启无益，需用户检查网络路径）
    if (verdict.state === 'healthy' && settings.checkDeviceApi) {
        const account = readAccount(paths);
        const cid = readConnectorId(paths);
        if (account && cid) {
            const dev = await fetchDeviceStatus(account.apiBaseUrl, account.accessToken, cid);
            if (dev && dev.online === false && processAlive) {
                offlineTracker.streak += 1;
                if (offlineTracker.streak >= DEFAULTS.deviceOfflineStreak &&
                    Date.now() - offlineTracker.lastNotifyAt > DEFAULTS.deviceOfflineNotifyCooldownMs) {
                    offlineTracker.lastNotifyAt = Date.now();
                    appendLog(paths.doctorLog, `云端交叉验证: 设备离线已连续 ${offlineTracker.streak} 次检查，但本机日志无失败（疑似路由/代理问题，重启 Connector 无益）`);
                    notify('AA Bridge Doctor', '云端显示设备离线，但本机未检测到鉴权失败——疑似本机到服务器的路由/代理问题。请检查代理后打开 AA 面板重启 Connector。');
                }
            }
            else if (dev && dev.online === true) {
                offlineTracker.streak = 0;
            }
        }
    }
    if (verdict.state === 'healthy') {
        // 日志降噪：仅在状态从不健康→健康变化时记录，或每小时一条心跳
        const now = Date.now();
        if (healthLog.lastState !== 'healthy') {
            appendLog(paths.doctorLog, `恢复正常: 进程=存活 近${settings.windowMinutes}分钟失败=${scan.failures} 日志新鲜度=${newestLogAgeMin !== null ? Math.round(newestLogAgeMin) + '分钟前' : '未知'}`);
            healthLog.lastHealthyLogAt = now;
        }
        else if (now - healthLog.lastHealthyLogAt >= DEFAULTS.healthyHeartbeatMs) {
            appendLog(paths.doctorLog, `检查正常（每小时心跳）: 进程=存活 近${settings.windowMinutes}分钟失败=${scan.failures}`);
            healthLog.lastHealthyLogAt = now;
        }
        healthLog.lastState = 'healthy';
        return;
    }
    healthLog.lastState = verdict.state;
    // 5) 冷却/配额 + 模式开关
    const kind = verdict.state;
    const gate = healer.canHeal(kind, settings.cooldownMinutes, settings.maxRestartsPerDay);
    let autoEnabled = verdict.state === 'exited' ? config.autoRestartExited : config.autoRestartWedged;
    // 5.1) exited 场景的「新鲜退出」护栏：刚退出（<10 分钟）多半是用户主动停止或插件受控重启，
    //      自动拉起会与人对着干；只有陈旧死亡（死了很久没人处理）才值得自动拉起（#1334 场景）。
    let exitGuardReason = null;
    if (verdict.state === 'exited') {
        const exitInfo = readLastProcessExit(paths.connectorOutputLog);
        const guard = shouldAutoRelaunchExited(exitInfo, Date.now());
        if (!guard.auto) {
            autoEnabled = false;
            exitGuardReason = guard.reason;
        }
    }
    appendLog(paths.doctorLog, `检测到 ${verdict.state}: ${verdict.reason} | 近${settings.windowMinutes}分钟失败=${scan.failures} 最后失败=${scan.lastFailureAt ?? '-'} | 自动恢复=${autoEnabled && gate.allowed ? '执行' : `跳过（${autoEnabled ? gate.reason : '模式未开启'}${exitGuardReason ? `；${exitGuardReason}` : ''}）`}`);
    // 6) 行动
    if (autoEnabled && gate.allowed) {
        const outcome = verdict.state === 'exited'
            ? await healer.relaunchExited()
            : pid !== undefined
                ? await healer.restartWedged(pid)
                : { action: 'none', ok: false, detail: '运行记录缺少 pid，无法重启' };
        notify('AA Bridge Doctor', `检测到桥接${verdict.state === 'exited' ? '进程退出' : '卡死'}，自动恢复${outcome.ok ? '成功' : '失败'} ${outcome.detail}`);
        appendLog(paths.doctorLog, `恢复结果: ${outcome.ok ? '成功' : '失败'} ${outcome.detail}`);
        if (!outcome.ok) {
            notify('AA Bridge Doctor', `自动恢复失败：${outcome.detail}。请打开 AA 插件面板手动「重启 Connector」。`);
        }
        return;
    }
    // 仅提醒
    notify('AA Bridge Doctor', verdict.state === 'exited'
        ? 'AA Connector 进程已退出且未拉起，手机端将持续离线。请打开 AA 插件面板点「启动 Connector」。'
        : `AA 桥接疑似卡死（近${settings.windowMinutes}分钟失败 ${scan.failures} 次，进程存活）。请打开 AA 插件面板点「重启 Connector」。`);
}
const LOG_ROTATE_BYTES = 512 * 1024;
/** 纯函数：日志是否需要轮转（超过上限滚动为 .1 单备份） */
export function shouldRotateLog(sizeBytes) {
    return sizeBytes > LOG_ROTATE_BYTES;
}
export function appendLog(file, line) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // 注意：文件不存在是常态（首次运行），statSync 必须放在 existsSync 守卫内，否则首写被吞
        if (fs.existsSync(file) && shouldRotateLog(fs.statSync(file).size)) {
            fs.renameSync(file, `${file}.1`);
        }
        fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`);
    }
    catch {
        /* 日志失败不影响主流程 */
    }
}
/** #501 形态检测：DSH Runtime 卡「正在同步 DSH 会话…」超过阈值 → 通知恢复指引（只提醒，不动状态） */
async function checkDshRuntimeStuck(paths, startingSeen, stuckNotified) {
    const account = readAccount(paths);
    const cid = readConnectorId(paths);
    if (!account || !cid)
        return;
    const snap = await fetchDshRuntime(account.apiBaseUrl, account.accessToken, cid);
    const stuck = findStuckDshRuntime(snap, startingSeen, Date.now(), DEFAULTS.stuckStartingMinutes);
    if (!stuck) {
        // 恢复正常后允许下次再提醒
        if (snap && stuckNotified.has(snap.runtimeId) && snap.status !== 'starting')
            stuckNotified.delete(snap.runtimeId);
        return;
    }
    const key = `${stuck.runtimeId}:${new Date().toDateString()}`;
    if (stuckNotified.has(key))
        return;
    stuckNotified.add(key);
    appendLog(paths.doctorLog, `检测到 DSH Runtime 卡「正在同步」runtimeId=${stuck.runtimeId} 已持续 ${stuck.stuckMinutes} 分钟（#501 形态）`);
    notify('AA Bridge Doctor', `DSH Runtime 卡在「正在同步 DSH 会话…」已 ${stuck.stuckMinutes} 分钟。请在手机/网页设备页对 DeepSeek Harness 重新「一键配置」（重建 runtime 实例即可恢复）。`);
}
//# sourceMappingURL=index.js.map