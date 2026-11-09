/** Agents Anywhere 本机数据布局（与官方插件约定一致，见 dsh-bridge-next TECHNICAL.md） */
export interface AaPaths {
    home: string;
    aaDir: string;
    logsDir: string;
    runtimeRecord: string;
    connectorConfig: string;
    accountJson: string;
    connectorSourceDir: string;
    connectorOutputLog: string;
    doctorDir: string;
    doctorLog: string;
    doctorState: string;
}
export declare function aaPaths(home?: string): AaPaths;
//# sourceMappingURL=paths.d.ts.map