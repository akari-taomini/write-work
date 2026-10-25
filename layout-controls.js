export function installLayoutControls(app) {
    const panel = app.dialog, header = app.$('.ww-header'), divider = app.$('.ww-sidebar-divider');
    const key = `ww:${app.namespace}:layout`;
    let saved = {}, gesture;
    try { saved = JSON.parse(localStorage.getItem(key) || '{}'); } catch { /* Use the default layout. */ }
    const desktop = () => window.innerWidth > 760 && window.innerHeight > 500;
    const clamp = (value, min, max) => Math.max(min, Math.min(value, Math.max(min, max)));
    const remember = () => { try { localStorage.setItem(key, JSON.stringify(saved)); } catch { /* Layout remains usable without persistence. */ } };
    const width = value => {
        const maximum = Math.max(150, Math.min(600, panel.getBoundingClientRect().width - 380));
        const result = clamp(value, 150, maximum);
        panel.style.setProperty('--ww-sidebar-width', `${result}px`);
        divider.setAttribute('aria-valuenow', Math.round(result)); divider.setAttribute('aria-valuemax', Math.round(maximum));
        saved.sidebar = result;
    };
    const position = (left, top) => {
        const rect = panel.getBoundingClientRect();
        saved.left = clamp(left, 0, window.innerWidth - rect.width);
        saved.top = clamp(top, 0, window.innerHeight - rect.height);
        Object.assign(panel.style, { left: `${saved.left}px`, top: `${saved.top}px`, right: 'auto', bottom: 'auto' });
    };
    const restore = () => {
        if (!desktop()) {
            for (const name of ['left', 'top', 'right', 'bottom']) panel.style.removeProperty(name);
            return;
        }
        if (!panel.open) return;
        width(Number.isFinite(saved.sidebar) ? saved.sidebar : 196);
        if (Number.isFinite(saved.left) && Number.isFinite(saved.top)) position(saved.left, saved.top);
    };
    const start = (event, type) => {
        if (!desktop() || event.button !== 0 || app.busy || !app.$('.ww-exit').hidden) return;
        if (type === 'move' && event.target.closest('button,input,select,textarea,a,summary')) return;
        const rect = panel.getBoundingClientRect();
        gesture = { id: event.pointerId, type, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, width: app.$('.ww-sidebar').getBoundingClientRect().width };
        event.currentTarget.setPointerCapture?.(event.pointerId);
        panel.classList.add('ww-adjusting'); event.preventDefault();
    };
    header.addEventListener('pointerdown', event => start(event, 'move'));
    divider.addEventListener('pointerdown', event => start(event, 'resize'));
    const update = event => {
        if (!gesture || event.pointerId !== gesture.id || !desktop()) return;
        if (gesture.type === 'move') position(gesture.left + event.clientX - gesture.x, gesture.top + event.clientY - gesture.y);
        else width(gesture.width + event.clientX - gesture.x);
    };
    const finish = event => { if (gesture && event.pointerId === gesture.id) { gesture = null; panel.classList.remove('ww-adjusting'); remember(); } };
    for (const target of [header, divider]) {
        target.addEventListener('pointermove', update);
        for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) target.addEventListener(name, finish);
    }
    divider.addEventListener('keydown', event => {
        if (!desktop() || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault(); width((saved.sidebar || 196) + (event.key === 'ArrowRight' ? 16 : -16)); remember();
    });
    window.addEventListener('resize', restore);
    return { restore, center() {
        if (!desktop()) return;
        const rect = panel.getBoundingClientRect(); position((window.innerWidth - rect.width) / 2, (window.innerHeight - rect.height) / 2); remember();
    } };
}

