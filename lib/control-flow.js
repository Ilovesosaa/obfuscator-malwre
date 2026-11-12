'use strict';

/* Control-flow flattening for Lua/Luau source.

   Luau bytecode alone is reversible: a decompiler can recover a recognizable
   CFG. This pass runs before compilation and turns each eligible function body
   into a random state machine:

       local state = 918273
       while true do
           if state == 918273 then
               -- original statement
               state = 44219
           elseif state == 44219 then
               ...
           else
               break
           end
       end

   The case order, state values and number of decoy states are fresh for every
   build. Direct locals are hoisted only when that cannot change their scope:
   a parameter collision, a duplicate declaration, or a use before the
   declaration makes the function ineligible. Bodies with goto/labels or a
   top-level break/continue are also left alone.

   The Luau AST binary is used only to get reliable statement boundaries and
   local declarations. If it is unavailable the pass is a no-op rather than
   guessing at the grammar. */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const MAX_FUNCTIONS = 80;
const MAX_BLOCKS = 2400;
let warningShown = false;

function astCandidates() {
    const candidates = [];
    if (process.env.LUAU_AST_BIN) candidates.push(process.env.LUAU_AST_BIN);
    candidates.push(path.join(__dirname, '..', 'bin', 'luau-ast'));
    candidates.push(path.join(__dirname, '..', '.tools', 'luau-ast'));
    return candidates;
}

function findAstBinary() {
    for (const candidate of astCandidates()) {
        try {
            if (fs.statSync(candidate).isFile()) return candidate;
        } catch (err) {}
    }
    return null;
}

function executableAstPath(binary) {
    try {
        fs.accessSync(binary, fs.constants.X_OK);
        return binary;
    } catch (err) {}
    try {
        const copied = path.join(os.tmpdir(), 'nix6-luau-ast');
        if (!fs.existsSync(copied)) fs.copyFileSync(binary, copied);
        fs.chmodSync(copied, 0o755);
        return copied;
    } catch (err) {
        return null;
    }
}

function parseAst(source) {
    const binary = findAstBinary();
    if (!binary) return null;
    const executable = executableAstPath(binary);
    if (!executable) return null;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nix6-cff-'));
    const file = path.join(dir, 'chunk.luau');
    try {
        fs.writeFileSync(file, source, 'utf8');
        const output = execFileSync(executable, [file], {
            timeout: 15000,
            maxBuffer: 64 * 1024 * 1024,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe']
        });
        return JSON.parse(output);
    } catch (err) {
        if (!warningShown) {
            warningShown = true;
            console.warn('[cff] Luau AST pass unavailable: ' + err.message);
        }
        return null;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/* AST columns are UTF-8 byte offsets, not JavaScript UTF-16 offsets. Build a
   byte -> character map once so emoji/CJK before a function cannot shift every
   body range. */
function makeOffsetMapper(source) {
    const bytes = Buffer.from(source, 'utf8');
    const byteToChar = new Uint32Array(bytes.length + 1);
    let byte = 0;
    let char = 0;
    while (byte < bytes.length) {
        const first = bytes[byte];
        let width = 1;
        if (first >= 0xF0) width = 4;
        else if (first >= 0xE0) width = 3;
        else if (first >= 0xC0) width = 2;
        for (let i = 0; i < width && byte + i < bytes.length; i++) {
            byteToChar[byte + i] = char;
        }
        byte += width;
        /* JavaScript string indices count UTF-16 units: an astral character
           costs two, not one. The byte map must match slice() exactly. */
        char += width === 4 ? 2 : 1;
    }
    byteToChar[bytes.length] = char;

    const lineStarts = [0];
    for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === 10) lineStarts.push(i + 1);
    }

    return (line, column) => {
        if (!Number.isInteger(line) || !Number.isInteger(column) || line < 0) return -1;
        const start = lineStarts[line];
        if (start === undefined) return -1;
        const absolute = start + column;
        if (absolute < 0 || absolute >= byteToChar.length) return -1;
        return byteToChar[absolute];
    };
}

function parseLocation(location) {
    const match = /^(\d+),(\d+)\s*-\s*(\d+),(\d+)$/.exec(String(location || ''));
    if (!match) return null;
    return {
        startLine: Number(match[1]),
        startColumn: Number(match[2]),
        endLine: Number(match[3]),
        endColumn: Number(match[4])
    };
}

function sourceRange(location, toOffset) {
    const parsed = parseLocation(location);
    if (!parsed) return null;
    const start = toOffset(parsed.startLine, parsed.startColumn);
    const end = toOffset(parsed.endLine, parsed.endColumn);
    if (start < 0 || end < start) return null;
    return { start, end };
}

function collectFunctions(ast, toOffset) {
    const functions = [];

    const visit = (node, parent, depth) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
            for (const item of node) visit(item, parent, depth);
            return;
        }

        if (node.type === 'AstExprFunction' && node.body) {
            const range = sourceRange(node.body.location, toOffset);
            if (range && range.end >= range.start) {
                const fn = {
                    body: node.body,
                    start: range.start,
                    end: range.end,
                    args: Array.isArray(node.args) ? node.args : [],
                    depth,
                    parent: parent || null,
                    children: [],
                    replacement: null
                };
                if (parent) parent.children.push(fn);
                functions.push(fn);
                visit(node.body, fn, depth + 1);
            }
            return;
        }

        for (const [key, value] of Object.entries(node)) {
            if (key === 'location') continue;
            visit(value, parent, depth);
        }
    };

    if (ast && ast.root) visit(ast.root, null, 0);
    return functions;
}

function renderRange(source, start, end, edits) {
    if (!edits || edits.length === 0) return source.slice(start, end);
    const sorted = edits
        .filter((edit) => edit.start >= start && edit.end <= end)
        .sort((a, b) => a.start - b.start);
    let out = '';
    let cursor = start;
    for (const edit of sorted) {
        if (edit.start < cursor) continue;
        out += source.slice(cursor, edit.start) + edit.replacement;
        cursor = edit.end;
    }
    return out + source.slice(cursor, end);
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasWord(text, word) {
    return new RegExp('\\b' + escapeRegex(word) + '\\b').test(text);
}

function randomIdentifier(source, used) {
    for (;;) {
        const name = '_' + crypto.randomBytes(6).toString('hex');
        if (used.has(name)) continue;
        if (hasWord(source, name)) continue;
        used.add(name);
        return name;
    }
}

function randomState(used) {
    for (;;) {
        const value = crypto.randomInt(0x10000, 0x7fffffff);
        if (!used.has(value)) {
            used.add(value);
            return value;
        }
    }
}

function shuffled(values) {
    const copy = values.slice();
    for (let i = copy.length - 1; i > 0; i--) {
        const j = crypto.randomInt(0, i + 1);
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

/* Return a flattened body replacement, or null when this function cannot be
   transformed without changing scope or control flow. */
function flattenFunction(source, toOffset, fn, childEdits, usedNames) {
    const bodyText = source.slice(fn.start, fn.end);
    if (!bodyText.trim()) return null;
    if (/\bgoto\b|::\s*[A-Za-z_][A-Za-z0-9_]*\s*::/.test(bodyText)) return null;

    const statements = Array.isArray(fn.body.body) ? fn.body.body : [];
    if (statements.length === 0) return null;

    const paramNames = new Set(fn.args.map((arg) => arg && arg.name).filter(Boolean));
    const hoisted = [];
    const hoistedSet = new Set();
    const prepared = [];

    for (const statement of statements) {
        if (!statement || statement.type === 'AstStatBreak' || statement.type === 'AstStatContinue') {
            return null;
        }
        const range = sourceRange(statement.location, toOffset);
        if (!range) return null;

        const directChildren = childEdits.filter((edit) => edit.start >= range.start && edit.end <= range.end);
        const originalText = renderRange(source, range.start, range.end, directChildren).trim();
        if (!originalText) continue;

        if (statement.type === 'AstStatLocal' && Array.isArray(statement.vars)) {
            const names = statement.vars.map((variable) => variable && variable.name).filter(Boolean);
            if (names.length === 0) return null;
            for (const name of names) {
                if (hoistedSet.has(name) || paramNames.has(name)) return null;
                hoistedSet.add(name);
                hoisted.push(name);
            }
            const values = Array.isArray(statement.values) ? statement.values : [];
            if (values.length === 0) {
                /* Keep a record of the declaration so the use-before check can
                   see it, but it produces no dispatcher block. */
                prepared.push({
                    type: statement.type,
                    text: null,
                    raw: originalText,
                    declared: names
                });
                continue;
            }
            const first = sourceRange(values[0].location, toOffset);
            const last = sourceRange(values[values.length - 1].location, toOffset);
            if (!first || !last) return null;
            const valueText = renderRange(source, first.start, last.end, directChildren).trim();
            if (!valueText) return null;
            for (const name of names) {
                if (hasWord(valueText, name)) return null;
            }
            prepared.push({
                type: statement.type,
                text: names.join(', ') + ' = ' + valueText,
                raw: originalText,
                declared: names
            });
            continue;
        }

        if (statement.type === 'AstStatLocalFunction' && statement.name && statement.name.name) {
            const name = statement.name.name;
            if (hoistedSet.has(name) || paramNames.has(name)) return null;
            const funcRange = sourceRange(statement.func.location, toOffset);
            if (!funcRange) return null;
            const functionAt = source.indexOf('function', funcRange.start);
            if (functionAt < 0 || functionAt > funcRange.end) return null;
            /* `local function f(...)` is a declaration, but the assignment
               form needs an anonymous function expression: function(...). */
            const openParen = source.indexOf('(', functionAt + 'function'.length);
            if (openParen < 0 || openParen > funcRange.end) return null;
            const functionText = 'function' +
                renderRange(source, openParen, funcRange.end, directChildren).trim();
            if (!functionText) return null;
            hoistedSet.add(name);
            hoisted.push(name);
            prepared.push({
                type: statement.type,
                text: name + ' = ' + functionText,
                raw: originalText,
                declared: [name]
            });
            continue;
        }

        prepared.push({ type: statement.type, text: originalText, raw: originalText, declared: [] });
    }

    const emitted = prepared.filter((item) => item.text);
    /* A body whose only statement is `local x` still gets a dispatcher; the
       declaration has already been hoisted, so the state case is a no-op. */
    if (emitted.length === 0) {
        emitted.push({ type: 'AstStatLocal', text: '', raw: '', declared: [] });
    }

    /* A declaration's scope starts at the declaration. Hoisting it is only
       safe when the name was not already referenced earlier in the body. */
    let preceding = '';
    for (const item of prepared) {
        if (item.type !== 'AstStatLocal' && item.type !== 'AstStatLocalFunction') {
            preceding += '\n' + item.raw;
            continue;
        }
        for (const name of item.declared) {
            if (hasWord(preceding, name)) return null;
        }
        preceding += '\n' + item.raw;
    }

    const stateName = randomIdentifier(source, usedNames);
    const stateValues = new Set();
    const real = emitted.map((item) => ({
        ...item,
        id: randomState(stateValues)
    }));
    const doneId = randomState(stateValues);
    const decoyId = randomState(stateValues);
    const entryId = real[0].id;

    const ordered = shuffled(real.map((_, index) => index));
    const lines = [];
    if (hoisted.length > 0) lines.push('local ' + hoisted.join(', '));
    lines.push('local ' + stateName + ' = ' + entryId);
    lines.push('while true do');

    ordered.forEach((index, position) => {
        const item = real[index];
        const header = position === 0 ? 'if' : 'elseif';
        lines.push(header + ' ' + stateName + ' == ' + item.id + ' then');
        lines.push(item.text);
        if (item.type !== 'AstStatReturn') {
            const nextId = index + 1 < real.length ? real[index + 1].id : doneId;
            lines.push(stateName + ' = ' + nextId);
        }
    });

    /* A state that is never produced by real code. It keeps the dispatcher
       from being just a chain of reachable constants. */
    lines.push('elseif ' + stateName + ' == ' + decoyId + ' then');
    lines.push(stateName + ' = ' + doneId);
    lines.push('else');
    lines.push('break');
    lines.push('end');
    lines.push('end');

    return {
        replacement: '\n' + lines.join('\n') + '\n',
        blocks: real.length
    };
}

function controlFlowFlatten(source) {
    const text = String(source == null ? '' : source);
    if (!text.trim()) {
        return { text, functions: 0, blocks: 0, skipped: 0, available: false };
    }

    const ast = parseAst(text);
    if (!ast) {
        return { text, functions: 0, blocks: 0, skipped: 0, available: false };
    }

    const toOffset = makeOffsetMapper(text);
    const functions = collectFunctions(ast, toOffset);

    /* Treat the chunk itself as a body too. That flattens top-level code
       without wrapping it in a function, so getfenv, varargs and top-level
       return keep their original meaning. The wrapper is inserted at the
       first real statement, leaving --! directives and a shebang in place. */
    const rootStatements = ast.root && Array.isArray(ast.root.body) ? ast.root.body : [];
    let rootNode = null;
    if (rootStatements.length > 0) {
        const first = sourceRange(rootStatements[0].location, toOffset);
        if (first) {
            for (const fn of functions) fn.depth += 1;
            rootNode = {
                body: ast.root,
                start: first.start,
                end: text.length,
                args: [],
                depth: 0,
                parent: null,
                children: [],
                replacement: null,
                isRoot: true
            };
            for (const fn of functions) {
                if (!fn.parent) {
                    fn.parent = rootNode;
                    rootNode.children.push(fn);
                }
            }
            functions.push(rootNode);
        }
    }

    if (functions.length === 0) {
        return { text, functions: 0, blocks: 0, skipped: 0, available: true };
    }

    const usedNames = new Set((text.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []));
    const selected = functions
        .filter((fn) => fn.end > fn.start)
        .sort((a, b) => b.depth - a.depth || a.start - b.start)
        .slice(0, MAX_FUNCTIONS);

    let blocks = 0;
    let flattened = 0;
    let skipped = functions.length - selected.length;
    for (const fn of selected) {
        if (blocks >= MAX_BLOCKS) {
            skipped++;
            continue;
        }
        const childEdits = fn.children
            .filter((child) => child.replacement)
            .map((child) => ({ start: child.start, end: child.end, replacement: child.replacement }));
        const result = flattenFunction(text, toOffset, fn, childEdits, usedNames);
        if (!result) {
            skipped++;
            if (childEdits.length > 0) {
                fn.replacement = renderRange(text, fn.start, fn.end, childEdits);
            }
            continue;
        }
        fn.replacement = result.replacement;
        blocks += result.blocks;
        flattened++;
    }

    const roots = functions.filter((fn) => !fn.parent && fn.replacement);
    if (roots.length === 0) {
        return { text, functions: 0, blocks: 0, skipped, available: true };
    }

    /* Parents are generated from the original source plus their direct child
       body edits, so nested functions keep their own flattened bodies. */
    const edits = roots
        .map((fn) => ({ start: fn.start, end: fn.end, replacement: fn.replacement }))
        .sort((a, b) => a.start - b.start);
    let out = '';
    let cursor = 0;
    for (const edit of edits) {
        if (edit.start < cursor) continue;
        out += text.slice(cursor, edit.start) + edit.replacement;
        cursor = edit.end;
    }
    out += text.slice(cursor);

    /* Never ship a flattening that the Luau parser rejects. This is a final
       syntax gate for constructs the statement walker does not understand. */
    if (out !== text && !parseAst(out)) {
        return { text, functions: 0, blocks: 0, skipped, available: true };
    }

    return {
        text: out,
        functions: flattened,
        blocks,
        skipped,
        available: true
    };
}

module.exports = {
    controlFlowFlatten,
    parseAst,
    findAstBinary
};
