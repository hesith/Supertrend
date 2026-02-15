export const colorTrend = (trend?: 'up' | 'down') => {
    if (trend === 'up') {
        return `\x1b[32mUP\x1b[0m`;     // green
    }

    if (trend === 'down') {
        return `\x1b[31mDOWN\x1b[0m`;   // red
    }

    return `\x1b[90mUNDEFINED\x1b[0m`; // grey
};

export const getPostionType = (trend?: 'up' | 'down') => {
    if (trend === 'up') {
        return `LONG`;    
    }

    if (trend === 'down') {
        return `SHORT`;   
    }

    return `UNDEFINED`; 
};

export const getPostionSide = (trend?: 'up' | 'down'): 'BUY' | 'SELL' | undefined => {
    if (trend === 'up') {
        return `BUY`;    
    }

    if (trend === 'down') {
        return `SELL`;   
    }

    return undefined; 
};