export const stripHtmlTags = (str) => {
    const regex = /(<([^>]+)>)/gi;
    return str.replace(regex, '');
}

export const isEmpty = (value) => {
    return (
        value === undefined ||
        value === null ||
        value === '' ||
        (Array.isArray(value) && value.length === 0)
    );
}