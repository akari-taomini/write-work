export function batchHost(host = globalThis) {
    if (host.__TAURITAVERN__ || host.__TAURI_RUNNING__ === true) return 'tt';
    if (host.__TAURI_INTERNALS__ || host.__TAURI__) throw Error('无法确认当前 Tauri 宿主，已停止选择批量读写接口。');
    return 'st';
}

export async function createBatchClient(bridge) {
    if (batchHost() === 'tt') {
        const { TtBatchService } = await import('./batch-tt.js');
        const service = new TtBatchService({ context: () => bridge.context() });
        await service.init(); return service;
    }
    // Stock SillyTavern exposes safe per-resource APIs. A browser adapter
    // avoids forcing users to install a privileged Node server plugin.
    const { StBatchService } = await import('./batch-st.js');
    const service = new StBatchService({ context: () => bridge.context() });
    await service.init();
    return service;
}
