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
    const request = async (name, body) => {
        const response = await fetch(`/api/plugins/writer-workbench-batch/${name}`, { method: 'POST', headers: bridge.context().getRequestHeaders(), body: JSON.stringify(body) });
        if (response.status === 404) throw Error('本地批量替换模块尚未加载。请安装 plugins/writer-workbench-batch，在 config.yaml 启用 enableServerPlugins 并重启 SillyTavern。');
        return response;
    };
    return {
        host: 'st',
        async call(name, body = {}) {
            const response = await request(name, body), data = await response.json();
            if (!response.ok || data.error) throw Error(data.error || `请求失败（${response.status}）。`); return data;
        },
        async download(id) { const response = await request('download', { id }); if (!response.ok) throw Error('备份下载失败。'); return response.blob(); },
    };
}
