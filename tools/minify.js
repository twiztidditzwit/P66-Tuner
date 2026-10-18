#!/usr/bin/env node
/* Conservative JS minifier for the p66-tuner package step.
 *
 * No terser/uglify is vendored and the build must run offline, so this
 * ships its own minifier. It is deliberately conservative: it strips
 * comments and collapses whitespace ONLY — no identifier renaming, no
 * statement rewriting, no dead-code elimination. Newlines are preserved
 * (collapsed to one) so ASI behavior can never change.
 *
 * Safety design:
 *  - Strings, template literals (with ${} nesting), and regex literals
 *    are tokenized and copied verbatim; comments inside them are kept.
 *  - Regex-vs-division is decided from the previous significant token,
 *    with an expression-keyword allowlist (return /re/, typeof /re/, ...).
 *  - A separator is kept between two tokens only when dropping it would
 *    merge them: word-word (a b), +/- runs (a + ++b), and number-dot
 *    (1 .toString()).
 *  - Every minified file is run through `node --check` by package-zip.js,
 *    and tools/minify-test.js differentially checks behavior on samples.
 *
 * Usage: node tools/minify-test.js   (tests)
 *        require('./minify.js').minifyString(src) -> { code: <string> }
 */
'use strict';

var WORD_START = /[A-Za-z_$]/;
var WORD_CHAR = /[A-Za-z0-9_$]/;

// Keywords after which a `/` starts a regex, not a division.
var REGEX_AFTER_KEYWORD = {
  'return': 1, 'typeof': 1, 'instanceof': 1, 'in': 1, 'of': 1,
  'new': 1, 'delete': 1, 'void': 1, 'throw': 1, 'case': 1,
  'do': 1, 'else': 1, 'yield': 1, 'await': 1
};

// Multi-char operators, longest first (greedy match).
var OPERATORS = [
  '>>>=', '===', '!==', '...', '**=', '>>=', '<<=', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '++', '--', '<<', '>>', '**', '&&',
  '||', '??', '+=', '-=', '*=', '%=', '&=', '|=', '^=', '?.'
];

function isWordStart(ch) { return !!ch && WORD_START.test(ch); }
function isWordChar(ch) { return !!ch && WORD_CHAR.test(ch); }
function isDigit(ch) { return ch >= '0' && ch <= '9'; }
function isWs(ch) {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\v' || ch === '\f';
}

function matchOperator(src, i) {
  for (var k = 0; k < OPERATORS.length; k++) {
    var op = OPERATORS[k];
    if (src.substr(i, op.length) === op) return op;
  }
  return src[i];
}

function minifyString(src) {
  var out = [];
  var i = 0, n = src.length;
  var pendingNl = false; // a whitespace/comment gap is pending; had a newline?
  var prev = null;       // last emitted token text
  var prevKind = null;   // 'word' | 'num' | 'str' | 'op'
  var regexAllowed = true;
  var stack = [];        // brace/template nesting: 'tpl' marks template text

  function inTemplate() { return stack.length > 0 && stack[stack.length - 1] === 'tpl'; }

  function needsSpace(next) {
    if (prev === null) return false;
    var pLast = prev[prev.length - 1];
    var nFirst = next[0];
    if (isWordChar(pLast) && isWordChar(nFirst)) return true; // a b, return x
    if ((pLast === '+' || pLast === '-') &&
        (nFirst === '+' || nFirst === '-')) return true;      // a + ++b
    if (prevKind === 'num' && nFirst === '.') return true;    // 1 .toString()
    return false;
  }

  function emit(tok, kind) {
    if (needsSpace(tok)) out.push(pendingNl ? '\n' : ' ');
    out.push(tok);
    pendingNl = false;
    prev = tok;
    prevKind = kind;
    if (kind === 'word') {
      regexAllowed = !!REGEX_AFTER_KEYWORD[tok];
    } else if (kind === 'num' || kind === 'str') {
      regexAllowed = false; // operand-ish: `/` after it is division
    } else {
      // Operators/openers leave regex allowed, except operand-ish closers.
      // `}` stays regex-allowed (covers `{} /re/` blocks); `{...} / 2`
      // object-division is vanishingly rare and fails loudly at --check.
      regexAllowed = (tok !== ')' && tok !== ']' && tok !== '++' && tok !== '--');
    }
  }

  // Copy a quoted string verbatim (backslash escapes, incl. line
  // continuations, are preserved).
  function copyString(quote) {
    var start = i;
    i++; // opening quote
    while (i < n) {
      var c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === quote) { i++; break; }
      i++;
    }
    return src.slice(start, i);
  }

  // Copy a regex literal verbatim: opening `/` to the first unescaped `/`
  // outside a [...] class, plus trailing flags.
  function copyRegex() {
    var start = i;
    i++; // opening slash
    var inClass = false;
    while (i < n) {
      var c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '[') { inClass = true; i++; continue; }
      if (c === ']' && inClass) { inClass = false; i++; continue; }
      if (c === '/' && !inClass) { i++; break; }
      if (c === '\n') break; // unterminated — bail; node --check will flag it
      i++;
    }
    while (i < n && isWordChar(src[i])) i++; // flags
    return src.slice(start, i);
  }

  // Shebang: preserve verbatim (tools/* have one; js/* do not).
  if (src[0] === '#' && src[1] === '!') {
    var eol = src.indexOf('\n');
    if (eol < 0) eol = n;
    out.push(src.slice(0, eol + 1));
    i = eol + 1;
  }

  while (i < n) {
    var ch = src[i];

    // ---- inside template literal text: copy verbatim until ` or ${ ----
    if (inTemplate()) {
      var tStart = i;
      var closed = false;
      var interp = false;
      while (i < n) {
        var tc = src[i];
        if (tc === '\\') { i += 2; continue; }
        if (tc === '`') { i++; closed = true; break; }
        if (tc === '$' && src[i + 1] === '{') { interp = true; break; }
        i++;
      }
      if (i > tStart) {
        out.push(src.slice(tStart, i)); // verbatim: no separators inside
        prev = src.slice(tStart, i);
        prevKind = 'str';
        regexAllowed = false;
      }
      if (closed) { stack.pop(); continue; }
      if (interp) {
        out.push('${'); // verbatim boundary: never spaced
        i += 2;
        stack.push('{');
        prev = '${';
        prevKind = 'op';
        regexAllowed = true;
        continue;
      }
      continue;
    }

    if (isWs(ch)) {
      var sawNl = false;
      while (i < n && isWs(src[i])) {
        if (src[i] === '\n') sawNl = true;
        i++;
      }
      pendingNl = pendingNl || sawNl;
      continue;
    }

    // ---- comments, regex, division ----
    if (ch === '/') {
      var nx = src[i + 1];
      if (nx === '/') {
        while (i < n && src[i] !== '\n') i++;
        pendingNl = true;
        continue;
      }
      if (nx === '*') {
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
          if (src[i] === '\n') pendingNl = true;
          i++;
        }
        i += 2; // past */
        // A block comment is exactly equivalent to whitespace: it can only
        // ever separate tokens that whitespace could separate, so folding
        // it into the pending gap is always safe.
        continue;
      }
      if (nx === '=') { emit('/=', 'op'); i += 2; continue; }
      if (regexAllowed) { emit(copyRegex(), 'str'); continue; }
      emit('/', 'op');
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") { emit(copyString(ch), 'str'); continue; }

    if (ch === '`') {
      emit('`', 'str');
      i++;
      stack.push('tpl');
      regexAllowed = false;
      continue;
    }

    if (ch === '{') { stack.push('{'); emit('{', 'op'); i++; continue; }
    if (ch === '}') { stack.pop(); emit('}', 'op'); i++; continue; }

    if (isWordStart(ch)) {
      var wStart = i;
      while (i < n && isWordChar(src[i])) i++;
      emit(src.slice(wStart, i), 'word');
      continue;
    }

    if (isDigit(ch) || (ch === '.' && isDigit(src[i + 1]))) {
      var numStart = i;
      if (ch === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        i += 2;
        while (i < n && /[0-9a-fA-F_]/.test(src[i])) i++;
      } else if (ch === '0' && (src[i + 1] === 'b' || src[i + 1] === 'B')) {
        i += 2;
        while (i < n && /[01_]/.test(src[i])) i++;
      } else if (ch === '0' && (src[i + 1] === 'o' || src[i + 1] === 'O')) {
        i += 2;
        while (i < n && /[0-7_]/.test(src[i])) i++;
      } else {
        while (i < n && /[0-9_]/.test(src[i])) i++;
        if (src[i] === '.' && /[0-9_]/.test(src[i + 1] || '')) {
          i++;
          while (i < n && /[0-9_]/.test(src[i])) i++;
        }
        if (src[i] === 'e' || src[i] === 'E') {
          var ePos = i;
          i++;
          if (src[i] === '+' || src[i] === '-') i++;
          if (isDigit(src[i])) {
            while (i < n && /[0-9_]/.test(src[i])) i++;
          } else {
            i = ePos; // not a real exponent; leave the `e` for the word lexer
          }
        }
      }
      if (src[i] === 'n') i++; // BigInt suffix
      emit(src.slice(numStart, i), 'num');
      continue;
    }

    var op = matchOperator(src, i);
    emit(op, 'op');
    i += op.length;
  }

  return { code: out.join('') };
}

module.exports = { minifyString: minifyString };

// CLI hook: `node tools/minify.js <file>` prints minified source.
if (require.main === module) {
  var fs = require('fs');
  var f = process.argv[2];
  if (!f) { console.error('usage: node tools/minify.js <file.js>'); process.exit(2); }
  process.stdout.write(minifyString(fs.readFileSync(f, 'utf8')).code);
}
