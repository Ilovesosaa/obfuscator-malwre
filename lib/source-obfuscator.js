'use strict';

/* Deep source protection, built on the MIT-licensed `lua-obfuscator` package.
 *
 * Only its source-to-source AST passes are used here. In particular, Vmify is
 * deliberately never selected: a Luau bytecode VM depends on the host
 * executor's compiler/version and is the wrong default for mobile executors.
 *
 * The pass is conservative:
 *   - if the upstream parser does not understand the script, the caller falls
 *     back to Nix6's own scanner-based passes;
 *   - the generated source is parsed once more before it is accepted;
 *   - the random junk/global-mapping passes are omitted because they can
 *     introduce global names that collide with a game or executor.
 */

const { obfuscate, parse } = require('lua-obfuscator');

function upstreamSteps(options) {
    const steps = [];
    if (options.rename) steps.push({ name: 'RenameVariables' });
    if (options.constantArray) steps.push({ name: 'ConstantArray' });
    if (options.encryptStrings) steps.push({ name: 'EncryptStrings' });
    if (options.encodeNumbers) steps.push({ name: 'EncryptNumbers' });
    if (options.wrap) steps.push({ name: 'WrapInFunction' });
    return steps;
}

/* Returns { ok, text, steps, error }. A failure is data, not an exception:
   unsupported Luau syntax must never prevent a user's script from deploying. */
function obfuscateWithUpstream(source, options) {
    const config = options && typeof options === 'object' ? options : {};
    const text = String(source == null ? '' : source);
    if (!text.trim()) return { ok: false, text, steps: [], error: 'empty source' };

    const dialect = config.dialect === 'lua' ? 'lua5.1' : 'luaU';
    const steps = upstreamSteps(config);
    if (steps.length === 0) return { ok: false, text, steps: [], error: 'no passes selected' };

    let output;
    try {
        output = obfuscate(text, dialect, {
            steps,
            minify: Boolean(config.minify)
        });
    } catch (err) {
        return { ok: false, text, steps: [], error: 'parse: ' + (err && err.message ? err.message : String(err)) };
    }

    if (typeof output !== 'string' || !output.trim()) {
        return { ok: false, text, steps: [], error: 'empty output' };
    }

    /* The upstream generator already produces an AST-backed program, but a
       syntax gate here catches an upstream regression before it is wrapped
       and stored in the vault. */
    try {
        parse(output, dialect);
    } catch (err) {
        return { ok: false, text, steps: [], error: 'validation: ' + (err && err.message ? err.message : String(err)) };
    }

    return {
        ok: true,
        text: output,
        steps: steps.map((step) => step.name),
        error: null
    };
}

module.exports = {
    obfuscateWithUpstream,
    upstreamSteps
};
