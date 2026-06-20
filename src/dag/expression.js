// 极简表达式求值器（loop until / 节点 when 条件）。
//
// 支持：字面量 (true/false/null/数字/字符串)、标识符路径 (a.b.c[0])、
// 比较 (==, !=, <, <=, >, >=)、布尔 (&&, ||, !)、括号。
// 不支持函数调用、赋值、属性穿越、JS eval。
//
// 字符串字面量用单/双引号；与模板/JSON 写法兼容。

export class ExpressionError extends Error {
  constructor(message, { source, position } = {}) {
    super(message);
    this.name = 'ExpressionError';
    this.source = source;
    this.position = position;
  }
}

function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '(' || ch === ')') { tokens.push({ type: ch, position: i }); i += 1; continue; }
    if (ch === '!' && source[i + 1] === '=') { tokens.push({ type: '!=', position: i }); i += 2; continue; }
    if (ch === '!') { tokens.push({ type: '!', position: i }); i += 1; continue; }
    if (ch === '=' && source[i + 1] === '=') { tokens.push({ type: '==', position: i }); i += 2; continue; }
    if (ch === '<' && source[i + 1] === '=') { tokens.push({ type: '<=', position: i }); i += 2; continue; }
    if (ch === '>' && source[i + 1] === '=') { tokens.push({ type: '>=', position: i }); i += 2; continue; }
    if (ch === '<') { tokens.push({ type: '<', position: i }); i += 1; continue; }
    if (ch === '>') { tokens.push({ type: '>', position: i }); i += 1; continue; }
    if (ch === '&' && source[i + 1] === '&') { tokens.push({ type: '&&', position: i }); i += 2; continue; }
    if (ch === '|' && source[i + 1] === '|') { tokens.push({ type: '||', position: i }); i += 2; continue; }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== quote) {
        if (source[j] === '\\' && source[j + 1]) { value += source[j + 1]; j += 2; continue; }
        value += source[j];
        j += 1;
      }
      if (j >= source.length) throw new ExpressionError(`Unterminated string starting at ${i}.`, { source, position: i });
      tokens.push({ type: 'string', value, position: i });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(source[i + 1]))) {
      let j = i;
      if (ch === '-') j += 1;
      while (j < source.length && /[0-9.]/.test(source[j])) j += 1;
      const lexeme = source.slice(i, j);
      const num = Number(lexeme);
      if (Number.isNaN(num)) throw new ExpressionError(`Invalid number "${lexeme}" at ${i}.`, { source, position: i });
      tokens.push({ type: 'number', value: num, position: i });
      i = j;
      continue;
    }
    if (/[a-zA-Z_$]/.test(ch)) {
      let j = i;
      while (j < source.length && /[a-zA-Z0-9_$.[\]]/.test(source[j])) j += 1;
      const lexeme = source.slice(i, j);
      if (lexeme === 'true') tokens.push({ type: 'bool', value: true, position: i });
      else if (lexeme === 'false') tokens.push({ type: 'bool', value: false, position: i });
      else if (lexeme === 'null') tokens.push({ type: 'null', value: null, position: i });
      else tokens.push({ type: 'identifier', value: lexeme, position: i });
      i = j;
      continue;
    }
    throw new ExpressionError(`Unexpected character "${ch}" at ${i}.`, { source, position: i });
  }
  return tokens;
}

function parse(source) {
  const tokens = tokenize(source);
  let pos = 0;

  function peek() { return tokens[pos]; }
  function consume(type) {
    const tok = tokens[pos];
    if (!tok || tok.type !== type) {
      throw new ExpressionError(`Expected ${type} at ${tok ? tok.position : 'EOF'}, got ${tok ? tok.type : 'EOF'}.`, { source, position: tok?.position });
    }
    pos += 1;
    return tok;
  }

  // Grammar (precedence low → high):
  //   orExpr := andExpr ( '||' andExpr )*
  //   andExpr := cmpExpr ( '&&' cmpExpr )*
  //   cmpExpr := unary ( ('=='|'!='|'<'|'<='|'>'|'>=') unary )?
  //   unary  := '!' unary | primary
  //   primary := literal | identPath | '(' orExpr ')'

  function parseOr() {
    let left = parseAnd();
    while (peek()?.type === '||') { consume('||'); const right = parseAnd(); left = { type: 'binary', op: '||', left, right }; }
    return left;
  }
  function parseAnd() {
    let left = parseCmp();
    while (peek()?.type === '&&') { consume('&&'); const right = parseCmp(); left = { type: 'binary', op: '&&', left, right }; }
    return left;
  }
  function parseCmp() {
    const left = parseUnary();
    const tok = peek();
    if (tok && ['==', '!=', '<', '<=', '>', '>='].includes(tok.type)) {
      consume(tok.type);
      const right = parseUnary();
      return { type: 'binary', op: tok.type, left, right };
    }
    return left;
  }
  function parseUnary() {
    if (peek()?.type === '!') { consume('!'); return { type: 'unary', op: '!', operand: parseUnary() }; }
    return parsePrimary();
  }
  function parsePrimary() {
    const tok = peek();
    if (!tok) throw new ExpressionError('Unexpected end of expression.', { source });
    if (tok.type === '(') { consume('('); const expr = parseOr(); consume(')'); return expr; }
    if (tok.type === 'bool') { pos += 1; return { type: 'literal', value: tok.value }; }
    if (tok.type === 'null') { pos += 1; return { type: 'literal', value: null }; }
    if (tok.type === 'number') { pos += 1; return { type: 'literal', value: tok.value }; }
    if (tok.type === 'string') { pos += 1; return { type: 'literal', value: tok.value }; }
    if (tok.type === 'identifier') { pos += 1; return { type: 'path', value: tok.value }; }
    throw new ExpressionError(`Unexpected token "${tok.type}" at ${tok.position}.`, { source, position: tok.position });
  }

  const expr = parseOr();
  if (pos < tokens.length) {
    throw new ExpressionError(`Trailing tokens starting at ${tokens[pos].position}.`, { source, position: tokens[pos].position });
  }
  return expr;
}

function resolveIdentifierPath(scope, pathSource) {
  // Reuse the template path parser semantics.
  const segments = pathSource.split('.');
  let current = scope;
  for (const segment of segments) {
    if (current === undefined || current === null) return undefined;
    const match = /^([a-zA-Z_$][a-zA-Z0-9_$]*)((?:\[\d+\])*)$/.exec(segment);
    if (!match) throw new ExpressionError(`Invalid identifier segment "${segment}".`, { source: pathSource });
    const key = match[1];
    if (typeof current !== 'object' || Array.isArray(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
    for (const m of match[2].matchAll(/\[(\d+)\]/g)) {
      const idx = Number(m[1]);
      if (!Array.isArray(current) || idx >= current.length) return undefined;
      current = current[idx];
    }
  }
  return current;
}

function evalNode(node, scope) {
  if (node.type === 'literal') return node.value;
  if (node.type === 'path') return resolveIdentifierPath(scope, node.value);
  if (node.type === 'unary') {
    if (node.op === '!') return !evalNode(node.operand, scope);
  }
  if (node.type === 'binary') {
    if (node.op === '&&') return evalNode(node.left, scope) && evalNode(node.right, scope);
    if (node.op === '||') return evalNode(node.left, scope) || evalNode(node.right, scope);
    const l = evalNode(node.left, scope);
    const r = evalNode(node.right, scope);
    if (node.op === '==') return l === r;
    if (node.op === '!=') return l !== r;
    if (node.op === '<') return l < r;
    if (node.op === '<=') return l <= r;
    if (node.op === '>') return l > r;
    if (node.op === '>=') return l >= r;
  }
  throw new ExpressionError(`Unknown node type ${node.type}.`, { source: '' });
}

export function evalExpression(source, scope) {
  if (typeof source !== 'string' || !source.trim()) return false;
  const ast = parse(source);
  return Boolean(evalNode(ast, scope));
}

export { parse as parseExpression };
