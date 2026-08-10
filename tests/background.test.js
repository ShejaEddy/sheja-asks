/**
 * Test suite for background.js (AI prompt building + response parsing).
 *
 *   Run from the project root:
 *     osascript -l JavaScript tests/background.test.js
 *
 * These tests lock in the prompt DESIGN DECISIONS (which type-hints fire for which
 * questions) so prompt-engineering changes stay deliberate and regression-safe.
 */
ObjC.import('Foundation');
ObjC.import('stdlib');

var RESULTS = [], PASS = 0, FAIL = 0;
function rec(good, name, detail) {
    if (good) { PASS++; RESULTS.push('  ok   ' + name); }
    else { FAIL++; RESULTS.push('  FAIL ' + name + (detail ? '  ::  ' + detail : '')); }
}
function group(g) { RESULTS.push('\n[' + g + ']'); }
function ok(name, cond, detail) { rec(!!cond, name, detail); }
function eq(name, a, b) { var A = JSON.stringify(a), B = JSON.stringify(b); rec(A === B, name, A + ' !== ' + B); }
function has(name, str, sub) { rec(String(str).indexOf(sub) !== -1, name, 'missing "' + sub + '"'); }
function hasNot(name, str, sub) { rec(String(str).indexOf(sub) === -1, name, 'unexpectedly contains "' + sub + '"'); }
function test(name, fn) { try { fn(); } catch (e) { rec(false, name + ' (threw)', e.message); } }

// Load background.js (stub the top-level addListener) and grab its internals.
var B;
globalThis.chrome = { runtime: { onMessage: { addListener() {} } } };
globalThis.__shejaBgTestHook = function (api) { B = api; };
(function () {
    var pwd = ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey('PWD'));
    var src = $.NSString.stringWithContentsOfFileEncodingError(pwd + '/background.js', $.NSUTF8StringEncoding, null).js;
    eval(src);
})();

// ══════════════════════════════════════════════════════════════════════════════
// questionTypeHint — DESIGN DECISIONS: which hint fires for which wording
// ══════════════════════════════════════════════════════════════════════════════
group('questionTypeHint');
test('DESIGN: negation flagged (small models miss "NOT")', () => {
    has('qh-neg1', B.questionTypeHint('Which of these is NOT a mammal?'), 'NEGATION');
    has('qh-neg2', B.questionTypeHint('Select the odd one out'), 'NEGATION');
    has('qh-neg3', B.questionTypeHint("Which one doesn't belong?"), 'NEGATION');
    has('qh-neg4', B.questionTypeHint('All are primes except one'), 'NEGATION');
});
test('DESIGN: true/false is NOT treated as negation', () => {
    var h = B.questionTypeHint('True or false: the sky is blue');
    has('qh-tf', h, 'TRUE/FALSE');
    hasNot('qh-tf-noneg', h, 'NEGATION');
});
test('DESIGN: superlative asks model to compare all options', () => {
    has('qh-sup1', B.questionTypeHint('Which is the largest planet?'), 'SUPERLATIVE');
    has('qh-sup2', B.questionTypeHint('What is the best programming language?'), 'SUPERLATIVE');
});
test('ordering hint', () => has('qh-ord', B.questionTypeHint('Arrange these events chronologically'), 'ORDERING'));
test('matching hint', () => has('qh-match', B.questionTypeHint('Match the capital to its country'), 'MATCHING'));
test('year/date hint', () => has('qh-year', B.questionTypeHint('In what year did WWII end?'), 'YEAR/DATE'));
test('anagram hint', () => has('qh-ana', B.questionTypeHint('Unscramble elcyeh'), 'ANAGRAM'));
test('fill-in hint', () => has('qh-fill', B.questionTypeHint('Fill in the blank: the ___ jumped'), 'FILL-IN'));
test('math hint', () => has('qh-math', B.questionTypeHint('Calculate 12 x 12'), 'MATH'));
test('numeric hint', () => has('qh-num', B.questionTypeHint('How many legs does a spider have?'), 'NUMERIC'));
test('definition hint', () => has('qh-def', B.questionTypeHint('What is photosynthesis?'), 'DEFINITION'));
test('DESIGN: hints accumulate (negation + superlative together)', () => {
    var h = B.questionTypeHint('Which of these is NOT the largest?');
    has('qh-combo1', h, 'NEGATION'); has('qh-combo2', h, 'SUPERLATIVE');
});
// Recurring pattern across several captured logs this session — the model repeatedly
// answered these categorical-syllogism questions with a trivial restatement of one premise
// instead of the conclusion that actually chains both premises together.
test('syllogism hint: "does it necessarily follow"', () => {
    has('qh-syl1', B.questionTypeHint(
        'All roses are flowers. Some flowers are red. Does it necessarily follow that some roses are red?'
    ), 'SYLLOGISM');
});
test('syllogism hint: "logically drawn" conclusion wording', () => {
    has('qh-syl2', B.questionTypeHint(
        'Which of the following conclusions can be logically drawn from the statements?'
    ), 'SYLLOGISM');
});
test('syllogism hint: all/some quantifier structure without explicit "follow" wording', () => {
    has('qh-syl3', B.questionTypeHint(
        'If some actors are singers and all singers are dancers, which of the following is true?'
    ), 'SYLLOGISM');
});
test('syllogism hint does NOT fire on an unrelated all/some-free question', () => {
    hasNot('qh-syl4', B.questionTypeHint('What is the capital of France?'), 'SYLLOGISM');
});
test('plain question → no hint', () => eq('qh-plain', B.questionTypeHint('Which planet do we live on'), ''));

// ══════════════════════════════════════════════════════════════════════════════
// buildPrompt — structure + design guardrails
// ══════════════════════════════════════════════════════════════════════════════
group('buildPrompt (multiple choice)');
test('numbers the options from 0', () => {
    var p = B.buildPrompt('Capital of France?', ['London', 'Paris', 'Rome'], false, false, '');
    has('bp-mc1', p, '0) London'); has('bp-mc2', p, '1) Paris'); has('bp-mc3', p, '2) Rome');
});
test('DESIGN: enforces exactly one listed option', () => {
    var p = B.buildPrompt('Q?', ['A', 'B'], false, false, '');
    has('bp-mc-one', p, 'answer_index'); has('bp-mc-pick', p, 'Pick exactly one');
});
test('DESIGN: MC tie-breaker (most specific)', () => {
    has('bp-mc-tie', B.buildPrompt('Q?', ['A', 'B'], false, false, ''), 'MOST specific');
});
test('embeds the type hint', () => {
    has('bp-mc-hint', B.buildPrompt('Which is NOT prime?', ['2', '4', '3'], false, false, ''), 'NEGATION');
});
test('image note only when hasImage', () => {
    var withImg = B.buildPrompt('Guess the flag', ['A', 'B'], true, false, '');
    var noImg = B.buildPrompt('Guess the flag', ['A', 'B'], false, false, '');
    has('bp-img-yes', withImg, 'screenshot'); hasNot('bp-img-no', noImg, 'screenshot');
});
test('nudge note only when provided', () => {
    var withN = B.buildPrompt('Q?', ['A', 'B'], false, false, '90s music');
    has('bp-nudge', withN, '90s music');
    hasNot('bp-nudge-no', B.buildPrompt('Q?', ['A', 'B'], false, false, ''), 'Additional context');
});
test('strict note on retry', () => {
    has('bp-strict', B.buildPrompt('Q?', ['A', 'B'], false, true, ''), 'previous answer was invalid');
});

group('buildPrompt (open-ended)');
test('asks for the answer field, not an index', () => {
    var p = B.buildPrompt('Name a colour', [], false, false, '');
    has('bp-oe1', p, '"answer"'); hasNot('bp-oe2', p, 'answer_index');
    has('bp-oe3', p, '1-3 words');
});

// ══════════════════════════════════════════════════════════════════════════════
// normalizeResult — response parsing
// ══════════════════════════════════════════════════════════════════════════════
group('normalizeResult');
test('parses in-range MC index', () => {
    var r = B.normalizeResult('{"reasoning":"r","answer_index":1,"confidence":0.9}', ['A', 'B', 'C']);
    eq('nr1a', r.answer, 'B'); eq('nr1b', r.answerIndex, 1); ok('nr1c', r.inRange); eq('nr1d', r.confidence, 0.9);
});
test('out-of-range index → inRange false', () => {
    var r = B.normalizeResult('{"answer_index":9,"confidence":0.5}', ['A', 'B']);
    ok('nr2a', !r.inRange); eq('nr2b', r.answer, null); eq('nr2c', r.answerIndex, -1);
});
test('salvages JSON embedded in prose', () => {
    var r = B.normalizeResult('Sure! {"answer_index":0,"confidence":0.7}', ['A', 'B']);
    eq('nr3', r.answerIndex, 0);
});
test('clamps confidence to 0..1', () => {
    eq('nr4a', B.normalizeResult('{"answer_index":0,"confidence":1.5}', ['A', 'B']).confidence, 1);
    eq('nr4b', B.normalizeResult('{"answer_index":0,"confidence":-0.3}', ['A', 'B']).confidence, 0);
});
test('open-ended answer', () => {
    var r = B.normalizeResult('{"answer":"Blue","confidence":0.8}', []);
    eq('nr5a', r.answer, 'Blue'); ok('nr5b', r.inRange); eq('nr5c', r.confidence, 0.8);
});
test('unparseable → parseError', () => {
    ok('nr6', B.normalizeResult('not json at all', ['A']).parseError === true);
});
test('string index coerced', () => {
    eq('nr7', B.normalizeResult('{"answer_index":"2","confidence":0.6}', ['A', 'B', 'C']).answerIndex, 2);
});

// ══════════════════════════════════════════════════════════════════════════════
// schemas + http errors
// ══════════════════════════════════════════════════════════════════════════════
group('schemas');
test('genericSchema MC shape', () => {
    var s = B.genericSchema(3);
    ok('gs1a', !!s.properties.answer_index); eq('gs1b', s.properties.answer_index.type, 'integer');
    ok('gs1c', s.required.indexOf('answer_index') !== -1); ok('gs1d', s.additionalProperties === false);
});
test('genericSchema open shape', () => {
    var s = B.genericSchema(0);
    ok('gs2a', !!s.properties.answer); ok('gs2b', !s.properties.answer_index);
});
test('geminiSchema uppercase + propertyOrdering', () => {
    var s = B.geminiSchema(3);
    eq('gm1a', s.type, 'OBJECT'); eq('gm1b', s.properties.answer_index.type, 'INTEGER');
    ok('gm1c', Array.isArray(s.propertyOrdering) && s.propertyOrdering[0] === 'reasoning');
});

group('httpError / base64');
test('http error mapping', () => {
    eq('he1', B.httpError(401), 'Invalid API key');
    has('he2', B.httpError(403), 'denied');
    has('he3', B.httpError(429), 'Rate limit');
    has('he4', B.httpError(500), 'server');
    eq('he5', B.httpError(418), 'HTTP 418');
});
test('base64 strips data-url prefix', () => eq('b64', B.base64('data:image/jpeg;base64,QUJDRA=='), 'QUJDRA=='));
test('DESIGN: fast/cheap default models (accuracy via prompts, not bigger models)', () => {
    // guards the memory note: providers stay on small/fast tiers
    eq('mdl1', B.MODELS.gemini, 'gemini-2.5-flash');
    eq('mdl2', B.MODELS.mistral, 'mistral-small-latest');
    ok('mdl3', /haiku/.test(B.MODELS.claude));
    ok('mdl4', /mini/.test(B.MODELS.openai));
});

// ── Report ────────────────────────────────────────────────────────────────────
RESULTS.push('\n' + '═'.repeat(50));
RESULTS.push((FAIL === 0 ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED') + '  —  ' + PASS + ' passed, ' + FAIL + ' failed');
$.NSFileHandle.fileHandleWithStandardOutput.writeData(
    $.NSString.alloc.initWithString(RESULTS.join('\n') + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
$.exit(FAIL === 0 ? 0 : 1);
