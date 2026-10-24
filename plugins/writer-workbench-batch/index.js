import { installBatchRoutes } from '../../data/default-user/extensions/write-work/batch-server.js';

export const info = { id: 'writer-workbench-batch', name: 'Writer Workbench Batch', description: 'User-scoped text replacement with previews, verified backups and conflict-aware recovery.' };
export async function init(router) { installBatchRoutes(router); }
