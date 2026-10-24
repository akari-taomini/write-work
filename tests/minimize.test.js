import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.__WW_TEST__ = true;
const { Workbench } = await import('../index.js');

function fixture({ popover = true } = {}) {
    const app = Object.create(Workbench.prototype);
    const button = app.resumeButton = {
        hidden: true, style: {}, open: false,
        getBoundingClientRect: () => ({ width: 45, height: 45 }),
        matches: () => button.open,
    };
    if (popover) {
        button.showPopover = () => { assert.equal(button.hidden, false); button.open = true; };
        button.hidePopover = () => { button.open = false; };
    } else button.matches = () => { throw Error('Popover selector unsupported'); };
    return app;
}

test('minimize exposes the resume shortcut after saving and closing, and reopening hides its top layer', async () => {
    const app = fixture(), calls = [];
    globalThis.window = { innerWidth: 390, innerHeight: 844 };
    app.persist = async () => calls.push('draft');
    app.persistWriting = async () => calls.push('writing');
    app.designer = { loaded: true, persist: async () => calls.push('designer'), cancel: () => {} };
    app.lab = { persist: async () => calls.push('lab') };
    app.cancelPreview = () => {};
    app.dialog = { close: () => calls.push('close'), show: () => calls.push('show') };
    app.syncTheme = app.renderCardChoices = app.schedulePreview = app.designer.schedule = () => {};
    app.layout = { restore: () => {} };
    await app.minimize();
    assert.deepEqual(calls, ['draft', 'writing', 'designer', 'lab', 'close']);
    assert.equal(app.minimized, true); assert.equal(app.resumeButton.hidden, false); assert.equal(app.resumeButton.open, true);
    await app.open();
    assert.equal(app.minimized, false); assert.equal(app.resumeButton.hidden, true); assert.equal(app.resumeButton.open, false);
});

test('resume stays in the visible viewport after keyboard, panning and orientation changes', () => {
    const app = fixture();
    globalThis.window = { innerWidth: 390, innerHeight: 844, visualViewport: { width: 390, height: 380, offsetTop: 110, offsetLeft: 0 } };
    app.showResume(true);
    assert.equal(app.resumeButton.style.top, '365px'); assert.equal(app.resumeButton.style.left, '333px');
    window.visualViewport = { width: 844, height: 390, offsetTop: 0, offsetLeft: 25 };
    app.positionResume();
    assert.equal(app.resumeButton.style.top, '265px'); assert.equal(app.resumeButton.style.left, '812px');
});

test('older webviews without Popover retain a visible fixed shortcut and can hide it safely', () => {
    const app = fixture({ popover: false });
    globalThis.window = { innerWidth: 390, innerHeight: 844 };
    app.showResume(true); assert.equal(app.resumeButton.hidden, false); assert.equal(app.resumeButton.style.top, '719px');
    app.showResume(false); assert.equal(app.resumeButton.hidden, true);
});
