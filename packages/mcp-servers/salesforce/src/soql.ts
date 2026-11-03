/** Deliberately small SOQL grammar. No relationships, subqueries, functions, aliases or locks.
 * Parsing the entire input is essential: checking only the first FROM is not authorization. */
export function assertAllowedSoql(query: string, allowed: readonly string[]): void {
    const tokens: string[] = [];
    const lexer = /\s+|[A-Za-z_][A-Za-z0-9_]*|'(?:[^'\\\r\n]|\\['\\])*'|(?:0|[1-9][0-9]*)(?:\.[0-9]+)?|!=|<>|<=|>=|[=<>,-]/gy;
    let offset = 0;
    while (offset < query.length) {
        lexer.lastIndex = offset;
        const match = lexer.exec(query);
        if (!match)
            throw Error('QUERY_DENIED');
        offset = lexer.lastIndex;
        if (!/^\s/.test(match[0]))
            tokens.push(match[0]);
    }
    let cursor = 0;
    const peek = () => tokens[cursor]?.toUpperCase();
    function take(word: string) {
        if (peek() !== word)
            throw Error('QUERY_DENIED');
        cursor++;
    }
    const reserved = new Set(['SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'ORDER', 'BY', 'LIMIT', 'OFFSET', 'FOR', 'UPDATE', 'TYPEOF', 'WITH', 'GROUP', 'HAVING', 'NULL', 'TRUE', 'FALSE']);
    function identifier() {
        const value = tokens[cursor++];
        if (!value || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value) || reserved.has(value.toUpperCase()))
            throw Error('QUERY_DENIED');
        return value;
    }
    take('SELECT');
    identifier();
    while (peek() === ',') {
        cursor++;
        identifier();
    }
    take('FROM');
    const object = identifier();
    if (!allowed.some(name => name.toLowerCase() === object.toLowerCase()))
        throw Error('QUERY_DENIED');
    if (peek() === 'WHERE') {
        cursor++;
        for (;;) {
            identifier();
            if (!['=', '!=', '<>', '<', '>', '<=', '>='].includes(tokens[cursor++] ?? ''))
                throw Error('QUERY_DENIED');
            const negative = peek() === '-';
            if (negative)
                cursor++;
            const value = tokens[cursor++];
            if (!value || !(/^(?:'(?:[^'\\\r\n]|\\['\\])*'|[0-9]+(?:\.[0-9]+)?|NULL|TRUE|FALSE)$/i.test(value)))
                throw Error('QUERY_DENIED');
            if (negative && !/^[0-9]+(?:\.[0-9]+)?$/.test(value))
                throw Error('QUERY_DENIED');
            if (peek() !== 'AND' && peek() !== 'OR')
                break;
            cursor++;
        }
    }
    if (peek() === 'ORDER') {
        cursor++;
        take('BY');
        for (;;) {
            identifier();
            if (peek() === 'ASC' || peek() === 'DESC')
                cursor++;
            if (peek() !== ',')
                break;
            cursor++;
        }
    }
    if (peek() === 'LIMIT') {
        cursor++;
        const n = tokens[cursor++];
        if (!n || !/^[1-9][0-9]{0,4}$/.test(n) || Number(n) > 10000)
            throw Error('QUERY_DENIED');
    }
    if (cursor !== tokens.length)
        throw Error('QUERY_DENIED');
}
