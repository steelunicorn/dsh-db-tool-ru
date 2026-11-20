export class DbToolError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'DbToolError';
    }
}
