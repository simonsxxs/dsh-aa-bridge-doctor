import z from '@deepseek-ai/schemastery';
export interface Config {
    enabled?: boolean;
    uvPath?: string;
    autoRestartExited?: boolean;
    autoRestartWedged?: boolean;
    failureThreshold?: number;
    windowMinutes?: number;
    logSilenceMinutes?: number;
    cooldownMinutes?: number;
    maxRestartsPerDay?: number;
    pollSeconds?: number;
    checkDeviceApi?: boolean;
}
export declare const Config: z<Config>;
//# sourceMappingURL=config.d.ts.map