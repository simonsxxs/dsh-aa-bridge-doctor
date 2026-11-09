import os from 'node:os';
import path from 'node:path';
export function aaPaths(home = os.homedir()) {
    const aaDir = path.join(home, '.agents-anywhere');
    return {
        home,
        aaDir,
        logsDir: path.join(aaDir, 'logs'),
        runtimeRecord: path.join(aaDir, 'connector-runtime.json'),
        connectorConfig: path.join(aaDir, 'dsh-bridge-next', 'connector', 'connector.json'),
        accountJson: path.join(aaDir, 'dsh-bridge-next', 'account.json'),
        connectorSourceDir: path.join(aaDir, 'dsh-bridge-next', 'connector-source'),
        connectorOutputLog: path.join(aaDir, 'dsh-bridge-next', 'logs', 'connector-output.json'),
        doctorDir: path.join(aaDir, 'bridge-doctor'),
        doctorLog: path.join(aaDir, 'bridge-doctor', 'bridge-doctor.log'),
        doctorState: path.join(aaDir, 'bridge-doctor', 'state.json'),
    };
}
//# sourceMappingURL=paths.js.map