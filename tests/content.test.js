/**
 * Test suite for content.js — runs on JavaScriptCore (no Node required).
 *
 *   Run from the project root:
 *     osascript -l JavaScript tests/content.test.js
 *
 * It stands up a configurable fake DOM + chrome API, loads content.js (which
 * hands its internals to `__shejaTestHook`), then unit-tests every pure helper
 * and behaviourally tests every module. Exits non-zero if any assertion fails.
 */
ObjC.import('Foundation');
ObjC.import('stdlib');

// ── Assertion harness ─────────────────────────────────────────────────────────
var RESULTS = [], PASS = 0, FAIL = 0, GROUP = '';
function rec(good, name, detail) {
    if (good) { PASS++; RESULTS.push('  ok   ' + name); }
    else { FAIL++; RESULTS.push('  FAIL ' + name + (detail ? '  ::  ' + detail : '')); }
}
function group(g) { GROUP = g; RESULTS.push('\n[' + g + ']'); }
function ok(name, cond, detail) { rec(!!cond, name, detail); }
function eq(name, actual, expected) {
    var a = JSON.stringify(actual), e = JSON.stringify(expected);
    rec(a === e, name, a + ' !== ' + e);
}
function test(name, fn) { try { fn(); } catch (e) { rec(false, name + ' (threw)', e.message + ' | ' + String(e.stack || '').split('\n')[1]); } }
async function atest(name, fn) { try { await fn(); } catch (e) { rec(false, name + ' (threw)', e.message); } }

// ── Fake DOM ──────────────────────────────────────────────────────────────────
var DOM;
var RECT_CALLS = 0;   // getBoundingClientRect calls (layout-forcing reads)
var IMG_SCANS = 0;    // querySelectorAll('img') passes
function resetDOM() {
    DOM = { buttons: [], imgs: [], inputs: [], loaders: [], textEls: [] };
    _elCache = {};
}
function resetCounters() { RECT_CALLS = 0; IMG_SCANS = 0; _rafs = 0; _timeouts = 0; }
function R(o) { // rect factory with sensible visible defaults
    return Object.assign({ width: 120, height: 40, top: 100, left: 100, bottom: 140, right: 220 }, o || {});
}
function mkEl(tag, opts) {
    opts = opts || {};
    var handlers = {};
    var el = {
        tagName: (tag || 'div').toUpperCase(),
        style: {}, dataset: {}, _children: [], _clicked: false, _dispatched: false,
        disabled: !!opts.disabled, readOnly: !!opts.readOnly, isConnected: opts.isConnected !== false,
        textContent: opts.text || '', innerText: opts.text || '', value: opts.value || '',
        tabIndex: 0, title: '', type: opts.type || '', className: '', id: opts.id || '',
        _rect: opts.rect || R(), _overlay: !!opts.overlay,
        classList: {
            _s: {},
            add() { for (var i = 0; i < arguments.length; i++) this._s[arguments[i]] = 1; },
            remove() { for (var i = 0; i < arguments.length; i++) delete this._s[arguments[i]]; },
            toggle(c, f) { var on = f === undefined ? !this._s[c] : f; if (on) this._s[c] = 1; else delete this._s[c]; return on; },
            contains(c) { return !!this._s[c]; }
        },
        set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html || ''; },
        addEventListener(t, fn) { (handlers[t] = handlers[t] || []).push(fn); },
        removeEventListener() {},
        dispatchEvent() { this._dispatched = true; return true; },
        appendChild(c) { this._children.push(c); return c; },
        removeChild() {}, remove() {},
        setAttribute() {}, getAttribute() { return null; },
        focus() {}, click() { this._clicked = true; }, scrollIntoView() {},
        getBoundingClientRect() { RECT_CALLS++; return this._rect; },
        closest(sel) {
            if (this._overlay && /qa-overlay/.test(sel)) return { id: 'qa-overlay' };
            if (opts.closest) return opts.closest(sel);
            return null;
        },
        contains() { return false; },
        querySelector(sel) { return qsel(sel); },
        querySelectorAll(sel) { return (opts.qsa ? opts.qsa(sel) : []); },
        _handlers: handlers
    };
    return el;
}
var _elCache = {};
function keyFor(s) { return String(s).replace(/^[#.]/, ''); }
function qsel(sel) { var k = keyFor(sel); return _elCache[k] || (_elCache[k] = mkEl('div')); }
function qsa(sel) {
    var s = String(sel);
    if (/progressbar|loader|skeleton|spinner/.test(s)) return DOM.loaders;
    if (/input|textarea|contenteditable/.test(s)) return DOM.inputs;
    if (/\bimg\b/.test(s)) { IMG_SCANS++; return DOM.imgs; }
    if (/button|role='button'|role='option'/.test(s)) return DOM.buttons;
    if (/h1|h2|h3/.test(s)) return DOM.textEls;
    return [];
}

var _timeouts = 0, _rafs = 0;
function installEnv() {
    resetDOM();
    globalThis.window = {
        innerWidth: 1000, innerHeight: 800,
        HTMLInputElement: { prototype: {} }, HTMLTextAreaElement: { prototype: {} }
    };
    globalThis.performance = { now() { return Date.now(); } };
    globalThis.setTimeout = function (fn) { if (++_timeouts > 5000) return 0; try { fn(); } catch (e) {} return _timeouts; };
    globalThis.clearTimeout = function () {};
    globalThis.requestAnimationFrame = function (fn) { if (++_rafs > 5000) return 0; try { fn(Date.now()); } catch (e) {} return _rafs; };
    globalThis.cancelAnimationFrame = function () {};
    globalThis.setInterval = function () { return 1; };
    globalThis.clearInterval = function () {};
    var ss = {};
    globalThis.sessionStorage = { getItem(k) { return k in ss ? ss[k] : null; }, setItem(k, v) { ss[k] = String(v); }, removeItem(k) { delete ss[k]; } };
    globalThis.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
    function FE(t, o) { this.type = t; if (o) for (var k in o) this[k] = o[k]; }
    globalThis.Event = FE; globalThis.MouseEvent = FE; globalThis.PointerEvent = FE; globalThis.KeyboardEvent = FE;
    globalThis.MutationObserver = function (cb) { this._cb = cb; this.observe = function () {}; this.disconnect = function () {}; };

    var body = mkEl('body'); body.contains = function () { return true; };
    globalThis.document = {
        readyState: 'loading', // suppress auto-boot; we instantiate Orchestrator manually
        body: body, head: mkEl('head'), documentElement: mkEl('html'),
        addEventListener() {}, removeEventListener() {},
        createElement(t) { return mkEl(t); },
        createTextNode(s) { var n = mkEl('#text'); n.textContent = s; return n; },
        getElementById(id) { return qsel(id); },
        querySelector(sel) { return qsel(sel); },
        querySelectorAll(sel) { return qsa(sel); }
    };
    installChrome();
}

// Configurable chrome stub: queue responses per action + record calls.
var CHROME;
function installChrome() {
    CHROME = { calls: [], askAI: [], screenshot: { dataUrl: 'data:image/jpeg;base64,QUJD' }, storage: {} };
    globalThis.chrome = {
        runtime: {
            lastError: undefined,
            sendMessage(msg, cb) {
                CHROME.calls.push(msg);
                if (msg.action === 'takeScreenshot') { cb(CHROME.screenshot); return; }
                if (msg.action === 'askAI') {
                    var r = CHROME.askAI.length ? CHROME.askAI.shift() : { error: 'no canned response' };
                    cb(r); return;
                }
                cb({});
            }
        },
        storage: { local: { get(keys, cb) { cb(CHROME.storage); }, set(o, cb) { Object.assign(CHROME.storage, o); if (cb) cb(); } } }
    };
}
function askCalls() { return CHROME.calls.filter(c => c.action === 'askAI'); }
// Drain many microtask ticks so a multi-await promise chain (Solver → Orchestrator) settles.
async function flush(n) { for (var i = 0; i < (n || 30); i++) await Promise.resolve(); }

// ── Load content.js and grab its internals ────────────────────────────────────
var A; // the exposed API
function loadContent() {
    installEnv();
    globalThis.__shejaTestHook = function (api) { A = api; };
    var pwd = ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey('PWD'));
    var src = $.NSString.stringWithContentsOfFileEncodingError(pwd + '/content.js', $.NSUTF8StringEncoding, null).js;
    eval(src);
}
loadContent();

// JXA runs scripts in non-module mode (no top-level await), so all test execution
// lives in an async main() that we invoke at the very end.
async function main() {

// ══════════════════════════════════════════════════════════════════════════════
// UNIT TESTS — pure helpers
// ══════════════════════════════════════════════════════════════════════════════
group('normalize / normKey / tokenOverlap');
test('normalize collapses + trims', () => eq('n1', A.normalize('  a   b\n c  '), 'a b c'));
test('normalize empty', () => eq('n2', A.normalize('   '), ''));
test('normKey strips diacritics', () => eq('k1', A.normKey('Café'), 'cafe'));
test('normKey lowercases + collapses punctuation', () => eq('k2', A.normKey("St. John's!"), 'st john s'));
test('normKey trims/collapses ws', () => eq('k3', A.normKey('  Hello,  World  '), 'hello world'));
test('normKey empty/null', () => { eq('k4', A.normKey(''), ''); eq('k5', A.normKey(null), ''); });
test('tokenOverlap partial', () => eq('t1', A.tokenOverlap('a b c', 'a b'), 2 / 3));
test('tokenOverlap none', () => eq('t2', A.tokenOverlap('a b', 'x y'), 0));
test('tokenOverlap empty', () => eq('t3', A.tokenOverlap('', 'a'), 0));
test('tokenOverlap full', () => eq('t4', A.tokenOverlap('red car', 'red car'), 1));

group('inViewport');
test('inViewport inside', () => ok('v1', A.inViewport(R(), 0)));
test('inViewport offscreen top', () => ok('v2', !A.inViewport(R({ top: -50, bottom: -10 }), 0)));
test('inViewport slack rescues', () => ok('v3', A.inViewport(R({ top: -5, bottom: 30 }), 20)));
test('inViewport zero size', () => ok('v4', !A.inViewport(R({ width: 0, height: 0 }), 0)));

group('isJunk / looksLikeQuestion');
test('junk dataLayer', () => ok('j1', A.isJunk('window.dataLayer=[]')));
test('junk pin', () => ok('j2', A.isJunk('Enter PIN to join')));
test('not junk question', () => ok('j3', !A.isJunk('What is the capital of France?')));
test('looksLikeQuestion ?', () => ok('q1', A.looksLikeQuestion('The sky is blue?')));
test('looksLikeQuestion stem which', () => ok('q2', A.looksLikeQuestion('Which planet is largest')));
test('looksLikeQuestion stem name', () => ok('q3', A.looksLikeQuestion('Name a fruit')));
test('looksLikeQuestion negative', () => ok('q4', !A.looksLikeQuestion('random statement here')));

group('dedupeQuestion');
test('dedupe 2x', () => eq('d1', A.dedupeQuestion('What is 2+2?What is 2+2?'), 'What is 2+2?'));
test('dedupe 3x', () => eq('d2', A.dedupeQuestion('Capital of France?Capital of France?Capital of France?'), 'Capital of France?'));
test('dedupe no repeat', () => eq('d3', A.dedupeQuestion('A unique single question line'), 'A unique single question line'));
test('dedupe too short untouched', () => eq('d4', A.dedupeQuestion('abcab'), 'abcab'));

group('truncateAtQuestionMark');
test('trunc no mark', () => eq('tr1', A.truncateAtQuestionMark('No question mark here', []), 'No question mark here'));
test('trunc nothing after', () => eq('tr2', A.truncateAtQuestionMark('What is X?', []), 'What is X?'));
test('trunc digits garbage after', () => eq('tr3', A.truncateAtQuestionMark('What is X?008008008', []), 'What is X?'));
test('trunc keeps riddle tail', () => eq('tr4', A.truncateAtQuestionMark('What am I? I get wetter the more I dry.', []), 'What am I? I get wetter the more I dry.'));
test('trunc strips concatenated options', () => eq('tr5',
    A.truncateAtQuestionMark('Capital of France?ParisLondonRome', ['Paris', 'London', 'Rome']), 'Capital of France?'));
test('trunc strips repeated stem', () => {
    var q = 'What is the capital?';
    eq('tr6', A.truncateAtQuestionMark(q + 'What is the capital extra', []), q);
});

group('vision routing');
test('needsVision flag', () => ok('nv1', A.needsVision('Guess the flag shown')));
test('needsVision unscramble = false', () => ok('nv2', !A.needsVision('Unscramble the word elcyeh')));
test('needsVision plain math = false', () => ok('nv3', !A.needsVision('What is 2 + 2')));
test('needsVision deictic cue', () => ok('nv4', A.needsVision('Which country is shown in the image')));
test('needsVision fill-in = false', () => ok('nv5', !A.needsVision('Fill in the blank: the ___ jumped')));
test('looksLikeVisualQuestion', () => { ok('lv1', A.looksLikeVisualQuestion('country flag')); ok('lv2', !A.looksLikeVisualQuestion('math sum')); });
test('isImageIrrelevantQuestion', () => { ok('ir1', A.isImageIrrelevantQuestion('Unscramble cat')); ok('ir2', A.isImageIrrelevantQuestion('type your answer')); ok('ir3', !A.isImageIrrelevantQuestion('What is the capital')); });

group('answer-string helpers');
test('startsWithWord boundary', () => { ok('sw1', A.startsWithWord('paris france', 'paris')); ok('sw2', !A.startsWithWord('parisian', 'paris')); ok('sw3', A.startsWithWord('paris', 'paris')); });
test('stripWrap brackets/quotes', () => { eq('sr1', A.stripWrap('[Paris]'), 'Paris'); eq('sr2', A.stripWrap('"Blue"'), 'Blue'); eq('sr3', A.stripWrap('plain'), 'plain'); });
test('clampReason long', () => { var r = A.clampReason('x'.repeat(200)); ok('cr1', r.length <= 118 && r.endsWith('…')); });
test('clampReason short unchanged', () => eq('cr2', A.clampReason('short reason'), 'short reason'));
test('closestOption word overlap', () => eq('co1', A.closestOption('the eiffel tower', ['Eiffel Tower', 'Big Ben']), 'Eiffel Tower'));
test('closestOption none', () => eq('co2', A.closestOption('zzz qqq', ['aaa', 'bbb']), null));

group('parseAnswer — multiple choice');
test('pa exact numeric', () => eq('pa1', A.parseAnswer('4', ['3', '4', '5']).fillText, '4'));
test('pa answer + reason', () => {
    var r = A.parseAnswer('Paris - the capital', ['London', 'Paris', 'Rome']);
    eq('pa2a', r.fillText, 'Paris'); eq('pa2b', r.reason, 'the capital'); ok('pa2c', !r.lowConfidence);
});
test('pa contained whole word', () => eq('pa3', A.parseAnswer('The answer is Berlin', ['Berlin', 'Munich']).fillText, 'Berlin'));
test('pa bracket wrap', () => eq('pa4', A.parseAnswer('[Paris]', ['Paris', 'Rome']).fillText, 'Paris'));
test('pa off-list → closest low-confidence', () => {
    var r = A.parseAnswer('Lyon', ['Paris', 'Marseille']);
    ok('pa5', r.lowConfidence);
});
test('pa total miss → fallback flagged', () => {
    var r = A.parseAnswer('zzz qqq', ['aaa', 'bbb']);
    ok('pa6', r.lowConfidence && r.fillText.length > 0);
});

group('parseAnswer — open-ended');
test('pa open single word', () => eq('pa7', A.parseAnswer('Photosynthesis', []).fillText, 'Photosynthesis'));
test('pa open dash reason', () => {
    var r = A.parseAnswer('Blue — the color of the sky', []);
    eq('pa8a', r.fillText, 'Blue'); eq('pa8b', r.reason, 'the color of the sky');
});
test('pa open two lines', () => {
    var r = A.parseAnswer('Mercury\nClosest to the sun', []);
    eq('pa9a', r.fillText, 'Mercury'); eq('pa9b', r.reason, 'Closest to the sun');
});
test('pa open caps to 3 words', () => {
    var r = A.parseAnswer('the quick brown fox jumps', []);
    ok('pa10', r.fillText.split(' ').length <= 3);
});

group('resolveResp');
test('rr structured trusted', () => {
    var r = A.resolveResp({ answer: 'Paris', inRange: true, confidence: 0.9, reasoning: 'capital' }, ['London', 'Paris']);
    eq('rr1a', r.fillText, 'Paris'); eq('rr1b', r.confidence, 0.9); ok('rr1c', !r.lowConfidence); ok('rr1d', r.inRange);
});
test('rr low confidence flagged', () => {
    var r = A.resolveResp({ answer: 'Paris', inRange: true, confidence: 0.4 }, ['London', 'Paris']);
    ok('rr2', r.lowConfidence);
});
test('rr parse fallback', () => {
    var r = A.resolveResp({ parseError: true, raw: 'b' }, ['a', 'b']);
    eq('rr3a', r.fillText, 'b'); ok('rr3b', !r.inRange);
});

// ── DOM-dependent pure helpers ──
group('extractAnswers filtering');
test('extractAnswers filters + dedups', () => {
    resetDOM();
    DOM.buttons = [
        mkEl('button', { text: 'Paris' }),
        mkEl('button', { text: 'Paris' }),               // duplicate
        mkEl('button', { text: 'Submit' }),              // ignored word
        mkEl('button', { text: 'London', disabled: true }), // disabled
        mkEl('button', { text: 'Small', rect: R({ width: 30 }) }), // too small
        mkEl('button', { text: 'Enter PIN now' }),       // junk
        mkEl('button', { text: 'Rome' })
    ];
    eq('ea1', A.extractAnswers(), ['Paris', 'Rome']);
});
test('extractAnswers empty', () => { resetDOM(); eq('ea2', A.extractAnswers(), []); });

group('classifyAnswerSurface');
test('cas mc when >=2 buttons', () => {
    resetDOM(); DOM.buttons = [mkEl('button', { text: 'A' }), mkEl('button', { text: 'B' })];
    eq('cas1', A.classifyAnswerSurface('What?', 0).kind, 'mc');
});
test('cas open for image-irrelevant', () => {
    resetDOM(); eq('cas2', A.classifyAnswerSurface('Unscramble cat', 0).kind, 'open');
});
test('cas open when input + past grace', () => {
    resetDOM(); DOM.inputs = [mkEl('input', { type: 'text' })];
    eq('cas3', A.classifyAnswerSurface('What is x', A.constants.OPEN_GRACE_MS + 1).kind, 'open');
});
test('cas none when input but within grace', () => {
    resetDOM(); DOM.inputs = [mkEl('input', { type: 'text' })];
    eq('cas4', A.classifyAnswerSurface('What is x', 0).kind, 'none');
});
test('cas none when nothing', () => { resetDOM(); eq('cas5', A.classifyAnswerSurface('What is x', 9999).kind, 'none'); });

group('visualFingerprint / findTextInput');
test('vf picks large centered img', () => {
    resetDOM();
    DOM.imgs = [
        mkEl('img', { rect: R({ width: 40, height: 40 }) }),               // too small
        Object.assign(mkEl('img', { rect: R({ width: 200, height: 180, top: 120, bottom: 300 }) }), { src: 'flag.png', currentSrc: 'flag.png' })
    ];
    eq('vf1', A.visualFingerprint(), 'img:flag.png');
});
test('vf empty when only small imgs', () => {
    resetDOM(); DOM.imgs = [mkEl('img', { rect: R({ width: 20, height: 20 }) })];
    eq('vf2', A.visualFingerprint(), '');
});
test('findTextInput skips password', () => {
    resetDOM(); DOM.inputs = [mkEl('input', { type: 'password', rect: R({ width: 200, height: 30 }) })];
    eq('fi1', A.findTextInput(), null);
});
test('findTextInput returns visible text input', () => {
    resetDOM(); var i = mkEl('input', { type: 'text', rect: R({ width: 200, height: 30 }) });
    DOM.inputs = [i]; ok('fi2', A.findTextInput() === i);
});

// ══════════════════════════════════════════════════════════════════════════════
// BEHAVIOURAL / INTEGRATION TESTS
// ══════════════════════════════════════════════════════════════════════════════
group('EventBus');
test('bus emit/on', () => {
    var bus = new A.EventBus(), got = [];
    bus.on('e', p => got.push(p));
    bus.emit('e', 1); bus.emit('e', 2);
    eq('eb1', got, [1, 2]);
});
test('bus off / unsubscribe fn', () => {
    var bus = new A.EventBus(), n = 0;
    var un = bus.on('e', () => n++);
    bus.emit('e'); un(); bus.emit('e');
    eq('eb2', n, 1);
});
test('bus isolates throwing handler', () => {
    var bus = new A.EventBus(), n = 0;
    bus.on('e', () => { throw new Error('boom'); });
    bus.on('e', () => n++);
    bus.emit('e');
    eq('eb3', n, 1);
});
test('bus clear', () => {
    var bus = new A.EventBus(), n = 0;
    bus.on('e', () => n++); bus.clear(); bus.emit('e');
    eq('eb4', n, 0);
});

group('AnswerFiller');
test('filler captures + clicks matching option', () => {
    resetDOM();
    var paris = mkEl('button', { text: 'Paris' }), london = mkEl('button', { text: 'London' });
    DOM.buttons = [paris, london];
    var f = new A.AnswerFiller();
    f.capture();
    ok('af1', f.clickAnswer('Paris')); ok('af1b', paris._clicked); ok('af1c', !london._clicked);
});
test('filler fuzzy match strips article', () => {
    resetDOM();
    var us = mkEl('button', { text: 'United States' });
    DOM.buttons = [us]; var f = new A.AnswerFiller(); f.capture();
    ok('af2', f.clickAnswer('the united states')); ok('af2b', us._clicked);
});
test('filler no match returns false', () => {
    resetDOM(); DOM.buttons = [mkEl('button', { text: 'Paris' })];
    var f = new A.AnswerFiller(); f.capture();
    ok('af3', !f.clickAnswer('Tokyo'));
});
await atest('filler.fill MC clicks then submits', async () => {
    resetDOM();
    var opt = mkEl('button', { text: 'Blue' }), submit = mkEl('button', { text: 'Submit' });
    DOM.buttons = [opt, submit];
    var f = new A.AnswerFiller(); f.capture();
    var ok1 = await f.fill('Blue', true);
    ok('af4a', ok1); ok('af4b', opt._clicked); ok('af4c', submit._clicked, 'autoSubmit should click Submit');
});
await atest('filler.fill open-ended types into input', async () => {
    resetDOM();
    var input = mkEl('input', { type: 'text', rect: R({ width: 200, height: 30 }) });
    DOM.inputs = [input];
    var f = new A.AnswerFiller();
    var ok1 = await f.fill('Photosynthesis', false);
    ok('af5a', ok1); eq('af5b', input.value, 'Photosynthesis');
});
await atest('filler.fill MC no target → false', async () => {
    resetDOM(); var f = new A.AnswerFiller(); f.capture();
    var ok1 = await f.fill('Nothing', true);
    ok('af6', ok1 === false);
});

group('OverlayUI — capture fade');
function mkOverlay() {
    var ui = new A.OverlayUI({ onClose() {}, onPauseToggle() {}, onRescan() {}, onNudgeSubmit() {}, onFill() {} });
    ui.mount();
    return ui;
}
test('setHidden(true) fades out fast, without an abrupt visibility cut', () => {
    var ui = mkOverlay();
    ui.setHidden(true);
    eq('oh1a', ui.overlay.style.opacity, '0');
    eq('oh1b', ui.overlay.style.pointerEvents, 'none');
    ok('oh1c', ui.overlay.style.transition.indexOf(A.constants.CAPTURE_FADE_OUT_MS + 'ms') !== -1);
});
test('setHidden(false) fades back in, restoring interaction', () => {
    var ui = mkOverlay();
    ui.setHidden(true);
    ui.setHidden(false);
    eq('oh2a', ui.overlay.style.opacity, '1');
    eq('oh2b', ui.overlay.style.visibility, '');
    eq('oh2c', ui.overlay.style.pointerEvents, '');
    ok('oh2d', ui.overlay.style.transition.indexOf(A.constants.CAPTURE_FADE_IN_MS + 'ms') !== -1);
});

group('Solver');
function mkSolver() {
    var cap = new A.CapturePipeline({ hide() {}, show() {} });
    return new A.Solver({ capture: cap, getNudge: () => '' });
}
await atest('solver MC high-confidence, no vote', async () => {
    installChrome();
    CHROME.askAI = [{ answer: 'B', answerIndex: 1, inRange: true, confidence: 0.9, provider: 'gemini' }];
    var r = await mkSolver().solve('What?', ['A', 'B']);
    eq('sv1a', r.resolved.fillText, 'B'); eq('sv1b', r.provider, 'gemini');
    ok('sv1c', !r.usedImage); eq('sv1d', askCalls().length, 1);
});
await atest('solver low-confidence triggers vote', async () => {
    installChrome();
    CHROME.askAI = [
        { answer: 'A', answerIndex: 0, inRange: true, confidence: 0.4, provider: 'gemini' },
        { answer: 'A', answerIndex: 0, inRange: true, confidence: 0.5, provider: 'gemini' },
        { answer: 'A', answerIndex: 0, inRange: true, confidence: 0.5, provider: 'gemini' }
    ];
    var r = await mkSolver().solve('What?', ['A', 'B']);
    eq('sv2a', r.resolved.fillText, 'A');
    eq('sv2b', askCalls().length, 1 + A.constants.VOTE_SAMPLES); // first + samples
    ok('sv2c', r.resolved.confidence > 0.5);
});
await atest('solver strict retry on off-list', async () => {
    installChrome();
    CHROME.askAI = [
        { parseError: true, raw: '???', provider: 'gemini' },
        { answer: 'B', answerIndex: 1, inRange: true, confidence: 0.95, provider: 'gemini' }
    ];
    var r = await mkSolver().solve('What?', ['A', 'B']);
    eq('sv3a', r.resolved.fillText, 'B');
    eq('sv3b', askCalls().length, 2);
    ok('sv3c', askCalls()[1].strict === true);
});
await atest('solver vision routing sends screenshot', async () => {
    installChrome();
    CHROME.askAI = [{ answer: 'France', answerIndex: 0, inRange: true, confidence: 0.9, provider: 'gemini' }];
    var r = await mkSolver().solve('Guess the flag', ['France', 'Spain']);
    ok('sv4a', r.usedImage);
    ok('sv4b', CHROME.calls.some(c => c.action === 'takeScreenshot'));
    ok('sv4c', askCalls()[0].imageDataUrl && askCalls()[0].imageDataUrl.indexOf('data:image') === 0);
});
await atest('solver error rejects', async () => {
    installChrome();
    CHROME.askAI = [{ error: 'boom' }];
    var threw = false;
    try { await mkSolver().solve('What?', ['A', 'B']); } catch (e) { threw = e.message === 'boom'; }
    ok('sv5', threw);
});
await atest('solver isStale short-circuits (no answer)', async () => {
    installChrome();
    CHROME.askAI = [{ answer: 'B', answerIndex: 1, inRange: true, confidence: 0.9, provider: 'gemini' }];
    var r = await mkSolver().solve('What?', ['A', 'B'], { isStale: () => true });
    ok('sv6', r === null);
});
await atest('solver forwards nudge', async () => {
    installChrome();
    CHROME.askAI = [{ answer: 'B', answerIndex: 1, inRange: true, confidence: 0.9, provider: 'gemini' }];
    var cap = new A.CapturePipeline({ hide() {}, show() {} });
    var s = new A.Solver({ capture: cap, getNudge: () => '90s music' });
    await s.solve('What?', ['A', 'B']);
    eq('sv7', askCalls()[0].nudge, '90s music');
});

group('IngestionEngine');
function busRec() {
    var bus = new A.EventBus(); bus._log = [];
    ['question:detecting', 'question:waiting', 'questionDetected', 'transitionStart', 'lifecycleReset']
        .forEach(e => bus.on(e, p => bus._log.push({ e: e, p: p })));
    return bus;
}
test('ingestion detects + gates to mc, dedups', () => {
    resetDOM(); DOM.buttons = [mkEl('button', { text: 'Paris' }), mkEl('button', { text: 'London' })];
    var bus = busRec(); var eng = new A.IngestionEngine(bus);
    eng._tryRecord('What is the capital of France?');
    var detected = bus._log.filter(x => x.e === 'questionDetected');
    eq('ie1a', detected.length, 1);
    eq('ie1b', detected[0].p.options, ['Paris', 'London']);
    eng._tryRecord('What is the capital of France?');            // same → deduped
    eq('ie1c', bus._log.filter(x => x.e === 'questionDetected').length, 1);
});
test('ingestion suppresses just-answered, allows new', () => {
    resetDOM(); DOM.buttons = [mkEl('button', { text: 'A' }), mkEl('button', { text: 'B' })];
    var bus = busRec(); var eng = new A.IngestionEngine(bus);
    eng._tryRecord('Question one here please?');
    eng.suppressCurrent();
    eng._tryRecord('Question one here please?');                 // suppressed
    eq('ie2a', bus._log.filter(x => x.e === 'questionDetected').length, 1);
    eng._cooldownUntil = 0;                                      // simulate >200ms elapsed since the click
    eng._tryRecord('A completely different question?');          // new → emits
    eq('ie2b', bus._log.filter(x => x.e === 'questionDetected').length, 2);
});
test('ingestion reset clears fingerprint (re-emits same)', () => {
    resetDOM(); DOM.buttons = [mkEl('button', { text: 'A' }), mkEl('button', { text: 'B' })];
    var bus = busRec(); var eng = new A.IngestionEngine(bus);
    eng._tryRecord('Repeatable question text here?');
    eng.reset();
    eng._tryRecord('Repeatable question text here?');
    eq('ie3', bus._log.filter(x => x.e === 'questionDetected').length, 2);
});
test('ingestion gate timeout → best-effort open emit', () => {
    resetDOM(); // no buttons, no input
    var bus = busRec(); var eng = new A.IngestionEngine(bus);
    eng._detectSeq = 7;
    eng._waitForSurface('Some open question here?', '', 7, A.performance ? 0 : 0); // startedAt in far past
    // startedAt=0 → elapsed huge → immediate best-effort
    var d = bus._log.filter(x => x.e === 'questionDetected');
    eq('ie4a', d.length, 1); eq('ie4b', d[0].p.options, []);
});
test('ingestion paused ignores detection', () => {
    resetDOM(); DOM.buttons = [mkEl('button', { text: 'A' }), mkEl('button', { text: 'B' })];
    var bus = busRec(); var eng = new A.IngestionEngine(bus);
    eng.setPaused(true); eng._tryRecord('Should be ignored while paused?');
    eq('ie5', bus._log.filter(x => x.e === 'questionDetected').length, 0);
});
test('suppressCurrent is idempotent — a redundant call does not blank a valid suppression', () => {
    resetDOM(); DOM.buttons = [mkEl('button', { text: 'A' }), mkEl('button', { text: 'B' })];
    var bus = busRec(); var eng = new A.IngestionEngine(bus);
    eng._tryRecord('Some question here?');
    var fp = eng._lastFingerprint;
    eng.suppressCurrent();
    eq('ie6a', eng._suppressed, fp);
    eng.suppressCurrent();                  // e.g. a double-click on an already-filled answer
    eq('ie6b', eng._suppressed, fp);         // still the real fingerprint, not ""
});
test('_visualTick debounces a visual-only flap — needs 2 consecutive polls before it re-detects', () => {
    resetDOM();
    DOM.buttons = [mkEl('button', { text: 'France' }), mkEl('button', { text: 'Spain' })];
    DOM.imgs = [Object.assign(
        mkEl('img', { rect: R({ width: 300, height: 200, top: 60, bottom: 260 }) }),
        { src: 'flag2.png', currentSrc: 'flag2.png' }
    )];
    var bus = busRec(); var eng = new A.IngestionEngine(bus);
    eng._running = true;
    eng._currentQuestion = 'Guess the flag shown?';
    eng._currentOptions = ['France', 'Spain'];       // unchanged → sameAnswers stays true throughout
    eng._currentVisualKey = 'img:flag1.png';         // the fingerprint already confirmed/shown
    eng._lastFingerprint = 'Guess the flag shown?\nimg:flag1.png';

    eng._lastPollAt = 0;                             // bypass the poll throttle
    eng._visualTick(0);                              // 1st sighting of the new src — not enough alone
    eq('vt1a', eng._pendingVisualKey, 'img:flag2.png');
    eq('vt1b', bus._log.filter(x => x.e === 'questionDetected').length, 0);

    eng._lastPollAt = 0;
    eng._visualTick(0);                              // 2nd, CONFIRMING sighting → acts
    var d = bus._log.filter(x => x.e === 'questionDetected');
    eq('vt1c', d.length, 1);
    eq('vt1d', d[0].p.visualKey, 'img:flag2.png');
});
test('_visualTick never confirms a src that keeps alternating (no re-detect, no stuck state)', () => {
    resetDOM();
    DOM.buttons = [mkEl('button', { text: 'France' }), mkEl('button', { text: 'Spain' })];
    var toggle = false;
    var img = mkEl('img', { rect: R({ width: 300, height: 200, top: 60, bottom: 260 }) });
    Object.defineProperty(img, 'currentSrc', { get() { toggle = !toggle; return toggle ? 'a.png' : 'b.png'; } });
    DOM.imgs = [img];
    var bus = busRec(); var eng = new A.IngestionEngine(bus);
    eng._running = true;
    eng._currentQuestion = 'Guess the flag shown?';
    eng._currentOptions = ['France', 'Spain'];
    eng._currentVisualKey = 'img:seed.png';
    eng._lastFingerprint = 'Guess the flag shown?\nimg:seed.png';

    for (var i = 0; i < 4; i++) { eng._lastPollAt = 0; eng._visualTick(0); }
    eq('vt2', bus._log.filter(x => x.e === 'questionDetected').length, 0);
});

group('TransitionSensor');
test('sensor emits on loader rising edge only', () => {
    resetDOM();
    var bus = busRec(); var s = new A.TransitionSensor(bus);
    DOM.loaders = [mkEl('div', { rect: R() })];
    s._tick();                                  // rising edge → emit
    s._tick();                                  // still present → no emit
    var tr = bus._log.filter(x => x.e === 'transitionStart');
    eq('ts1a', tr.length, 1); eq('ts1b', tr[0].p.type, 'loader');
});
test('sensor refractory blocks rapid second emit', () => {
    resetDOM();
    var bus = busRec(); var s = new A.TransitionSensor(bus);
    DOM.loaders = [mkEl('div', { rect: R() })];
    s._tick();                                  // loader emit → refractory begins, _lastH recorded
    // now a big layout shift immediately after — within refractory → suppressed
    DOM.loaders = [];                           // remove loader so its falling edge doesn't emit
    s._container()._rect = R({ height: 500 });  // mutate the SAME element the sensor reads
    s._tick();
    eq('ts2', bus._log.filter(x => x.e === 'transitionStart').length, 1);
});
test('sensor emits layout shift after refractory', () => {
    resetDOM();
    var bus = busRec(); var s = new A.TransitionSensor(bus);
    s._refractoryUntil = 0; s._lastH = 40; s._lastW = 120;
    s._container()._rect = R({ height: 400 }); // +360 > threshold, on the element the sensor reads
    s._tick();
    var tr = bus._log.filter(x => x.e === 'transitionStart');
    eq('ts3a', tr.length, 1); eq('ts3b', tr.length ? tr[0].p.type : null, 'layout');
});

group('EventLifecycleManager');
test('lifecycle resets on answer-like click', () => {
    var bus = busRec();
    var mgr = new A.EventLifecycleManager(bus, () => ['Paris', 'London']);
    mgr._onClick({ target: mkEl('button', { text: 'Paris', rect: R() }) });
    eq('el1', bus._log.filter(x => x.e === 'lifecycleReset').length, 1);
});
test('lifecycle ignores non-answer click', () => {
    var bus = busRec();
    var mgr = new A.EventLifecycleManager(bus, () => ['Paris', 'London']);
    mgr._onClick({ target: mkEl('button', { text: 'Some Toolbar Button', rect: R() }) });
    eq('el2', bus._log.filter(x => x.e === 'lifecycleReset').length, 0);
});
test('lifecycle ignores overlay click', () => {
    var bus = busRec();
    var mgr = new A.EventLifecycleManager(bus, () => ['Paris']);
    mgr._onClick({ target: mkEl('button', { text: 'Paris', overlay: true }) });
    eq('el3', bus._log.filter(x => x.e === 'lifecycleReset').length, 0);
});
test('lifecycle ignores tiny element', () => {
    var bus = busRec();
    var mgr = new A.EventLifecycleManager(bus, () => ['Paris']);
    mgr._onClick({ target: mkEl('span', { text: 'Paris', rect: R({ width: 10, height: 10 }) }) });
    eq('el4', bus._log.filter(x => x.e === 'lifecycleReset').length, 0);
});

group('Orchestrator');
await atest('orchestrator answers a detected MC question', async () => {
    installEnv();
    CHROME.askAI = [{ answer: 'Paris', answerIndex: 1, inRange: true, confidence: 0.95, provider: 'gemini' }];
    var app = new A.Orchestrator(); app.start();
    DOM.buttons = [mkEl('button', { text: 'London' }), mkEl('button', { text: 'Paris' })];
    var before = app.reqId;
    app.onQuestionDetected({ question: 'Capital of France?', options: ['London', 'Paris'], visualKey: '' });
    await flush();
    eq('or1a', app.reqId, before + 1);
    eq('or1b', app.currentQuestion, 'Capital of France?');
    ok('or1c', askCalls().some(c => c.question === 'Capital of France?'));
    ok('or1d', app._loading === false);
});
await atest('orchestrator back-pressure: reqId increments per detection', async () => {
    installEnv();
    CHROME.askAI = [
        { answer: 'A', answerIndex: 0, inRange: true, confidence: 0.9, provider: 'gemini' },
        { answer: 'B', answerIndex: 1, inRange: true, confidence: 0.9, provider: 'gemini' }
    ];
    var app = new A.Orchestrator(); app.start();
    var r0 = app.reqId;
    app.onQuestionDetected({ question: 'Q one?', options: ['A', 'B'], visualKey: '' });
    app.onQuestionDetected({ question: 'Q two?', options: ['A', 'B'], visualKey: '' });
    await flush();
    eq('or2', app.reqId, r0 + 2);
});
test('orchestrator onTransition does NOT cancel in-flight solve', () => {
    installEnv();
    var app = new A.Orchestrator(); app.start();
    app._loading = true; var before = app.reqId;
    app.onTransition({ type: 'layout' });
    eq('or3a', app.reqId, before);          // reqId unchanged → in-flight solve survives
    ok('or3b', app._loading === true);
});
test('orchestrator onReset cancels in-flight solve', () => {
    installEnv();
    var app = new A.Orchestrator(); app.start();
    app._loading = true; var before = app.reqId;
    app.onReset({});
    eq('or4a', app.reqId, before + 1);      // bumped → in-flight discarded
    ok('or4b', app._loading === false);
});
test('orchestrator pause bumps reqId + flags paused', () => {
    installEnv();
    var app = new A.Orchestrator(); app.start();
    var before = app.reqId;
    var paused = app._togglePause();
    ok('or5a', paused === true); ok('or5b', app._paused === true);
    eq('or5c', app.reqId, before + 1);
    ok('or5d', app.ingestion._paused === true);
    app._togglePause();
    ok('or5e', app._paused === false);
});
await atest('orchestrator onFill suppresses re-detection', async () => {
    installEnv();
    var app = new A.Orchestrator(); app.start();
    DOM.buttons = [mkEl('button', { text: 'Blue' }), mkEl('button', { text: 'Submit' })];
    app.filler.capture();
    app.ingestion._lastFingerprint = 'Blue?\n';
    var ok1 = await app.onFill('Blue', true);
    ok('or6a', ok1);
    ok('or6b', app.ingestion._suppressed === 'Blue?\n', 'ingestion should suppress the answered fingerprint');
});
test('orchestrator onReset resets the overlay to idle even when nothing was loading', () => {
    installEnv();
    var app = new A.Orchestrator(); app.start();
    var idleCalls = 0, statusLog = [], accentCalls = 0;
    app.overlay.showIdle = () => idleCalls++;
    app.overlay.setStatus = s => statusLog.push(s);
    app.overlay.clearAnswerAccent = () => accentCalls++;
    app._loading = false;              // answer already shown; nothing in flight — the previous gap
    app.onReset({});
    eq('or7a', idleCalls, 1);
    ok('or7b', statusLog.indexOf('idle') !== -1);
    eq('or7c', accentCalls, 1);
});
await atest('orchestrator onFill resets the overlay to idle on success (covers open-ended, no lifecycleReset)', async () => {
    installEnv();
    var app = new A.Orchestrator(); app.start();
    DOM.inputs = [mkEl('input', { type: 'text', rect: R({ width: 200, height: 30 }) })];
    var idleCalls = 0, accentCalls = 0;
    app.overlay.showIdle = () => idleCalls++;
    app.overlay.clearAnswerAccent = () => accentCalls++;
    app._loading = false;
    var ok1 = await app.onFill('Mercury', false);   // open-ended: fillInput, not a page click
    ok('or8a', ok1);
    eq('or8b', idleCalls, 1);
    eq('or8c', accentCalls, 1);
});
await atest('orchestrator onFill does NOT clobber a new question that started loading mid-fill', async () => {
    installEnv();
    var app = new A.Orchestrator(); app.start();
    DOM.buttons = [mkEl('button', { text: 'Blue' }), mkEl('button', { text: 'Submit' })];
    app.filler.capture();
    var idleCalls = 0;
    app.overlay.showIdle = () => idleCalls++;
    var p = app.onFill('Blue', true);
    app._loading = true;               // a NEW question began detecting before onFill resolved
    var ok1 = await p;
    ok('or9a', ok1);
    eq('or9b', idleCalls, 0);          // must not stomp the new question's "Thinking…" state
});

// ══════════════════════════════════════════════════════════════════════════════
// COVERAGE — improvements that let the extension handle more questions
// ══════════════════════════════════════════════════════════════════════════════
group('COVERAGE — question detection');
test('detects imperative / true-false / ordering stems without a "?"', () => {
    ok('cv1', A.looksLikeQuestion('True or false: the earth is flat'));
    ok('cv2', A.looksLikeQuestion('Arrange the planets by size'));
    ok('cv3', A.looksLikeQuestion('Convert 5 km to miles'));
    ok('cv4', A.looksLikeQuestion('Define photosynthesis briefly'));
    ok('cv5', A.looksLikeQuestion('In what year did WWII end'));
    ok('cv6', A.looksLikeQuestion('Match the capital to its country'));
    ok('cv7', A.looksLikeQuestion('Rank these rivers by length'));
    ok('cv8', A.looksLikeQuestion('Whose theory is relativity'));
});
test('does NOT misfire on ordinary statements', () => {
    ok('cv9', !A.looksLikeQuestion('This is just a statement about stuff'));
    ok('cv10', !A.looksLikeQuestion('Do not press the button'));   // yes/no starters excluded on purpose
    ok('cv11', !A.looksLikeQuestion('A knot in the rope'));         // "not\b" false-positive guard
});
group('COVERAGE — option/junk filtering');
test('extractAnswers drops platform chrome (login/share/settings)', () => {
    resetDOM();
    DOM.buttons = [
        mkEl('button', { text: 'Paris' }),
        mkEl('button', { text: 'Log in' }),
        mkEl('button', { text: 'Share' }),
        mkEl('button', { text: 'Settings' }),
        mkEl('button', { text: 'Play again' }),
        mkEl('button', { text: 'Rome' })
    ];
    eq('cv12', A.extractAnswers(), ['Paris', 'Rome']);
});
group('COVERAGE — vision routing');
test('convert/round are image-irrelevant (no wasted screenshot)', () => {
    ok('cv13', A.isImageIrrelevantQuestion('Convert 10 to binary'));
    ok('cv14', A.isImageIrrelevantQuestion('Round 3.7 to the nearest integer'));
    ok('cv16', !A.needsVision('Convert 5 to hex'));
    ok('cv17', !A.needsVision('Calculate 2 + 2'));                        // plain math → text-only
    ok('cv18', A.needsVision('Calculate the area of the triangle shown')); // image geometry → vision
    ok('cv19', !A.isImageIrrelevantQuestion('Calculate the area shown')); // calculate is NOT blanket-excluded
});

// ══════════════════════════════════════════════════════════════════════════════
// PERFORMANCE — latency guards (fail if an optimization is reverted)
// ══════════════════════════════════════════════════════════════════════════════
group('PERFORMANCE — DOM read latency');
test('visualFingerprint reads each image rect exactly once (no sort re-reads)', () => {
    resetDOM();
    DOM.imgs = [
        Object.assign(mkEl('img', { rect: R({ width: 200, height: 180, top: 120, bottom: 300 }) }), { src: 'a.png', currentSrc: 'a.png' }),
        Object.assign(mkEl('img', { rect: R({ width: 300, height: 200, top: 120, bottom: 320 }) }), { src: 'big.png', currentSrc: 'big.png' }),
        mkEl('img', { rect: R({ width: 40, height: 40 }) }),
        mkEl('img', { rect: R({ width: 160, height: 150, top: 120, bottom: 270 }) })
    ];
    resetCounters();
    var fp = A.visualFingerprint();
    eq('pf1a', fp, 'img:big.png');            // still picks the largest
    eq('pf1b', RECT_CALLS, DOM.imgs.length);  // ≤1 layout-forcing read per image
});
await atest('screenshot fast path: one frame, one image scan, no polling', async () => {
    installEnv();
    DOM.imgs = [Object.assign(mkEl('img', { rect: R({ width: 300, height: 200 }) }), { complete: true })];
    var cap = new A.CapturePipeline({ hide() {}, show() {} });
    resetCounters();
    var res = await cap.capture();
    ok('pf2a', res.dataUrl && res.dataUrl.indexOf('data:image') === 0);
    eq('pf2b', _rafs, 1);        // exactly one requestAnimationFrame (the redundant 2nd was removed)
    eq('pf2c', IMG_SCANS, 1);    // single image scan; no ~80ms poll retries
});
await atest('screenshot defers hiding the overlay until the image-wait resolves, not on an earlier "still loading" poll', async () => {
    installEnv();
    var hideCalls = 0, showCalls = 0, hideAtCheck = -1, checkCount = 0;
    var img = mkEl('img', { rect: R({ width: 300, height: 200 }) });
    // "still loading" on the 1st read, "done" on the 2nd — forces one genuine poll cycle.
    Object.defineProperty(img, 'complete', { get() { checkCount++; return checkCount > 1; } });
    DOM.imgs = [img];
    var cap = new A.CapturePipeline({
        hide() { hideCalls++; hideAtCheck = checkCount; },
        show() { showCalls++; }
    });
    var res = await cap.capture();
    ok('pf3a', res.dataUrl && res.dataUrl.indexOf('data:image') === 0);
    eq('pf3b', hideCalls, 1);
    eq('pf3c', showCalls, 1);
    ok('pf3d', checkCount >= 2);          // the image really was seen as "still loading" at least once
    eq('pf3e', hideAtCheck, checkCount);  // hide() only fires on the resolving check — never on an earlier pending one
});

group('PERFORMANCE — quiet during native screenshot capture');
// Chrome's native tab-capture forces a compositor readback of the whole page; our own
// layout-forcing polls (IngestionEngine Plan B, TransitionSensor) running on the same
// thread at that exact moment compound the visible freeze (and, downstream, make any
// page-side countdown skip ahead). captureStart/captureEnd bracket the capture window
// so both pollers go quiet for it — these tests lock that in.
test('IngestionEngine skips the visual poll while captureStart is active, resumes on captureEnd', () => {
    resetDOM();
    var bus = busRec();
    var eng = new A.IngestionEngine(bus);
    eng.start();                                       // wires captureStart/captureEnd
    eng._currentQuestion = 'Old question already on screen?';
    eng._currentOptions = ['A', 'B'];

    bus.emit('captureStart');
    ok('cap1a', eng._capturing === true);
    resetCounters();
    DOM.buttons = [mkEl('button', { text: 'C' }), mkEl('button', { text: 'D' })];  // a new surface appears
    eng._lastPollAt = 0;                                // bypass the poll throttle for this call
    eng._visualTick(0);
    eq('cap1b', RECT_CALLS, 0);                         // no layout-forcing reads while capturing
    eq('cap1c', bus._log.filter(x => x.e === 'questionDetected').length, 0);

    bus.emit('captureEnd');
    ok('cap1d', eng._capturing === false);
    eng._lastPollAt = 0;
    eng._visualTick(0);
    ok('cap1e', RECT_CALLS > 0);                        // capture over → polling resumes normally
});
test('TransitionSensor skips loader/layout polling while captureStart is active, resumes on captureEnd', () => {
    resetDOM();
    var bus = busRec();
    var s = new A.TransitionSensor(bus);
    s.start();                                          // wires captureStart/captureEnd

    bus.emit('captureStart');
    ok('cap2a', s._capturing === true);
    resetCounters();
    DOM.loaders = [mkEl('div', { rect: R() })];         // would normally be a rising-edge emit
    s._tick();
    eq('cap2b', RECT_CALLS, 0);
    eq('cap2c', bus._log.filter(x => x.e === 'transitionStart').length, 0);

    bus.emit('captureEnd');
    ok('cap2d', s._capturing === false);
    s._tick();
    eq('cap2e', bus._log.filter(x => x.e === 'transitionStart').length, 1);   // resumes, catches it
});

// ══════════════════════════════════════════════════════════════════════════════
// DESIGN DECISIONS — lock in the architectural choices behind the rewrite
// ══════════════════════════════════════════════════════════════════════════════
group('DESIGN DECISIONS');
test('DESIGN: needsVision is driven by wording, not image presence', () => {
    // quiz.com shows a decorative background image on nearly every question, so image
    // presence alone must NOT force a (slower, costlier, less accurate) vision call.
    ok('dd1a', !A.needsVision('What is the capital of France'));
    ok('dd1b', A.needsVision('Which flag is shown'));
});
test('DESIGN: question fingerprint excludes options ([] → [opts] is ONE question)', () => {
    resetDOM(); DOM.buttons = [mkEl('button', { text: 'A' }), mkEl('button', { text: 'B' })];
    var bus = busRec(); var eng = new A.IngestionEngine(bus);
    eng._tryRecord('One stable question line?');
    DOM.buttons = [mkEl('button', { text: 'C' }), mkEl('button', { text: 'D' })]; // options changed
    eng._tryRecord('One stable question line?');                                   // same text → deduped
    eq('dd2', bus._log.filter(x => x.e === 'questionDetected').length, 1);
});
await atest('DESIGN: MC never types into a text input (avoids the page search box)', async () => {
    resetDOM();
    var input = mkEl('input', { type: 'text', rect: R({ width: 200, height: 30 }) });
    DOM.inputs = [input];              // an input exists, but NO option buttons
    var f = new A.AnswerFiller(); f.capture();
    var filled = await f.fill('SomeAnswer', true);   // isMC = true
    ok('dd3a', filled === false);     // gives up rather than typing
    eq('dd3b', input.value, '');      // the input was never touched
});
test('DESIGN: readiness gate biases to MC (bare input not "open" until grace)', () => {
    resetDOM(); DOM.inputs = [mkEl('input', { type: 'text', rect: R({ width: 200, height: 30 }) })];
    eq('dd4a', A.classifyAnswerSurface('What is x', 0).kind, 'none');
    eq('dd4b', A.classifyAnswerSurface('What is x', A.constants.OPEN_GRACE_MS + 1).kind, 'open');
});
test('DESIGN: transition preserves in-flight solve; only an answer cancels it', () => {
    installEnv();
    var app = new A.Orchestrator(); app.start();
    app._loading = true; var r0 = app.reqId;
    app.onTransition({ type: 'layout' });
    eq('dd5a', app.reqId, r0);        // transition = back-pressure, not eager cancel (no false-positive hang)
    app.onReset({});
    eq('dd5b', app.reqId, r0 + 1);    // a chosen answer supersedes the in-flight request
});
test('DESIGN: single-flight back-pressure (one reqId per detection)', () => {
    installEnv();
    CHROME.askAI = [
        { answer: 'A', answerIndex: 0, inRange: true, confidence: 0.9, provider: 'gemini' },
        { answer: 'A', answerIndex: 0, inRange: true, confidence: 0.9, provider: 'gemini' }
    ];
    var app = new A.Orchestrator(); app.start();
    var r0 = app.reqId;
    app.onQuestionDetected({ question: 'Q1?', options: ['A', 'B'], visualKey: '' });
    app.onQuestionDetected({ question: 'Q2?', options: ['A', 'B'], visualKey: '' });
    eq('dd6', app.reqId, r0 + 2);
});

} // end main()

// ── Report ────────────────────────────────────────────────────────────────────
function report() {
    RESULTS.push('\n' + '═'.repeat(50));
    RESULTS.push((FAIL === 0 ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED') + '  —  ' + PASS + ' passed, ' + FAIL + ' failed');
    $.NSFileHandle.fileHandleWithStandardOutput.writeData(
        $.NSString.alloc.initWithString(RESULTS.join('\n') + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
    $.exit(FAIL === 0 ? 0 : 1);
}
main().then(report, function (e) { rec(false, 'main() crashed', e.message + ' | ' + String(e.stack || '')); report(); });
