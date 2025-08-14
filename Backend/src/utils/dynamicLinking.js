function trimAndUnwrapQuotes(str) {
    return str.trim().replace(/^(['"])(.+)\1$/, '$2')
}

function tokenizeString(str) {
    let tokens = [];
    let currentToken = '';
    let isInQuotes = false;
    let quoteChar = '';

    for (let i = 0; i < str.length; i++) {
        const char = str[i];

        // Check for quote start/end
        if ((char === '"' || char === "'") && !isInQuotes) {
            isInQuotes = true;
            quoteChar = char;
        } else if (char === quoteChar && isInQuotes) {
            isInQuotes = false;
            quoteChar = '';
        }

        // If not in quotes and '>' is found, push the current token and reset it
        if (char === '>' && !isInQuotes) {
            tokens.push(trimAndUnwrapQuotes(currentToken.trim()));
            currentToken = '';
        } else {
            currentToken += char;
        }
    }

    // Add the last token if there's any residue
    if (currentToken) {
        tokens.push(trimAndUnwrapQuotes(currentToken));
    }
    if (tokens.length !== 3) {
        console.warn('Not enough tokens, expected 3', tokens);
    }

    return tokens;
}

export { tokenizeString, trimAndUnwrapQuotes };
