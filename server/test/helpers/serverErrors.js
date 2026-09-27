// Makes a console.error from application code fail the test that caused it.
//
// Why this exists: Jest fails a test on a failed assertion, a throw inside the
// test body, or an *unhandled* rejection — and nothing else. Every
// fire-and-forget path in the server (hub.js's abandon/applyMove/resign calls,
// GameManager's evaluatePly and feedbackRepo.insert) ends in
// `.catch(console.error)`, which makes the rejection *handled*. So a real
// application failure could log a stack trace and the run would still report
// "118 passed". That is how the abandon-on-disconnect race stayed green for as
// long as it did.
//
// This gate closes that hole: any console.error is recorded, and unless the
// test that caused it declared it with expectServerError(), the test fails.
//
// It suppresses nothing — every recorded message is still printed.
const util = require('util');

// Every console.error made during this file's run, formatted the way the
// terminal shows it. Recording starts at module load rather than in a
// beforeEach, deliberately: the disconnect/abandon failures land in a suite's
// *afterAll*, where no beforeEach has run and no afterEach will follow, so a
// hook-scoped recorder would miss exactly the class of error this was built for.
const captured = [];

// Patterns the *current test* declared. Reset between tests, so one test's
// allowance can never silently cover another's error.
let declared = [];

const realConsoleError = console.error;

console.error = (...args) => {
    captured.push(util.format(...args));
    // Still printed. This gate adds a failure; it never removes output.
    realConsoleError(...args);
};

// Declares that this test intentionally causes one server-side error.
//
// This is an assertion, not a mute switch, and it works in both directions: an
// undeclared error fails the test, and a declaration that never matches fails it
// too. So declaring `game.move illegal:` additionally asserts that the server
// really did log its refusal — strictly more than the test checked before.
//
// Call it inside the test body. `pattern` is a RegExp or a substring.
function expectServerError(pattern) {
    declared.push(pattern);
}

function matches(pattern, message) {
    if (typeof pattern === 'string') return message.includes(pattern);
    // A /g/ or /y/ regex carries lastIndex between .test() calls and would start
    // missing matches on the second message, so test against a fresh copy.
    return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '')).test(message);
}

function describePattern(pattern) {
    return typeof pattern === 'string' ? JSON.stringify(pattern) : String(pattern);
}

function indent(text) {
    return String(text)
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n');
}

// Drains what was captured and compares it against what was declared. Called
// once per test and once more for the teardown window.
function check(where) {
    // splice, so each message is judged exactly once: an error logged during a
    // test must not fail the afterAll as well.
    const messages = captured.splice(0);
    const patterns = declared;

    const undeclared = messages.filter((m) => !patterns.some((p) => matches(p, m)));
    const unseen = patterns.filter((p) => !messages.some((m) => matches(p, m)));
    if (undeclared.length === 0 && unseen.length === 0) return;

    const lines = [];
    if (undeclared.length > 0) {
        lines.push(`Unexpected server error logged during ${where} (${undeclared.length}):`);
        for (const message of undeclared) lines.push(indent(message));
        lines.push(
            'The application logged an error that no test declared. Either the code under',
            'test genuinely failed, or — if this test causes it deliberately — declare it',
            'with expectServerError(/pattern/) inside that test.'
        );
    }
    if (unseen.length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push(`Declared server error never occurred during ${where} (${unseen.length}):`);
        for (const pattern of unseen) lines.push(indent(describePattern(pattern)));
        lines.push(
            'expectServerError() asserts that the error happens. If the server should no',
            'longer log it, remove the declaration.'
        );
    }
    throw new Error(lines.join('\n'));
}

// Registered at the root, so these run outside every describe in the file: this
// beforeEach runs first, and this afterEach/afterAll run last — after a suite's
// own afterAll, which is where the teardown-window errors appear.
beforeEach(() => {
    declared = [];
});

afterEach(() => {
    check('this test');
});

afterAll(() => {
    // Cleared first: a declaration belongs to the test that made it and must not
    // excuse anything logged during teardown.
    declared = [];
    check("this file's teardown");
});

// Known blind spot, accepted deliberately: a test that installs its own
// `jest.spyOn(console, 'error')` replaces the recorder above for its duration,
// so the gate sees nothing while that spy is in place. The four tests that do
// this (evaluation.test.js:317 and :423, gameManager.test.js:215,
// moves.test.js:301) all assert on the spy themselves — with exact call counts,
// or with an explicit `not.toHaveBeenCalledWith` — which is stricter than this
// gate would be. Rewriting them to use expectServerError would mean replacing
// working assertions with weaker ones, so they are left as they are.
module.exports = { expectServerError };
